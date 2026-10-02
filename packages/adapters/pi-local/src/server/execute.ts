import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesManagedHome,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetFile,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  adapterExecutionTargetDuplexObservabilityRecorder,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  resolveLegacyPaperclipDesiredSkillNames,
  removeMaintainerOnlySkillSymlinks,
  renderTemplate,
  renderPaperclipWakePrompt,
  selectPaperclipTaskMarkdown,
  selectInitialCommunicationGuidance,
  isPaperclipRecoveryWakePayload,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  runChildProcess,
  sanitizeInheritedPaperclipEnv,
} from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import { classifyPiProviderFailure, isPiUnknownSessionError, parsePiJsonl } from "./parse.js";
import { compactPiRunLogLine } from "./log-compaction.js";
import { ensurePiModelConfiguredAndAvailable } from "./models.js";
import {
  createPiModelCooldownStore,
  earliestPiChainRecovery,
  planPiModelAttempts,
  resolvePiModelChain,
  type PiModelCooldown,
} from "./model-fallback.js";
import { preparePiRuntimeConfig } from "./runtime-config.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

const PAPERCLIP_SESSIONS_DIR = path.join(os.homedir(), ".pi", "paperclips");
const PI_AGENT_SKILLS_DIR = path.join(os.homedir(), ".pi", "agent", "skills");

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function parseModelId(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return trimmed || null;
  return trimmed.slice(trimmed.indexOf("/") + 1).trim() || null;
}

