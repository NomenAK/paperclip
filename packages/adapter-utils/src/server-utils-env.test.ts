import { describe, expect, it } from "vitest";
import {
  INSTANCE_SIGNING_SECRET_ENV_KEYS,
  runChildProcess,
  sanitizeInheritedPaperclipEnv,
} from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });
});

describe("runChildProcess env", () => {
  it("never hands instance signing secrets to the child, even via opts.env", async () => {
    const leaked = Object.fromEntries(INSTANCE_SIGNING_SECRET_ENV_KEYS.map((key) => [key, "secret"]));
    const result = await runChildProcess("env-probe", process.execPath, [
      "-e",
      `process.stdout.write(JSON.stringify(${JSON.stringify(INSTANCE_SIGNING_SECRET_ENV_KEYS)}.filter((k) => k in process.env)))`,
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
