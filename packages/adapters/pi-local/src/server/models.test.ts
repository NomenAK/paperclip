import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensurePiModelConfiguredAndAvailable,
  listPiModels,
  resetPiModelsCacheForTests,
} from "./models.js";

describe("pi models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_PI_COMMAND;
    resetPiModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(listPiModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensurePiModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("Pi requires `adapterConfig.model`");
  });

  it("rediscovers once when the cached listing lacks the configured model", async () => {
    // Fake `pi --list-models`: the first listing misses openrouter, later ones include it.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-models-"));
    const script = path.join(dir, "pi");
    await fs.writeFile(
      script,
      [
        "#!/bin/sh",
        `count_file="${dir}/count"`,
        'count=$(cat "$count_file" 2>/dev/null || echo 0); echo $((count + 1)) > "$count_file"',
        'echo "provider  model  context" >&2',
        'echo "cpa  claude-opus-5-5  1M" >&2',
        '[ "$count" -gt 0 ] && echo "openrouter  stealth/space-bunny-alpha  1M" >&2',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PAPERCLIP_PI_COMMAND = script;
    try {
      const models = await ensurePiModelConfiguredAndAvailable({ model: "openrouter/stealth/space-bunny-alpha", cwd: dir });
      expect(models.map((entry) => entry.id)).toContain("openrouter/stealth/space-bunny-alpha");
      expect(await fs.readFile(path.join(dir, "count"), "utf8")).toBe("2\n");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(
      ensurePiModelConfiguredAndAvailable({
        model: "xai/grok-4",
      }),
    ).rejects.toThrow();
  });
});