const PI_TOOL_EXECUTION_START_RE = /^\{\s*"type"\s*:\s*"tool_execution_start"/;
const PI_MODEL_UNAVAILABLE_PREFIX = "Configured Pi model is unavailable:";

function formatCooldownUntil(cooldown: PiModelCooldown): string {
  return `${cooldown.kind === "hard" ? "quota" : "transient"} cooldown until ${cooldown.until}`;
}

async function ensurePiSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
) {
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (selectedEntries.length === 0) return;
  await fs.mkdir(PI_AGENT_SKILLS_DIR, { recursive: true });
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    PI_AGENT_SKILLS_DIR,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only Pi skill "${skillName}" from ${PI_AGENT_SKILLS_DIR}\n`,
    );
  }

  for (const entry of selectedEntries) {
    const target = path.join(PI_AGENT_SKILLS_DIR, entry.runtimeName);

    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} Pi skill "${entry.runtimeName}" into ${PI_AGENT_SKILLS_DIR}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject Pi skill "${entry.runtimeName}" into ${PI_AGENT_SKILLS_DIR}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

async function buildPiSkillsDir(config: Record<string, unknown>): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-skills-"));
  const target = path.join(tmp, "skills");
  await fs.mkdir(target, { recursive: true });
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredNames = new Set(resolveLegacyPaperclipDesiredSkillNames(config, availableEntries));
  for (const entry of availableEntries) {
    if (!desiredNames.has(entry.key)) continue;
    if (isPaperclipSkillSourceMissing(entry)) continue;
    await fs.symlink(entry.source, path.join(target, entry.runtimeName));
  }
  return target;
}

function resolvePiBiller(env: Record<string, string>, provider: string | null): string {
  return inferOpenAiCompatibleBiller(env, null) ?? provider ?? "unknown";
}

async function ensureSessionsDir(): Promise<string> {
  await fs.mkdir(PAPERCLIP_SESSIONS_DIR, { recursive: true });
  return PAPERCLIP_SESSIONS_DIR;
}

function buildSessionPath(agentId: string, timestamp: string): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  return path.join(PAPERCLIP_SESSIONS_DIR, `${safeTimestamp}-${agentId}.jsonl`);
}

function buildRemoteSessionPath(runtimeRootDir: string, agentId: string, timestamp: string): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  return path.posix.join(runtimeRootDir, "sessions", `${safeTimestamp}-${agentId}.jsonl`);
}

function normalizeExecutionCwd(candidate: string, remote: boolean): string {
  return remote ? path.posix.normalize(candidate) : path.resolve(candidate);
}

function executionCwdsMatch(saved: string, current: string, remote: boolean): boolean {
  return normalizeExecutionCwd(saved, remote) === normalizeExecutionCwd(current, remote);
}

function readSessionHeaderCwd(raw: string): string | null {
  const headerLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!headerLine) return null;
  try {
    const parsed = JSON.parse(headerLine) as Record<string, unknown>;
    if (parsed.type !== "session") return null;
    const cwd = typeof parsed.cwd === "string" ? parsed.cwd.trim() : "";
    return cwd.length > 0 ? cwd : null;
  } catch {
    return null;
  }
}

async function readSavedSessionCwd(input: {
  runId: string;
  sessionPath: string;
  executionTarget: ReturnType<typeof readAdapterExecutionTarget>;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}): Promise<string | null> {
  if (!input.sessionPath.trim()) return null;

  if (!adapterExecutionTargetIsRemote(input.executionTarget)) {
    try {
      return readSessionHeaderCwd(await fs.readFile(input.sessionPath, "utf8"));
    } catch {
      return null;
    }
  }

  try {
    const sessionHeader = await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.executionTarget,
      `if [ -f ${shellQuote(input.sessionPath)} ]; then head -n 1 ${shellQuote(input.sessionPath)}; fi`,
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec > 0 ? Math.min(input.timeoutSec, 15) : 15,
        graceSec: input.graceSec,
      },
    );
    if (sessionHeader.timedOut || (sessionHeader.exitCode ?? 0) !== 0) return null;
    return readSessionHeaderCwd(sessionHeader.stdout);
  } catch {
    return null;
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "pi");
  const model = asString(config.model, "").trim();
  const thinking = asString(config.thinking, "").trim();
  const modelChain = resolvePiModelChain(config);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  if (!executionTargetIsRemote) {
    await ensureSessionsDir();
  }

  const piSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredPiSkillNames = resolveLegacyPaperclipDesiredSkillNames(config, piSkillEntries);
  if (!executionTargetIsRemote) {
    await ensurePiSkillsInjected(onLog, piSkillEntries, desiredPiSkillNames);
  }

  // Build environment
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
    
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints,
    agentHome,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  if (authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  // Materialize custom Pi providers (PAPERCLIP_PI_PROVIDERS) into a managed
  // PI_CODING_AGENT_DIR before runtimeEnv is computed, so both local validation
  // and the spawned Pi process resolve models against the managed models.json.
  const preparedRuntimeConfig = await preparePiRuntimeConfig({ env });
  const localAgentConfigDir = preparedRuntimeConfig.agentConfigDir ?? "";
  if (localAgentConfigDir) {
    env.PI_CODING_AGENT_DIR = localAgentConfigDir;
  }
  try {
    // Prepend installed skill `bin/` dirs to PATH so an agent's bash tool can
    // invoke skill binaries (e.g. `paperclip-get-issue`) by name. Without this,
    // any pi_local agent whose AGENTS.md calls a skill command via bash hits
    // exit 127 "command not found". Only include skills that ensurePiSkillsInjected
    // actually linked — otherwise non-injected skills' binaries would be reachable
    // to the agent.
    const injectedSkillKeys = new Set(desiredPiSkillNames);
    const skillBinDirs = piSkillEntries
      .filter((entry) => injectedSkillKeys.has(entry.key) && entry.source.length > 0)
      .map((entry) => path.join(entry.source, "bin"));
    const mergedEnv = ensurePathInEnv({ ...sanitizeInheritedPaperclipEnv(process.env), ...env });
    const pathKey =
      typeof mergedEnv.Path === "string" && mergedEnv.Path.length > 0 && !mergedEnv.PATH
        ? "Path"
        : "PATH";
    const basePath = mergedEnv[pathKey] ?? "";
    if (skillBinDirs.length > 0) {
      const existing = basePath.split(path.delimiter).filter(Boolean);
      const additions = skillBinDirs.filter((dir) => !existing.includes(dir));
      if (additions.length > 0) {
        mergedEnv[pathKey] = [...additions, basePath].filter(Boolean).join(path.delimiter);
      }
    }
    const runtimeEnv = Object.fromEntries(
      Object.entries(mergedEnv).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
      executionTarget,
      asNumber(config.timeoutSec, 0),
    );
    const graceSec = asNumber(config.graceSec, 20);
    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId,
      target: executionTarget,
      installCommand: ctx.runtimeCommandSpec?.installCommand,
      detectCommand: ctx.runtimeCommandSpec?.detectCommand,
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onLog,
    });
    await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
      installCommand: SANDBOX_INSTALL_COMMAND,
      timeoutSec,
    });
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
    let loggedEnv = buildInvocationEnvForLogs(env, {
      runtimeEnv,
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });

    if (!executionTargetIsRemote && !model) {
      // Fails with the "model required" error; each candidate model of the
      // chain is checked for availability right before its attempt.
      await ensurePiModelConfiguredAndAvailable({ model, command, cwd, env: runtimeEnv });
    }

    const extraArgs = (() => {
      const fromExtraArgs = asStringArray(config.extraArgs);
      if (fromExtraArgs.length > 0) return fromExtraArgs;
      return asStringArray(config.args);
    })();
    let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
    let remoteRuntimeRootDir: string | null = null;
    let localSkillsDir: string | null = null;
    let remoteSkillsDir: string | null = null;
    let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;

    if (executionTargetIsRemote) {
      try {
        localSkillsDir = await buildPiSkillsDir(config);
        await onLog(
          "stdout",
          `[paperclip] Syncing workspace and Pi runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
        );
        const preparedRemoteRuntime = await prepareAdapterExecutionTargetRuntime({
          runId,
          target: executionTarget,
          adapterKey: "pi",
          timeoutSec,
          workspaceLocalDir: cwd,
          installCommand: SANDBOX_INSTALL_COMMAND,
          detectCommand: command,
          onProgress: (line) => onLog("stdout", line),
          onRuntimeProgress: ctx.onRuntimeProgress,
          assets: [
            {
              key: "skills",
              localDir: localSkillsDir,
              followSymlinks: true,
            },
            ...(localAgentConfigDir
              ? [{
                key: "agentConfig",
                localDir: localAgentConfigDir,
              }]
              : []),
          ],
        });
        restoreRemoteWorkspace = () =>
          preparedRemoteRuntime.restoreWorkspace((line) => onLog("stdout", line));
        effectiveExecutionCwd = preparedRemoteRuntime.workspaceRemoteDir ?? effectiveExecutionCwd;
        refreshPaperclipWorkspaceEnvForExecution({
          env,
          envConfig,
          workspaceCwd: effectiveWorkspaceCwd,
          workspaceSource,
          workspaceId,
          workspaceRepoUrl,
          workspaceRepoRef,
          workspaceHints,
          agentHome,
          executionTargetIsRemote,
          executionCwd: effectiveExecutionCwd,
        });
        if (adapterExecutionTargetUsesManagedHome(executionTarget) && preparedRemoteRuntime.runtimeRootDir) {
          env.HOME = preparedRemoteRuntime.runtimeRootDir;
        }
        remoteRuntimeRootDir = preparedRemoteRuntime.runtimeRootDir;
        remoteSkillsDir = preparedRemoteRuntime.assetDirs.skills ?? null;
        if (localAgentConfigDir && preparedRemoteRuntime.assetDirs.agentConfig) {
          env.PI_CODING_AGENT_DIR = preparedRemoteRuntime.assetDirs.agentConfig;
        }
      } catch (error) {
        await Promise.allSettled([
          restoreRemoteWorkspace?.(),
          localSkillsDir ? fs.rm(path.dirname(localSkillsDir), { recursive: true, force: true }).catch(() => undefined) : Promise.resolve(),
        ]);
        throw error;
      }
    }
    const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
    if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: runtimeExecutionTarget,
        enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(runtimeExecutionTarget),
        duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(runtimeExecutionTarget),
        runtimeRootDir: remoteRuntimeRootDir,
        adapterKey: "pi",
        timeoutSec,
        hostApiToken: env.PAPERCLIP_API_KEY,
        onLog,
      });
      if (paperclipBridge) {
        Object.assign(env, paperclipBridge.env);
        loggedEnv = buildInvocationEnvForLogs(env, {
          runtimeEnv: Object.fromEntries(
            Object.entries(ensurePathInEnv({ ...sanitizeInheritedPaperclipEnv(process.env), ...env })).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
          includeRuntimeKeys: ["HOME"],
          resolvedCommand,
        });
      }
    }

    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
    const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
    const sessionTargetMatches = adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
    const sessionParamsCwdMatches =
      runtimeSessionCwd.length === 0 ||
      executionCwdsMatch(runtimeSessionCwd, effectiveExecutionCwd, executionTargetIsRemote);
    const savedSessionCwd =
      runtimeSessionId.length > 0
        ? await readSavedSessionCwd({
            runId,
            sessionPath: runtimeSessionId,
            executionTarget: runtimeExecutionTarget ?? null,
            cwd,
            env,
            timeoutSec,
            graceSec,
          })
        : null;
    const sessionHeaderCwdMatches =
      runtimeSessionId.length === 0 ||
      (savedSessionCwd !== null &&
        executionCwdsMatch(savedSessionCwd, effectiveExecutionCwd, executionTargetIsRemote));
    const canResumeSession =
      runtimeSessionId.length > 0 &&
      sessionTargetMatches &&
      sessionParamsCwdMatches &&
      sessionHeaderCwdMatches;
    const sessionPath = canResumeSession
      ? runtimeSessionId
      : executionTargetIsRemote && remoteRuntimeRootDir
        ? buildRemoteSessionPath(remoteRuntimeRootDir, agent.id, new Date().toISOString())
        : buildSessionPath(agent.id, new Date().toISOString());

    if (runtimeSessionId && !canResumeSession) {
      const staleSessionCwdNote =
        savedSessionCwd !== null && !sessionHeaderCwdMatches
          ? ` Pi stored cwd "${savedSessionCwd}" in the session header, so Paperclip will start a fresh session for "${effectiveExecutionCwd}".`
          : "";
      await onLog(
        "stdout",
        executionTargetIsRemote
          ? `[paperclip] Pi session "${runtimeSessionId}" does not match the current remote execution state and will not be resumed in "${effectiveExecutionCwd}".${staleSessionCwdNote} Starting a fresh remote session.\n`
          : `[paperclip] Pi session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".${staleSessionCwdNote}\n`,
      );
    }

    if (!canResumeSession) {
      if (executionTargetIsRemote) {
        await ensureAdapterExecutionTargetFile(runId, runtimeExecutionTarget, sessionPath, {
          cwd,
          env,
          timeoutSec: 15,
          graceSec: 5,
          onLog,
        });
      } else {
        try {
          await fs.writeFile(sessionPath, "", { flag: "wx" });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
            throw err;
          }
        }
      }
    }

    // Handle instructions file and build system prompt extension
    const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
    const resolvedInstructionsFilePath = instructionsFilePath
      ? path.resolve(cwd, instructionsFilePath)
      : "";
    const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";

    let systemPromptExtension = "";
    let instructionsReadFailed = false;
    if (resolvedInstructionsFilePath) {
      try {
        const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
        systemPromptExtension =
          `${instructionsContents}\n\n` +
          `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
          `Resolve any relative file references from ${instructionsFileDir}.\n\n` +
          (context.conversationMode === true
            ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
            : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
      } catch (err) {
        instructionsReadFailed = true;
        const reason = err instanceof Error ? err.message : String(err);
        await onLog(
          "stdout",
          `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
        );
        // Fall back to base prompt template
        systemPromptExtension = promptTemplate;
      }
    } else {
      systemPromptExtension = promptTemplate;
    }

    const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
    const templateData = {
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
      company: { id: agent.companyId },
      agent,
      run: { id: runId, source: "on_demand" },
      context,
    };
    const renderedSystemPromptExtension = renderTemplate(systemPromptExtension, templateData);
    const renderedBootstrapPrompt =
      !canResumeSession && bootstrapPromptTemplate.trim().length > 0
        ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
        : "";
    const taskContextNote = context.conversationMode === true
      ? selectPaperclipTaskMarkdown(context, { resumedSession: canResumeSession, includeCommunicationGuidance: false })
      : "";
    const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
      conversationMode: context.conversationMode === true,
      resumedSession: canResumeSession,
      suppressIssueDescription: taskContextNote.length > 0,
    });
    const shouldUseResumeDeltaPrompt = canResumeSession && wakePrompt.length > 0;
    const renderedHeartbeatPrompt = shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(promptTemplate, templateData);
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
    const baseUserPrompt = joinPromptSections([
      renderedBootstrapPrompt,
      wakePrompt,
      taskContextNote,
      sessionHandoffNote,
      renderedHeartbeatPrompt,
    ]);
    const promptMetrics = {
      systemPromptChars: renderedSystemPromptExtension.length,
      promptChars: baseUserPrompt.length,
      bootstrapPromptChars: renderedBootstrapPrompt.length,
      wakePromptChars: wakePrompt.length,
      taskContextChars: taskContextNote.length,
      sessionHandoffChars: sessionHandoffNote.length,
      heartbeatPromptChars: renderedHeartbeatPrompt.length,
    };

    const commandNotes = (() => {
      const notes = [...preparedRuntimeConfig.notes];
      if (!resolvedInstructionsFilePath) return notes;
      if (instructionsReadFailed) {
        notes.push(
          `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
        );
        return notes;
      }
      notes.push(`Loaded agent instructions from ${resolvedInstructionsFilePath}`);
      notes.push(
        `Appended instructions + path directive to system prompt (relative references from ${instructionsFileDir}).`,
      );
      return notes;
    })();

    const buildArgs = (sessionFile: string, attemptModel: string, prompt: string): string[] => {
      const args: string[] = [];

      // Use JSON mode for structured output with print mode (non-interactive)
      args.push("--mode", "json");
      args.push("-p"); // Non-interactive mode: process prompt and exit

      // Use --append-system-prompt to extend Pi's default system prompt
      args.push("--append-system-prompt", renderedSystemPromptExtension);

      const provider = parseModelProvider(attemptModel);
      const modelId = parseModelId(attemptModel);
      if (provider) args.push("--provider", provider);
      if (modelId) args.push("--model", modelId);
      if (thinking) args.push("--thinking", thinking);

      args.push("--tools", "read,bash,edit,write,grep,find,ls");
      args.push("--session", sessionFile);
      args.push("--skill", remoteSkillsDir ?? PI_AGENT_SKILLS_DIR);

      if (extraArgs.length > 0) args.push(...extraArgs);

      // Add the user prompt as the last argument
      args.push(prompt);

      return args;
    };

    const runAttempt = async (sessionFile: string, attemptModel: string, attemptPrompt: string) => {
      const prompt = joinPromptSections([
        selectInitialCommunicationGuidance(context, { resumedSession: canResumeSession && sessionFile === sessionPath }),
        attemptPrompt,
      ]);
      const args = buildArgs(sessionFile, attemptModel, prompt);
      if (onMeta) {
        await onMeta({
          adapterType: "pi_local",
          command: resolvedCommand,
          cwd: effectiveExecutionCwd,
          commandNotes,
          commandArgs: args,
          env: loggedEnv,
          prompt,
          promptMetrics: { ...promptMetrics, promptChars: prompt.length },
          context,
        });
      }

      // Buffer stdout by lines to handle partial JSON chunks
      let stdoutBuffer = "";
      // proc.stdout keeps only a capped tail, so tool activity is tracked on
      // the full stream: it decides whether a failed run may be replayed.
      let toolStarted = false;
      const noteToolStart = (line: string) => {
        if (!toolStarted && PI_TOOL_EXECUTION_START_RE.test(line.slice(0, 64))) toolStarted = true;
      };
      const bufferedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
        if (stream === "stderr") {
          // Pass stderr through immediately (not JSONL)
          await onLog(stream, chunk);
          return;
        }

        // Buffer stdout and emit only complete lines
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        // Keep the last (potentially incomplete) line in the buffer
        stdoutBuffer = lines.pop() || "";

        // Emit complete lines, keeping only the events the transcript reads
        for (const line of lines) {
          noteToolStart(line);
          const logged = line ? compactPiRunLogLine(line) : null;
          if (logged !== null) {
            await onLog(stream, logged + "\n");
          }
        }
      };

      const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
        cwd,
        env: executionTargetIsRemote ? env : runtimeEnv,
        timeoutSec,
        graceSec,
        onSpawn,
        onRuntimeProgress: ctx.onRuntimeProgress,
        onLog: bufferedOnLog,
        runLogTail: paperclipBridge?.runLogTail,
        settleRunDisposition: paperclipBridge?.settleRunDisposition,
      });

      // Flush any remaining buffer content
      noteToolStart(stdoutBuffer);
      const loggedTail = stdoutBuffer ? compactPiRunLogLine(stdoutBuffer) : null;
      if (loggedTail !== null) {
        await onLog("stdout", loggedTail);
      }

      const parsed = parsePiJsonl(proc.stdout);
      return {
        proc,
        rawStderr: proc.stderr,
        parsed,
        toolStarted: toolStarted || parsed.toolCalls.length > 0,
      };
    };

    type PiAttempt = Awaited<ReturnType<typeof runAttempt>>;

    const toResult = (
      attempt: PiAttempt,
      options: { model: string; clearSession: boolean; providerWorkStarted: boolean },
    ): AdapterExecutionResult => {
      const clearSessionOnMissingSession = options.clearSession;
      const provider = parseModelProvider(options.model);
      if (attempt.proc.timedOut) {
        return {
          exitCode: attempt.proc.exitCode,
          signal: attempt.proc.signal,
          timedOut: true,
          errorMessage: `Timed out after ${timeoutSec}s`,
          clearSession: clearSessionOnMissingSession,
        };
      }

      const resolvedSessionId = clearSessionOnMissingSession ? null : sessionPath;
      const resolvedSessionParams = resolvedSessionId
        ? {
            sessionId: resolvedSessionId,
            cwd: effectiveExecutionCwd,
            ...(workspaceId ? { workspaceId } : {}),
            ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
            ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
            ...(executionTargetIsRemote
              ? {
                  remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
                }
              : {}),
          }
        : null;

      const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
      const rawExitCode = attempt.proc.exitCode;
      const parsedError = attempt.parsed.errors.find((error) => error.trim().length > 0) ?? "";
      const effectiveExitCode = (rawExitCode ?? 0) === 0 && parsedError ? 1 : rawExitCode;
      const fallbackErrorMessage = parsedError || stderrLine || `Pi exited with code ${rawExitCode ?? -1}`;
      const failed = (effectiveExitCode ?? 0) !== 0;
      // Let the server wait for a quota reset, or retry a transient provider
      // outage, instead of failing the agent outright.
      const providerFailure = failed
        ? classifyPiProviderFailure({ errors: attempt.parsed.errors, stderr: attempt.proc.stderr })
        : null;
      const retryNotBefore = providerFailure?.retryNotBefore?.toISOString() ?? null;

      return {
        exitCode: effectiveExitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        errorMessage: failed ? fallbackErrorMessage : null,
        // Forward the transport-level error code from the run-disposition seam
        // first. A lost duplex control channel surfaces the typed
        // `duplex_channel_lost` code before any provider classification.
        errorCode: attempt.proc.errorCode
          ? attempt.proc.errorCode
          : providerFailure?.errorFamily === "provider_quota"
            ? "provider_quota"
            : providerFailure?.errorFamily === "transient_upstream"
              ? "pi_transient_upstream"
              : null,
        errorFamily: providerFailure?.errorFamily ?? null,
        retryNotBefore,
        usage: {
          inputTokens: attempt.parsed.usage.inputTokens,
          outputTokens: attempt.parsed.usage.outputTokens,
          cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
        },
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: provider,
        biller: resolvePiBiller(runtimeEnv, provider),
        model: options.model,
        billingType: "unknown",
        costUsd: attempt.parsed.usage.costUsd,
        resultJson: {
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
          ...(providerFailure ? { errorFamily: providerFailure.errorFamily } : {}),
          ...(retryNotBefore ? { retryNotBefore, transientRetryNotBefore: retryNotBefore } : {}),
          ...(providerFailure?.errorFamily === "provider_quota" && retryNotBefore
            ? { providerQuotaRetryNotBefore: retryNotBefore }
            : {}),
          // No tool ran in this run, so the server may replay it automatically
          // instead of holding it for board reconciliation.
          ...(providerFailure && !options.providerWorkStarted
            ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } }
            : {}),
        },
        summary: attempt.parsed.finalMessage ?? attempt.parsed.messages.join("\n\n").trim(),
        clearSession: Boolean(clearSessionOnMissingSession),
      };
    };

    // Every model of the chain is cooling down: fail before spawning Pi and let
    // the server retry when the first one recovers.
    const toChainCoolingDownResult = (
      recovery: { model: string; cooldown: PiModelCooldown },
      unlistedModels: string[] = [],
    ): AdapterExecutionResult => {
      const errorFamily = recovery.cooldown.kind === "hard" ? "provider_quota" : "transient_upstream";
      const retryNotBefore = recovery.cooldown.until;
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage:
          (unlistedModels.length > 0
            ? `The Pi model catalogue misses ${unlistedModels.join(", ")} and the other models are cooling down; `
            : `All Pi models are cooling down (${modelChain.join(", ")}); `) +
          `${recovery.model} is next available at ${retryNotBefore}.`,
        errorCode: errorFamily === "provider_quota" ? "provider_quota" : "pi_transient_upstream",
        errorFamily,
        retryNotBefore,
        model: recovery.model,
        provider: parseModelProvider(recovery.model),
        resultJson: {
          errorFamily,
          retryNotBefore,
          transientRetryNotBefore: retryNotBefore,
          ...(errorFamily === "provider_quota" ? { providerQuotaRetryNotBefore: retryNotBefore } : {}),
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        },
        clearSession: false,
      };
    };

    const isAttemptFailed = (attempt: PiAttempt) =>
      !attempt.proc.timedOut && ((attempt.proc.exitCode ?? 0) !== 0 || attempt.parsed.errors.length > 0);
    // A Pi process stopped by the control plane (run cancelled or reassigned:
    // a signal, or exit 143 = SIGTERM / 130 = SIGINT) is neither a provider
    // outage nor a lost session: never respawn it under the same run.
    const isAttemptStopped = (attempt: PiAttempt) =>
      attempt.proc.signal !== null || attempt.proc.exitCode === 143 || attempt.proc.exitCode === 130;

    try {
      const cooldownStore = createPiModelCooldownStore();
      const plan = planPiModelAttempts(modelChain, await cooldownStore.read(), new Date());
      for (const { model: skippedModel, cooldown } of plan.skipped) {
        await onLog("stdout", `[paperclip] Skipping Pi model ${skippedModel}: ${formatCooldownUntil(cooldown)}.\n`);
      }
      if (plan.candidates.length === 0) {
        const recovery = earliestPiChainRecovery(modelChain, await cooldownStore.read(), new Date());
        if (recovery) return toChainCoolingDownResult(recovery);
      }
      const candidates = plan.candidates.length > 0 ? plan.candidates : [model];

      let attemptSessionPath = sessionPath;
      let attemptPrompt = baseUserPrompt;
      let sessionReset = false;
      let providerWorkStarted = false;
      let lastResult: AdapterExecutionResult | null = null;
      const attempts: Array<{
        model: string;
        errorFamily: string | null;
        usage: AdapterExecutionResult["usage"] | null;
        costUsd: number | null;
      }> = [];

      // Failed attempts spent tokens too: account for the whole run.
      const withRunTotals = (result: AdapterExecutionResult): AdapterExecutionResult => {
        if (attempts.length <= 1) return result;
        const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
        let costUsd = 0;
        for (const entry of attempts) {
          usage.inputTokens += entry.usage?.inputTokens ?? 0;
          usage.outputTokens += entry.usage?.outputTokens ?? 0;
          usage.cachedInputTokens += entry.usage?.cachedInputTokens ?? 0;
          costUsd += entry.costUsd ?? 0;
        }
        return { ...result, usage, costUsd, resultJson: { ...result.resultJson, modelAttempts: attempts } };
      };

      // The chain is exhausted: retry when its first model recovers.
      const withChainRecovery = async (result: AdapterExecutionResult): Promise<AdapterExecutionResult> => {
        if (modelChain.length <= 1 || !result.errorFamily) return result;
        const recovery = earliestPiChainRecovery(modelChain, await cooldownStore.read(), new Date());
        if (!recovery || recovery.cooldown.until === result.retryNotBefore) return result;
        const retryNotBefore = recovery.cooldown.until;
        return {
          ...result,
          retryNotBefore,
          resultJson: {
            ...result.resultJson,
            retryNotBefore,
            transientRetryNotBefore: retryNotBefore,
            ...(result.errorFamily === "provider_quota" ? { providerQuotaRetryNotBefore: retryNotBefore } : {}),
          },
        };
      };

      const unlistedModels: string[] = [];
      for (const [index, candidate] of candidates.entries()) {
        const nextCandidate = candidates[index + 1] ?? null;
        if (!executionTargetIsRemote) {
          try {
            await ensurePiModelConfiguredAndAvailable({ model: candidate, command, cwd, env: runtimeEnv });
          } catch (err) {
            // Only a model missing from a successful listing moves down the
            // chain, for this run only: a listing failure or this agent's own
            // env says nothing about the provider, so nothing is shared.
            const reason = err instanceof Error ? err.message : String(err);
            if (!reason.startsWith(PI_MODEL_UNAVAILABLE_PREFIX) || modelChain.length <= 1) throw err;
            unlistedModels.push(candidate);
            await onLog(
              "stdout",
              `[paperclip] ${candidate === model ? "Primary" : "Fallback"} Pi model ${candidate} is absent from ` +
                "the Pi model catalogue (pi --list-models)" +
                (nextCandidate ? `; falling back to ${nextCandidate} for this run.\n` : ".\n"),
            );
            if (nextCandidate) continue;
            if (lastResult) break;
            // Nothing ran: the catalogue misses the remaining models. Wait for
            // a model that is only cooling down instead of failing the run.
            const coolingDown = plan.skipped.filter((entry) => !unlistedModels.includes(entry.model));
            if (coolingDown.length > 0) {
              const recovery = coolingDown.reduce((earliest, entry) =>
                Date.parse(entry.cooldown.until) < Date.parse(earliest.cooldown.until) ? entry : earliest,
              );
              return toChainCoolingDownResult(recovery, unlistedModels);
            }
            const availableModelsIndex = reason.indexOf(" Available models:");
            throw new Error(
              `${PI_MODEL_UNAVAILABLE_PREFIX} ${model}. Fallback models are unavailable too: ` +
                `${unlistedModels.filter((entry) => entry !== model).join(", ")}.` +
                (availableModelsIndex >= 0 ? reason.slice(availableModelsIndex) : ""),
            );
          }
        }

        let attempt = await runAttempt(attemptSessionPath, candidate, attemptPrompt);
        if (
          !lastResult &&
          canResumeSession &&
          isAttemptFailed(attempt) &&
          !isAttemptStopped(attempt) &&
          isPiUnknownSessionError(attempt.proc.stdout, attempt.rawStderr)
        ) {
          await onLog(
            "stdout",
            `[paperclip] Pi session "${runtimeSessionId}" is unavailable; retrying with a fresh session.\n`,
          );
          const newSessionPath = executionTargetIsRemote && remoteRuntimeRootDir
            ? buildRemoteSessionPath(remoteRuntimeRootDir, agent.id, new Date().toISOString())
            : buildSessionPath(agent.id, new Date().toISOString());
          if (executionTargetIsRemote) {
            await ensureAdapterExecutionTargetFile(runId, executionTarget, newSessionPath, {
              cwd,
              env,
              timeoutSec: 15,
              graceSec: 5,
              onLog,
            });
          } else {
            try {
              await fs.writeFile(newSessionPath, "", { flag: "wx" });
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
                throw err;
              }
            }
          }
          attemptSessionPath = newSessionPath;
          sessionReset = true;
          attempt = await runAttempt(attemptSessionPath, candidate, attemptPrompt);
        }

        providerWorkStarted ||= attempt.toolStarted;
        const result = toResult(attempt, { model: candidate, clearSession: sessionReset, providerWorkStarted });
        attempts.push({
          model: candidate,
          errorFamily: result.errorFamily ?? null,
          usage: result.usage ?? null,
          costUsd: result.costUsd ?? null,
        });
        lastResult = result;

        if (result.timedOut) return withRunTotals(result);
        if ((result.exitCode ?? 0) === 0) {
          await cooldownStore.recordSuccess(candidate);
          if (candidate !== model) {
            await onLog("stdout", `[paperclip] Run completed on fallback Pi model ${candidate}.\n`);
          }
          return withRunTotals(result);
        }
        if (isAttemptStopped(attempt)) return withRunTotals(result);
        // Only provider availability failures move down the chain; anything
        // else (auth, prompt, tool or agent errors) is the run's real outcome.
        if (result.errorFamily !== "provider_quota" && result.errorFamily !== "transient_upstream") {
          return withRunTotals(result);
        }
        const { cooldown } = await cooldownStore.recordFailure({
          model: candidate,
          kind: result.errorFamily === "provider_quota" ? "hard" : "soft",
          retryNotBefore: result.retryNotBefore ? new Date(result.retryNotBefore) : null,
          reason: result.errorMessage ?? result.errorFamily,
        });
        if (!nextCandidate) break;
        await onLog(
          "stdout",
          `[paperclip] Pi model ${candidate} failed (${formatCooldownUntil(cooldown)}); ` +
            `falling back to ${nextCandidate} in the same session.\n`,
        );
        attemptPrompt =
          `The previous model (${candidate}) stopped because its provider is unavailable ` +
          `(${result.errorFamily === "provider_quota" ? "usage quota reached" : "transient provider error"}). ` +
          "Continue the task from where it left off.";
      }

      if (lastResult) return withChainRecovery(withRunTotals(lastResult));
      throw new Error(`No Pi model of the chain is available: ${modelChain.join(", ")}`);
    } finally {
      await Promise.all([
        paperclipBridge?.stop(),
        restoreRemoteWorkspace?.(),
        localSkillsDir ? fs.rm(path.dirname(localSkillsDir), { recursive: true, force: true }).catch(() => undefined) : Promise.resolve(),
      ]);
    }
  } finally {
    await preparedRuntimeConfig.cleanup();
  }
}
