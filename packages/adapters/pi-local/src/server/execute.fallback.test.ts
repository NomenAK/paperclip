import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { resetPiModelsCacheForTests } from "./models.js";

// Fake `pi`: lists available models (not "mock/gone" or "mock/missing") and answers per --model.
// Each invocation is appended to calls.log as one JSON line.
const FAKE_PI = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "env-probes.log"), JSON.stringify({
  kind: args.includes("--list-models") ? "models" : "agent",
  keys: Object.keys(process.env),
  runtime: Object.fromEntries(["PATH", "HOME", "PAPERCLIP_API_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_TASK_ID", "PAPERCLIP_RUN_ID", "PAPERCLIP_CALLER_ENV"].map((key) => [key, process.env[key]])),
}) + "\n");
if (args.includes("--list-models")) {
  if (fs.existsSync(path.join(__dirname, "list-fails"))) process.exit(1);
  process.stderr.write("provider  model  context\nmock  quota  1M\nmock  flaky  1M\nmock  good  1M\nmock  badauth  1M\nmock  bigtool  1M\nmock  killed  1M\nmock  killedsession  1M\nmock  lostsession  1M\n");
  process.exit(0);
}
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ""; };
const model = arg("--model");
fs.appendFileSync(path.join(__dirname, "calls.log"), JSON.stringify({ model, session: arg("--session"), prompt: args[args.length - 1] }) + "\n");
const out = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const fail = (errorMessage) => {
  out({ type: "usage", usage: { input: 2, output: 3, cacheRead: 1, cost: { total: 0.25 } } });
  out({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage, content: [] } });
};
if (model === "quota") {
  out({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
  out({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "ok" });
  fail('429: {"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":7200}');
} else if (model === "flaky") fail("503 Service Unavailable: model overloaded");
else if (model === "badauth") fail("401 invalid api key");
else if (model === "killed") {
  // The control plane stopped Pi (run cancelled/reassigned) mid-stream.
  fail("503 Service Unavailable: model overloaded");
  process.exit(143);
}
else if (model === "killedsession") {
  process.stderr.write("session not found\n");
  process.exit(143);
}
else if (model === "lostsession") {
  process.stderr.write("session not found\n");
  process.exit(1);
}
else if (model === "bigtool") {
  // A tool runs, then over 4 MB of streaming updates push it out of the
  // captured stdout tail before the provider fails.
  out({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "git push" } });
  const filler = "x".repeat(64 * 1024);
  for (let i = 0; i < 80; i += 1) out({ type: "message_update", delta: filler });
  fail("503 Service Unavailable: model overloaded");
}
else out({ type: "turn_end", message: { role: "assistant", content: "done by " + model, usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0 } } }, toolResults: [] });
`;

let root: string;
let fakePi: string;
let cooldownsFile: string;
let execute: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
const previousHome = process.env.HOME;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-fallback-exec-"));
  // Sessions and skills live under ~/.pi: keep them out of the real home.
  process.env.HOME = root;
  cooldownsFile = path.join(root, "cooldowns.json");
  process.env.PAPERCLIP_PI_MODEL_COOLDOWNS_FILE = cooldownsFile;
  fakePi = path.join(root, "bin", "pi");
  await fs.mkdir(path.dirname(fakePi), { recursive: true });
  await fs.writeFile(fakePi, FAKE_PI, { mode: 0o755 });
  process.env.PAPERCLIP_PI_COMMAND = fakePi;
  ({ execute } = await import("./execute.js"));
});

afterAll(async () => {
  process.env.HOME = previousHome;
  delete process.env.PAPERCLIP_PI_MODEL_COOLDOWNS_FILE;
  delete process.env.PAPERCLIP_PI_COMMAND;
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  resetPiModelsCacheForTests();
  await fs.rm(path.join(root, "bin", "list-fails"), { force: true });
  await fs.rm(cooldownsFile, { force: true });
  await fs.rm(path.join(root, "bin", "calls.log"), { force: true });
  await fs.rm(path.join(root, "bin", "env-probes.log"), { force: true });
});

async function run(
  config: Record<string, unknown>,
  sessionId?: string,
  control: Pick<AdapterExecutionContext, "signal" | "onCancellationReady" | "onSpawn" | "onLog"> = { onLog: async () => {} },
  authToken?: string,
) {
  const logs: string[] = [];
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const result = await execute({
    runId: "run-1",
    authToken,
    agent: { id: "agent-1", companyId: "company-1", name: "Pi", adapterType: "pi_local", adapterConfig: {} },
    runtime: { sessionId: sessionId ?? null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: fakePi, ...config },
    context: { paperclipWorkspace: { cwd: workspace, source: "project_primary" } },
    ...control,
    onLog: async (_stream: "stdout" | "stderr", chunk: string) => {
      logs.push(chunk);
      await control.onLog(_stream, chunk);
    },
  } as unknown as AdapterExecutionContext);
  const calls = (await fs.readFile(path.join(root, "bin", "calls.log"), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { model: string; session: string; prompt: string });
  const cooldowns = JSON.parse(await fs.readFile(cooldownsFile, "utf8").catch(() => "{}"));
  return { result, calls, cooldowns, log: logs.join("") };
}

describe("pi child environment", () => {
  it("isolates server secrets while preserving inherited and run-scoped env", async () => {
    const serverOnlyKeys = [
      "PAPERCLIP_AGENT_JWT_SECRET",
      "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
      "PAPERCLIP_DECISION_SIGNING_SECRET",
      "PAPERCLIP_SECRETS_MASTER_KEY",
      "DATABASE_URL",
      "PAPERCLIP_TOOL_OAUTH_CLIENT_SECRET",
      "BETTER_AUTH_SECRET",
      "PAPERCLIP_FOO",
    ];
    for (const key of serverOnlyKeys) vi.stubEnv(key, "test-only-server-value");
    vi.stubEnv("PAPERCLIP_RUNTIME_API_URL", "http://127.0.0.1:4321");
    try {
      const { result } = await run({
        model: "mock/good",
        env: {
          PAPERCLIP_TASK_ID: "task-env-probe",
          PAPERCLIP_CALLER_ENV: "run-only",
        },
      }, undefined, undefined, "test-only-run-token");
      expect(result.exitCode).toBe(0);
      const probes = (await fs.readFile(path.join(root, "bin", "env-probes.log"), "utf8"))
        .trim().split("\n")
        .map((line) => JSON.parse(line) as { kind: string; keys: string[]; runtime: Record<string, string> });
      expect(probes.map((probe) => probe.kind)).toEqual(["models", "agent"]);
      for (const probe of probes) {
        expect(probe.keys.filter((key) => serverOnlyKeys.includes(key))).toEqual([]);
        expect(probe.runtime.HOME).toBe(root);
        expect(probe.runtime.PATH.split(path.delimiter)).toEqual(expect.arrayContaining(process.env.PATH!.split(path.delimiter)));
        expect(probe.runtime).toMatchObject({
          PAPERCLIP_API_URL: "http://127.0.0.1:4321",
          PAPERCLIP_API_KEY: "test-only-run-token",
          PAPERCLIP_TASK_ID: "task-env-probe",
          PAPERCLIP_RUN_ID: "run-1",
          PAPERCLIP_CALLER_ENV: "run-only",
        });
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("pi model fallback chain", () => {
  it("does not start provider work when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const onCancellationReady = vi.fn(async () => {});
    const { result, calls } = await run({ model: "mock/good" }, undefined, {
      signal: controller.signal,
      onCancellationReady,
      onLog: async () => {},
    });
    expect(calls).toEqual([]);
    expect(onCancellationReady).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ exitCode: null, signal: null, timedOut: false });
  });

  it("awaits cancellation readiness before the first provider spawn", async () => {
    const controller = new AbortController();
    let ready = false;
    const barrier = new EventEmitter();
    const reachedReadinessOrSpawn = once(barrier, "reached");
    const released = once(barrier, "release");
    const readinessAtSpawn: boolean[] = [];
    const onCancellationReady = vi.fn(async () => {
      barrier.emit("reached");
      await released;
      ready = true;
    });
    const pending = run({ model: "mock/good" }, undefined, {
      signal: controller.signal,
      onCancellationReady,
      onSpawn: async () => {
        readinessAtSpawn.push(ready);
        barrier.emit("reached");
      },
      onLog: async () => {},
    });
    await reachedReadinessOrSpawn;
    barrier.emit("release");
    const { result, calls } = await pending;
    expect(readinessAtSpawn).toEqual([true]);
    expect(onCancellationReady).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.model)).toEqual(["good"]);
    expect(result.exitCode).toBe(0);
  });

  it("does not fall back after cancellation during a transient provider failure", async () => {
    const controller = new AbortController();
    const onCancellationReady = vi.fn(async () => {});
    const { result, calls, cooldowns } = await run({ model: "mock/flaky", fallbackModels: ["mock/good"] }, undefined, {
      signal: controller.signal,
      onCancellationReady,
      onLog: async (_stream, chunk) => {
        if (chunk.includes("503 Service Unavailable")) controller.abort();
      },
    });
    expect(controller.signal.aborted).toBe(true);
    expect(calls.map((call) => call.model)).toEqual(["flaky"]);
    expect(result).toMatchObject({ exitCode: 1, errorFamily: "transient_upstream", model: "mock/flaky" });
    expect(cooldowns).toEqual({});
    expect(onCancellationReady).toHaveBeenCalledTimes(1);
  });

  it("preserves run totals when cancellation stops a later fallback", async () => {
    const controller = new AbortController();
    const { result, calls } = await run({ model: "mock/quota", fallbackModels: ["mock/flaky", "mock/good"] }, undefined, {
      signal: controller.signal,
      onCancellationReady: vi.fn(async () => {}),
      onLog: async (_stream, chunk) => {
        if (chunk.includes("503 Service Unavailable")) controller.abort();
      },
    });
    expect(calls.map((call) => call.model)).toEqual(["quota", "flaky"]);
    expect(result).toMatchObject({ exitCode: 1, model: "mock/flaky", usage: { inputTokens: 4, outputTokens: 6, cachedInputTokens: 2 }, costUsd: 0.5 });
    expect(result.resultJson).toMatchObject({ modelAttempts: [{ model: "mock/quota" }, { model: "mock/flaky" }] });
  });

  it("does not retry a missing session after cancellation", async () => {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const sessionFile = path.join(root, "cancelled-session.jsonl");
    await fs.writeFile(sessionFile, JSON.stringify({ type: "session", cwd: workspace }) + "\n");
    const controller = new AbortController();
    const { result, calls, log } = await run({ model: "mock/lostsession" }, sessionFile, {
      signal: controller.signal,
      onCancellationReady: vi.fn(async () => {}),
      onLog: async (_stream, chunk) => {
        if (chunk.includes("session not found")) controller.abort();
      },
    });
    expect(controller.signal.aborted).toBe(true);
    expect(calls.map((call) => call.session)).toEqual([sessionFile]);
    expect(log).not.toContain("retrying with a fresh session");
    expect(result.exitCode).toBe(1);
    expect(result.clearSession).toBe(false);
  });

  it("falls back down the chain in the same session and reports the model that ran", async () => {
    const { result, calls, cooldowns, log } = await run({
      model: "mock/quota",
      fallbackModels: ["mock/flaky", "mock/good"],
    });
    expect(calls.map((call) => call.model)).toEqual(["quota", "flaky", "good"]);
    expect(new Set(calls.map((call) => call.session)).size).toBe(1);
    expect(calls[1]!.prompt).toContain("The previous model (mock/quota) stopped");
    expect(calls[2]!.prompt).toContain("The previous model (mock/flaky) stopped");
    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("mock/good");
    expect(result.provider).toBe("mock");
    expect(cooldowns["mock/quota"]).toMatchObject({ kind: "hard" });
    expect(cooldowns["mock/flaky"]).toMatchObject({ kind: "soft", softFailures: 1 });
    expect(cooldowns["mock/good"]).toBeUndefined();
    expect(log).toContain("Run completed on fallback Pi model mock/good");
    expect((result.resultJson as { modelAttempts: Array<{ model: string }> }).modelAttempts.map((entry) => entry.model))
      .toEqual(["mock/quota", "mock/flaky", "mock/good"]);
  });

  it("skips cooling-down models on the next run", async () => {
    await run({ model: "mock/quota", fallbackModels: ["mock/good"] });
    const { calls, log } = await run({ model: "mock/quota", fallbackModels: ["mock/good"] });
    expect(calls.map((call) => call.model)).toEqual(["quota", "good", "good"]);
    expect(log).toContain("Skipping Pi model mock/quota: quota cooldown until");
  });

  it("fails fast with the earliest recovery when the whole chain is cooling down", async () => {
    await run({ model: "mock/quota", fallbackModels: ["mock/flaky"] });
    const { result, calls } = await run({ model: "mock/quota", fallbackModels: ["mock/flaky"] });
    expect(calls.map((call) => call.model)).toEqual(["quota", "flaky"]);
    expect(result.exitCode).toBe(1);
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.model).toBe("mock/flaky");
    expect(result.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
  });

  it("returns the soonest chain recovery when the last model fails", async () => {
    const { result } = await run({ model: "mock/flaky", fallbackModels: ["mock/quota"] });
    expect(result.errorFamily).toBe("provider_quota");
    // flaky cools down for one minute, quota for two hours: retry after the minute.
    expect(Date.parse(result.retryNotBefore!) - Date.now()).toBeLessThan(2 * 60_000);
    // The quota attempt ran a tool, so the run is not replayable blindly.
    expect(result.resultJson).not.toHaveProperty("executionRecovery");
  });

  it("does not fall back on non-provider failures", async () => {
    const { result, calls } = await run({ model: "mock/badauth", fallbackModels: ["mock/good"] });
    expect(calls.map((call) => call.model)).toEqual(["badauth"]);
    expect(result.exitCode).toBe(1);
    expect(result.errorFamily).toBeNull();
  });

  it("falls back from a model Pi does not list, for this run only", async () => {
    const { result, calls, cooldowns, log } = await run({ model: "mock/gone", fallbackModels: ["mock/good"] });
    expect(calls.map((call) => call.model)).toEqual(["good"]);
    expect(calls[0]!.prompt).not.toContain("The previous model");
    expect(result.model).toBe("mock/good");
    expect(cooldowns).toEqual({});
    expect(log).toContain(
      "Primary Pi model mock/gone is absent from the Pi model catalogue (pi --list-models); falling back to mock/good for this run.",
    );
  });

  it("starts on the first listed fallback when the primary and earlier fallbacks are not listed", async () => {
    const { result, calls, cooldowns, log } = await run({
      model: "mock/gone",
      fallbackModels: ["mock/missing", "mock/good"],
    });
    expect(calls.map((call) => call.model)).toEqual(["good"]);
    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("mock/good");
    expect(cooldowns).toEqual({});
    expect(log).toContain("Fallback Pi model mock/missing is absent from the Pi model catalogue (pi --list-models); falling back to mock/good");
  });

  it("fails with the unavailable-model error when no model of the chain is listed", async () => {
    await expect(run({ model: "mock/gone", fallbackModels: ["mock/missing"] })).rejects.toThrow(
      /^Configured Pi model is unavailable: mock\/gone\. Fallback models are unavailable too: mock\/missing\. Available models: mock\//,
    );
    expect(JSON.parse(await fs.readFile(cooldownsFile, "utf8").catch(() => "{}"))).toEqual({});
  });

  it("waits for a cooling-down model when the rest of the chain is not listed", async () => {
    // First run: flaky fails and cools down; gone is not listed, so the run
    // reports flaky's failure.
    const first = await run({ model: "mock/flaky", fallbackModels: ["mock/gone"] });
    expect(first.result.errorFamily).toBe("transient_upstream");
    expect(first.log).toContain("Fallback Pi model mock/gone is absent from the Pi model catalogue (pi --list-models).");
    const { result, calls, cooldowns } = await run({ model: "mock/flaky", fallbackModels: ["mock/gone"] });
    expect(calls.map((call) => call.model)).toEqual(["flaky"]);
    expect(result.exitCode).toBe(1);
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.retryNotBefore).toBe(cooldowns["mock/flaky"].until);
    expect(result.errorMessage).toContain("The Pi model catalogue misses mock/gone and the other models are cooling down; mock/flaky is next available at");
    expect(result.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
  });

  it("surfaces a model listing failure instead of cooling models down", async () => {
    await fs.writeFile(path.join(root, "bin", "list-fails"), "");
    await expect(run({ model: "mock/quota", fallbackModels: ["mock/good"] })).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(cooldownsFile, "utf8").catch(() => "{}"))).toEqual({});
  });

  it("never marks a run replayable once a tool ran, even past the captured stdout tail", async () => {
    const { result } = await run({ model: "mock/bigtool" });
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.resultJson).not.toHaveProperty("executionRecovery");
  });

  it("keeps single-model behavior and marks provider failures without tool work as replayable", async () => {
    const { result, calls } = await run({ model: "mock/flaky" });
    expect(calls.map((call) => call.model)).toEqual(["flaky"]);
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
  });

  it("keeps failing a lone model Pi does not list", async () => {
    await expect(run({ model: "mock/gone" })).rejects.toThrow(
      /^Configured Pi model is unavailable: mock\/gone\. Available models: mock\//,
    );
  });

  it("does not fall back when the control plane stopped Pi", async () => {
    const { result, calls, cooldowns } = await run({ model: "mock/killed", fallbackModels: ["mock/good"] });
    expect(calls.map((call) => call.model)).toEqual(["killed"]);
    expect(result.exitCode).toBe(143);
    expect(cooldowns["mock/killed"]).toBeUndefined();
  });

  it("does not respawn a stopped Pi with a fresh session", async () => {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const sessionFile = path.join(root, "saved-session.jsonl");
    await fs.writeFile(sessionFile, JSON.stringify({ type: "session", cwd: workspace }) + "\n");
    const { result, calls, log } = await run({ model: "mock/killedsession" }, sessionFile);
    expect(calls.map((call) => call.session)).toEqual([sessionFile]);
    expect(log).not.toContain("retrying with a fresh session");
    expect(result.exitCode).toBe(143);
  });
});
