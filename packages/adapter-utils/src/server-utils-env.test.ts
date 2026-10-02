import { describe, expect, it } from "vitest";
import {
  runChildProcess,
  sanitizeInheritedPaperclipEnv,
} from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PAPERCLIP_LISTEN_HOST: "127.0.0.1",
      PAPERCLIP_LISTEN_PORT: "3100",
      PAPERCLIP_FOO: "server-only",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PAPERCLIP_LISTEN_HOST: "127.0.0.1",
      PAPERCLIP_LISTEN_PORT: "3100",
      PATH: "/usr/bin",
    });
  });
});

describe("runChildProcess env", () => {
  it("never hands instance secrets to the child, even via opts.env", async () => {
    const instanceSecretKeys = [
      "PAPERCLIP_AGENT_JWT_SECRET",
      "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
      "PAPERCLIP_DECISION_SIGNING_SECRET",
      "PAPERCLIP_SECRETS_MASTER_KEY",
      "DATABASE_URL",
      "PAPERCLIP_TOOL_OAUTH_CLIENT_SECRET",
      "BETTER_AUTH_SECRET",
    ];
    const leaked = Object.fromEntries(instanceSecretKeys.map((key) => [key, "test-only-secret"]));
    const result = await runChildProcess("env-probe", process.execPath, [
      "-e",
      `process.stdout.write(JSON.stringify(${JSON.stringify(instanceSecretKeys)}.filter((k) => k in process.env)))`,
    ], {
      cwd: process.cwd(),
      env: { ...leaked, KEEP_ME: "1" },
      timeoutSec: 20,
      graceSec: 1,
      onLog: async () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });
});
