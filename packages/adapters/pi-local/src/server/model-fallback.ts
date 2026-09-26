import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asString, asStringArray } from "@paperclipai/adapter-utils/server-utils";

// Soft failures (rate limits, overload, outages) cool a model down briefly and
// back off on repeats; hard failures (quota) cool it down until the provider's
// announced reset. Cooldowns are keyed by model and shared by every agent of
// this Paperclip instance, since agents use the same provider accounts.
export const PI_SOFT_COOLDOWN_BASE_MS = 60_000;
export const PI_SOFT_COOLDOWN_MAX_MS = 30 * 60_000;
export const PI_HARD_COOLDOWN_DEFAULT_MS = 60 * 60_000;
export const PI_HARD_COOLDOWN_MARGIN_MS = 60_000;
const PI_COOLDOWN_RETENTION_MS = 24 * 60 * 60_000;

/** Resolved per call so a test overriding HOME never touches the real file. */
export function defaultPiModelCooldownsFile(): string {
  return (
    process.env.PAPERCLIP_PI_MODEL_COOLDOWNS_FILE?.trim() ||
    path.join(os.homedir(), ".pi", "paperclips", "model-cooldowns.json")
  );
}

export type PiModelFailureKind = "soft" | "hard";

export interface PiModelCooldown {
  kind: PiModelFailureKind;
  until: string;
  softFailures: number;
  reason: string;
}

export type PiModelCooldowns = Record<string, PiModelCooldown>;

/** The configured model followed by its fallbacks, trimmed and deduplicated. */
export function resolvePiModelChain(config: Record<string, unknown>): string[] {
  const chain: string[] = [];
  for (const entry of [asString(config.model, ""), ...asStringArray(config.fallbackModels)]) {
    const model = entry.trim();
    if (model && !chain.includes(model)) chain.push(model);
  }
  return chain;
}

export function isPiModelCoolingDown(entry: PiModelCooldown | undefined, now: Date): entry is PiModelCooldown {
  return Boolean(entry) && Date.parse(entry!.until) > now.getTime();
}

export function nextPiModelCooldown(input: {
  previous: PiModelCooldown | undefined;
  kind: PiModelFailureKind;
  retryNotBefore: Date | null;
  reason: string;
  now: Date;
}): PiModelCooldown {
  const { previous, kind, retryNotBefore, reason, now } = input;
  // Concurrent runs failing during the same outage are one failure: only a
  // failed probe after the cooldown expired backs off further.
  if (kind === "soft" && isPiModelCoolingDown(previous, now)) {
    const until = Math.max(Date.parse(previous.until), retryNotBefore?.getTime() ?? 0);
    return { ...previous, until: new Date(until).toISOString() };
  }
  let until: number;
  let softFailures = 0;
  if (kind === "hard") {
    until = (retryNotBefore?.getTime() ?? now.getTime() + PI_HARD_COOLDOWN_DEFAULT_MS) + PI_HARD_COOLDOWN_MARGIN_MS;
  } else {
    // An expired soft entry keeps its count so a failed probe backs off further.
    softFailures = (previous?.kind === "soft" ? previous.softFailures : 0) + 1;
    const delayMs = Math.min(PI_SOFT_COOLDOWN_BASE_MS * 2 ** (softFailures - 1), PI_SOFT_COOLDOWN_MAX_MS);
    until = Math.max(now.getTime() + delayMs, retryNotBefore?.getTime() ?? 0);
  }
  // Never shorten a cooldown that is still running (e.g. a quota reset).
  if (isPiModelCoolingDown(previous, now) && Date.parse(previous.until) > until) {
    return { ...previous, softFailures: Math.max(previous.softFailures, softFailures) };
  }
  return { kind, until: new Date(until).toISOString(), softFailures, reason };
}

export interface PiModelAttemptPlan {
  candidates: string[];
  skipped: Array<{ model: string; cooldown: PiModelCooldown }>;
}

/**
 * Models to try this run, in chain order, skipping those cooling down. A lone
 * model is always tried: without a fallback there is nothing to switch to.
 */
