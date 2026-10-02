import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { resetPiModelsCacheForTests } from "./models.js";

// Fake `pi`: lists five models (not "mock/gone" or "mock/missing") and answers per --model.
// Each invocation is appended to calls.log as one JSON line.
const FAKE_PI = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--list-models")) {
  if (fs.existsSync(path.join(__dirname, "list-fails"))) process.exit(1);
  process.stderr.write("provider  model  context\nmock  quota  1M\nmock  flaky  1M\nmock  good  1M\nmock  badauth  1M\nmock  bigtool  1M\nmock  killed  1M\nmock  killedsession  1M\n");
  process.exit(0);
}
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ""; };
const model = arg("--model");
fs.appendFileSync(path.join(__dirname, "calls.log"), JSON.stringify({ model, session: arg("--session"), prompt: args[args.length - 1] }) + "\n");
const out = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const fail = (errorMessage) => out({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage, content: [] } });
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
});

async function run(config: Record<string, unknown>, sessionId?: string) {
  const logs: string[] = [];
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const result = await execute({
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Pi", adapterType: "pi_local", adapterConfig: {} },
    runtime: { sessionId: sessionId ?? null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: fakePi, ...config },
    context: { paperclipWorkspace: { cwd: workspace, source: "project_primary" } },
    onLog: async (_stream: string, chunk: string) => {
      logs.push(chunk);
    },
  } as unknown as AdapterExecutionContext);
  const calls = (await fs.readFile(path.join(root, "bin", "calls.log"), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { model: string; session: string; prompt: string });
  const cooldowns = JSON.parse(await fs.readFile(cooldownsFile, "utf8").catch(() => "{}"));
  return { result, calls, cooldowns, log: logs.join("") };
}

describe("pi model fallback chain", () => {
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

  it("falls back from a model missing from the catalogue and cools it down like a transient failure", async () => {
    const before = Date.now();
    const { result, calls, cooldowns, log } = await run({ model: "mock/gone", fallbackModels: ["mock/good"] });
    expect(calls.map((call) => call.model)).toEqual(["good"]);
    expect(calls[0]!.prompt).not.toContain("The previous model");
    expect(result.model).toBe("mock/good");
    expect(cooldowns["mock/gone"]).toMatchObject({ kind: "soft", softFailures: 1 });
    expect(Date.parse(cooldowns["mock/gone"].until) - before).toBeGreaterThanOrEqual(60_000);
    expect(Date.parse(cooldowns["mock/gone"].until) - before).toBeLessThan(2 * 60_000);
    expect(cooldowns["mock/good"]).toBeUndefined();
    expect(log).toContain(
      "Primary Pi model mock/gone is missing from the Pi model catalogue (pi --list-models); " +
        "treating it as temporarily unavailable (transient cooldown until ",
    );
    expect(log).toContain("); falling back to mock/good.");
  });

  it("starts on the first listed fallback when the primary and earlier fallbacks are missing", async () => {
    const { result, calls, cooldowns, log } = await run({
      model: "mock/gone",
      fallbackModels: ["mock/missing", "mock/good"],
    });
    expect(calls.map((call) => call.model)).toEqual(["good"]);
    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("mock/good");
    expect(cooldowns["mock/gone"]).toMatchObject({ kind: "soft" });
    expect(cooldowns["mock/missing"]).toMatchObject({ kind: "soft" });
    expect(log).toContain("Fallback Pi model mock/missing is missing from the Pi model catalogue (pi --list-models)");
  });

  it("skips a model that an earlier run found missing from the catalogue", async () => {
    await run({ model: "mock/gone", fallbackModels: ["mock/good"] });
    const { result, calls, cooldowns, log } = await run({ model: "mock/gone", fallbackModels: ["mock/good"] });
    expect(calls.map((call) => call.model)).toEqual(["good", "good"]);
    expect(result.model).toBe("mock/good");
    expect(log).toContain("Skipping Pi model mock/gone: transient cooldown until");
    expect(log).not.toContain("Primary Pi model mock/gone is missing");
    expect(cooldowns["mock/gone"]).toMatchObject({ kind: "soft", softFailures: 1 });
  });

  it("returns the chain cooldown result when no model of the chain is in the catalogue", async () => {
    const { result, calls, cooldowns } = await run({ model: "mock/gone", fallbackModels: ["mock/missing"] });
    expect(calls).toEqual([]);
    expect(cooldowns["mock/gone"]).toMatchObject({ kind: "soft", softFailures: 1 });
    expect(cooldowns["mock/missing"]).toMatchObject({ kind: "soft", softFailures: 1 });
    expect(result.exitCode).toBe(1);
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.errorCode).toBe("pi_transient_upstream");
    expect(result.model).toBe("mock/gone");
    expect(result.retryNotBefore).toBe(cooldowns["mock/gone"].until);
    expect(result.errorMessage).toBe(
      `The Pi model catalogue temporarily misses mock/gone, mock/missing; mock/gone is next available at ${cooldowns["mock/gone"].until}.`,
    );
    expect(result.resultJson).toMatchObject({
      errorFamily: "transient_upstream",
      transientRetryNotBefore: cooldowns["mock/gone"].until,
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    });
    expect(result.resultJson).not.toHaveProperty("providerQuotaRetryNotBefore");
  });

  it("waits for a cooling-down model when the rest of the chain is missing from the catalogue", async () => {
    await run({ model: "mock/flaky" });
    const { result, calls, cooldowns } = await run({ model: "mock/flaky", fallbackModels: ["mock/gone"] });
    expect(calls.map((call) => call.model)).toEqual(["flaky"]);
    expect(cooldowns["mock/gone"]).toMatchObject({ kind: "soft" });
    expect(result.exitCode).toBe(1);
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.retryNotBefore).toBe(cooldowns["mock/flaky"].until);
    expect(result.errorMessage).toContain(
      "The Pi model catalogue temporarily misses mock/gone and the other models are cooling down; mock/flaky is next available at",
    );
    expect(result.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
  });

  it("reports the provider failure when the fallbacks after it are missing from the catalogue", async () => {
    const { result, cooldowns, log } = await run({ model: "mock/flaky", fallbackModels: ["mock/gone"] });
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.model).toBe("mock/flaky");
    expect(result.retryNotBefore).toBe(cooldowns["mock/flaky"].until);
    expect(cooldowns["mock/gone"]).toMatchObject({ kind: "soft" });
    expect(log).toContain(
      "Fallback Pi model mock/gone is missing from the Pi model catalogue (pi --list-models); " +
        "treating it as temporarily unavailable (transient cooldown until ",
    );
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

  it("returns the chain cooldown result for a lone model missing from the catalogue", async () => {
    const first = await run({ model: "mock/gone" });
    expect(first.calls).toEqual([]);
    expect(first.cooldowns["mock/gone"]).toMatchObject({ kind: "soft", softFailures: 1 });
    expect(first.result.exitCode).toBe(1);
    expect(first.result.errorFamily).toBe("transient_upstream");
    expect(first.result.retryNotBefore).toBe(first.cooldowns["mock/gone"].until);
    expect(first.result.errorMessage).toContain("The Pi model catalogue temporarily misses mock/gone; mock/gone is next available at");
    expect(first.log).toContain(
      "Primary Pi model mock/gone is missing from the Pi model catalogue (pi --list-models); " +
        "treating it as temporarily unavailable (transient cooldown until ",
    );
    // A lone model is checked again, but a run within the same cooldown is the
    // same glitch: it does not back off further.
    const second = await run({ model: "mock/gone" });
    expect(second.result.retryNotBefore).toBe(first.result.retryNotBefore);
    expect(second.cooldowns["mock/gone"]).toMatchObject({ kind: "soft", softFailures: 1 });
  });

  it("runs a lone model again once it is back in the catalogue", async () => {
    await fs.writeFile(
      cooldownsFile,
      JSON.stringify({
        "mock/good": { kind: "soft", until: new Date(Date.now() - 1_000).toISOString(), softFailures: 1, reason: "missing" },
      }),
    );
    const { result, calls, cooldowns } = await run({ model: "mock/good" });
    expect(calls.map((call) => call.model)).toEqual(["good"]);
    expect(result.exitCode).toBe(0);
    expect(cooldowns["mock/good"]).toBeUndefined();
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
