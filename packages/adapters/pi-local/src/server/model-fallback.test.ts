import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPiModelCooldownStore,
  earliestPiChainRecovery,
  nextPiModelCooldown,
  planPiModelAttempts,
  resolvePiModelChain,
  PI_HARD_COOLDOWN_DEFAULT_MS,
  PI_HARD_COOLDOWN_MARGIN_MS,
  PI_SOFT_COOLDOWN_MAX_MS,
  type PiModelCooldown,
} from "./model-fallback.js";

const now = new Date("2026-09-26T10:00:00.000Z");
const at = (ms: number) => new Date(now.getTime() + ms).toISOString();

describe("resolvePiModelChain", () => {
  it("puts the configured model first and drops blanks and duplicates", () => {
    expect(
      resolvePiModelChain({ model: " cpa/opus ", fallbackModels: ["cpa/gpt", "", "cpa/opus", "openrouter/x", "cpa/gpt"] }),
    ).toEqual(["cpa/opus", "cpa/gpt", "openrouter/x"]);
    expect(resolvePiModelChain({ model: "cpa/opus" })).toEqual(["cpa/opus"]);
    expect(resolvePiModelChain({ model: "cpa/opus", fallbackModels: "cpa/gpt" })).toEqual(["cpa/opus"]);
  });
});

describe("nextPiModelCooldown", () => {
  it("backs soft failures off from one minute, doubling up to thirty", () => {
    let previous: PiModelCooldown | undefined;
    const delays: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      previous = nextPiModelCooldown({ previous, kind: "soft", retryNotBefore: null, reason: "503", now });
      delays.push((Date.parse(previous.until) - now.getTime()) / 60_000);
      // The next failure happens after this cooldown expired (a failed probe).
      previous = { ...previous, until: now.toISOString() };
    }
    expect(delays).toEqual([1, 2, 4, 8, 16, 30, 30]);
    expect(PI_SOFT_COOLDOWN_MAX_MS).toBe(30 * 60_000);
  });

  it("honors a longer retry-after on soft failures", () => {
    const cooldown = nextPiModelCooldown({
      previous: undefined,
      kind: "soft",
      retryNotBefore: new Date(now.getTime() + 5 * 60_000),
      reason: "429",
      now,
    });
    expect(cooldown.until).toBe(at(5 * 60_000));
  });

  it("holds hard failures until the quota reset plus a margin, or one hour", () => {
    const reset = new Date(now.getTime() + 2 * 3_600_000);
    expect(nextPiModelCooldown({ previous: undefined, kind: "hard", retryNotBefore: reset, reason: "quota", now }).until)
      .toBe(at(2 * 3_600_000 + PI_HARD_COOLDOWN_MARGIN_MS));
    expect(nextPiModelCooldown({ previous: undefined, kind: "hard", retryNotBefore: null, reason: "quota", now }).until)
      .toBe(at(PI_HARD_COOLDOWN_DEFAULT_MS + PI_HARD_COOLDOWN_MARGIN_MS));
  });

  it("does not escalate on soft failures during a running cooldown", () => {
    const running: PiModelCooldown = { kind: "soft", until: at(60_000), softFailures: 1, reason: "529" };
    expect(nextPiModelCooldown({ previous: running, kind: "soft", retryNotBefore: null, reason: "529", now }))
      .toEqual(running);
    expect(
      nextPiModelCooldown({ previous: running, kind: "soft", retryNotBefore: new Date(now.getTime() + 300_000), reason: "429", now }),
    ).toMatchObject({ softFailures: 1, until: at(300_000) });
  });

  it("never shortens a running quota cooldown", () => {
    const hard: PiModelCooldown = { kind: "hard", until: at(3_600_000), softFailures: 0, reason: "quota" };
    const next = nextPiModelCooldown({ previous: hard, kind: "soft", retryNotBefore: null, reason: "503", now });
    expect(next).toMatchObject({ kind: "hard", until: hard.until });
  });
});

describe("planPiModelAttempts", () => {
  const cooldowns = {
    "cpa/opus": { kind: "hard", until: at(3_600_000), softFailures: 0, reason: "quota" },
    "cpa/gpt": { kind: "soft", until: at(-1), softFailures: 2, reason: "503" },
  } satisfies Record<string, PiModelCooldown>;

  it("skips models cooling down and keeps chain order", () => {
    const plan = planPiModelAttempts(["cpa/opus", "cpa/gpt", "openrouter/x"], cooldowns, now);
    expect(plan.candidates).toEqual(["cpa/gpt", "openrouter/x"]);
    expect(plan.skipped.map((entry) => entry.model)).toEqual(["cpa/opus"]);
  });

  it("always tries a lone model", () => {
    expect(planPiModelAttempts(["cpa/opus"], cooldowns, now).candidates).toEqual(["cpa/opus"]);
  });

  it("reports the earliest recovery only when the whole chain is cooling down", () => {
    expect(earliestPiChainRecovery(["cpa/opus", "cpa/gpt"], cooldowns, now)).toBeNull();
    const all = { ...cooldowns, "cpa/gpt": { kind: "soft", until: at(120_000), softFailures: 1, reason: "503" } } satisfies Record<string, PiModelCooldown>;
    expect(earliestPiChainRecovery(["cpa/opus", "cpa/gpt"], all, now)).toMatchObject({ model: "cpa/gpt" });
  });
});

describe("createPiModelCooldownStore", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("persists failures, serializes concurrent writes and clears on success", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-cooldowns-"));
    dirs.push(dir);
    const file = path.join(dir, "nested", "cooldowns.json");
    const store = createPiModelCooldownStore(file, () => now);

    await Promise.all([
      store.recordFailure({ model: "a", kind: "soft", retryNotBefore: null, reason: "503" }),
      store.recordFailure({ model: "b", kind: "hard", retryNotBefore: null, reason: "quota" }),
      store.recordFailure({ model: "a", kind: "soft", retryNotBefore: null, reason: "503" }),
    ]);
    const saved = await createPiModelCooldownStore(file, () => now).read();
    expect(Object.keys(saved).sort()).toEqual(["a", "b"]);
    // The second failure lands while the first cooldown runs: no escalation.
    expect(saved.a).toMatchObject({ kind: "soft", softFailures: 1 });

    await store.recordSuccess("a");
    expect(Object.keys(await store.read())).toEqual(["b"]);
  });

  it("treats a missing or corrupt file as no cooldowns", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-cooldowns-"));
    dirs.push(dir);
    const file = path.join(dir, "cooldowns.json");
    expect(await createPiModelCooldownStore(file).read()).toEqual({});
    await fs.writeFile(file, "{not json");
    expect(await createPiModelCooldownStore(file).read()).toEqual({});
  });
});