export function planPiModelAttempts(chain: string[], cooldowns: PiModelCooldowns, now: Date): PiModelAttemptPlan {
  if (chain.length <= 1) return { candidates: [...chain], skipped: [] };
  const plan: PiModelAttemptPlan = { candidates: [], skipped: [] };
  for (const model of chain) {
    const cooldown = cooldowns[model];
    if (isPiModelCoolingDown(cooldown, now)) plan.skipped.push({ model, cooldown });
    else plan.candidates.push(model);
  }
  return plan;
}

/** The earliest moment one model of the chain is usable again. */
export function earliestPiChainRecovery(
  chain: string[],
  cooldowns: PiModelCooldowns,
  now: Date,
): { model: string; cooldown: PiModelCooldown } | null {
  let earliest: { model: string; cooldown: PiModelCooldown } | null = null;
  for (const model of chain) {
    const cooldown = cooldowns[model];
    if (!isPiModelCoolingDown(cooldown, now)) return null;
    if (!earliest || Date.parse(cooldown.until) < Date.parse(earliest.cooldown.until)) {
      earliest = { model, cooldown };
    }
  }
  return earliest;
}

function pruneCooldowns(cooldowns: PiModelCooldowns, now: Date): PiModelCooldowns {
  const kept: PiModelCooldowns = {};
  for (const [model, entry] of Object.entries(cooldowns)) {
    if (Date.parse(entry.until) + PI_COOLDOWN_RETENTION_MS > now.getTime()) kept[model] = entry;
  }
  return kept;
}

function parseCooldowns(raw: string): PiModelCooldowns {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const cooldowns: PiModelCooldowns = {};
    for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<PiModelCooldown> | null;
      if (
        entry &&
        (entry.kind === "soft" || entry.kind === "hard") &&
        typeof entry.until === "string" &&
        Number.isFinite(Date.parse(entry.until))
      ) {
        cooldowns[model] = {
          kind: entry.kind,
          until: entry.until,
          softFailures: typeof entry.softFailures === "number" ? entry.softFailures : 0,
          reason: typeof entry.reason === "string" ? entry.reason : "",
        };
      }
    }
    return cooldowns;
  } catch {
    return {};
  }
}

// Concurrent runs share one server process: serialize read-modify-write per file.
const fileLocks = new Map<string, Promise<unknown>>();

function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  fileLocks.set(filePath, next);
  return next;
}

export interface PiModelCooldownStore {
  read(): Promise<PiModelCooldowns>;
  recordFailure(input: {
    model: string;
    kind: PiModelFailureKind;
    retryNotBefore: Date | null;
    reason: string;
  }): Promise<{ cooldown: PiModelCooldown; cooldowns: PiModelCooldowns }>;
  recordSuccess(model: string): Promise<void>;
}

export function createPiModelCooldownStore(
  filePath = defaultPiModelCooldownsFile(),
  clock: () => Date = () => new Date(),
): PiModelCooldownStore {
  const read = async () => {
    try {
      return parseCooldowns(await fs.readFile(filePath, "utf8"));
    } catch {
      return {};
    }
  };
  const write = async (cooldowns: PiModelCooldowns) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(cooldowns, null, 2)}\n`);
    await fs.rename(tmp, filePath);
  };
  return {
    read,
    recordFailure: ({ model, kind, retryNotBefore, reason }) =>
      withFileLock(filePath, async () => {
        const now = clock();
        const cooldowns = pruneCooldowns(await read(), now);
        const cooldown = nextPiModelCooldown({ previous: cooldowns[model], kind, retryNotBefore, reason, now });
        cooldowns[model] = cooldown;
        await write(cooldowns);
        return { cooldown, cooldowns };
      }),
    recordSuccess: (model) =>
      withFileLock(filePath, async () => {
        const cooldowns = await read();
        if (!(model in cooldowns)) return;
        delete cooldowns[model];
        await write(pruneCooldowns(cooldowns, clock()));
      }),
  };
}
