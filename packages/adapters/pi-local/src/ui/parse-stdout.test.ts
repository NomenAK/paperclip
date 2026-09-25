import { describe, expect, it } from "vitest";
import { parsePiStdoutLine } from "./parse-stdout.js";
import { PI_STREAM } from "./pi-stream.fixture.js";

const TS = "2026-09-25T21:00:00.000Z";

function parseAll(lines: string[]) {
  return lines.flatMap((line) => parsePiStdoutLine(line, TS));
}

describe("parsePiStdoutLine", () => {
  it("renders each completed block exactly once, in order", () => {
    expect(parseAll(PI_STREAM)).toEqual([
      { kind: "init", ts: TS, model: "pi", sessionId: "session-1" },
      { kind: "thinking", ts: TS, text: "I should list the files." },
      { kind: "assistant", ts: TS, text: "Listing the **repository** root." },
      { kind: "tool_call", ts: TS, name: "bash", toolUseId: "call_1", input: { command: "ls" } },
      { kind: "tool_result", ts: TS, toolUseId: "call_1", toolName: "bash", content: "# README.md\nsrc", isError: false },
      { kind: "assistant", ts: TS, text: "Done." },
      {
        kind: "result",
        ts: TS,
        text: "",
        inputTokens: 300,
        outputTokens: 30,
        cachedTokens: 200,
        costUsd: 0.03,
        subtype: "success",
        isError: false,
        errors: [],
      },
    ]);
  });

  it("never renders tool output or prompts as assistant text", () => {
    const assistantTexts = parseAll(PI_STREAM)
      .filter((entry) => entry.kind === "assistant")
      .map((entry) => (entry.kind === "assistant" ? entry.text : ""));
    expect(assistantTexts).toEqual(["Listing the **repository** root.", "Done."]);
  });

  it("emits no streaming deltas", () => {
    expect(parseAll(PI_STREAM).some((entry) => "delta" in entry)).toBe(false);
  });

  it("reports provider errors on the assistant message and the run result", () => {
    const failed = {
      role: "assistant",
      content: [],
      usage: { input: 5, output: 0, cacheRead: 0, cost: { total: 0 } },
      stopReason: "error",
      errorMessage: "429 quota exhausted",
    };
    expect(parsePiStdoutLine(JSON.stringify({ type: "message_end", message: failed }), TS)).toEqual([
      { kind: "stderr", ts: TS, text: "429 quota exhausted" },
    ]);
    const [result] = parsePiStdoutLine(JSON.stringify({ type: "agent_end", messages: [failed] }), TS);
    expect(result).toMatchObject({ kind: "result", isError: true, subtype: "error", errors: ["429 quota exhausted"] });
  });

  it("does not report a result for an attempt Pi is about to retry", () => {
    expect(parsePiStdoutLine(JSON.stringify({ type: "agent_end", messages: [], willRetry: true }), TS)).toEqual([]);
  });

  it("describes retries and context compaction", () => {
    expect(
      parsePiStdoutLine(
        JSON.stringify({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "overloaded" }),
        TS,
      ),
    ).toEqual([{ kind: "system", ts: TS, text: "Provider request failed: overloaded. Retrying (attempt 1/3) in 2s." }]);
    expect(parsePiStdoutLine(JSON.stringify({ type: "auto_retry_end", success: true, attempt: 2 }), TS)).toEqual([]);
    expect(
      parsePiStdoutLine(JSON.stringify({ type: "auto_retry_end", success: false, attempt: 3, finalError: "still overloaded" }), TS),
    ).toEqual([{ kind: "stderr", ts: TS, text: "still overloaded" }]);
    expect(parsePiStdoutLine(JSON.stringify({ type: "compaction_start", reason: "threshold" }), TS)).toEqual([
      { kind: "system", ts: TS, text: "Compacting conversation context (threshold)." },
    ]);
  });

  it("renders image tool results as placeholders", () => {
    const message = {
      role: "toolResult",
      toolCallId: "call_2",
      toolName: "read",
      content: [{ type: "text", text: "Screenshot:" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      isError: false,
    };
    const [entry] = parsePiStdoutLine(JSON.stringify({ type: "message_end", message }), TS);
    expect(entry).toMatchObject({ kind: "tool_result", content: "Screenshot:\n[image: image/png]" });
  });

  it("keeps non-JSON output and unknown events visible", () => {
    expect(parsePiStdoutLine("[paperclip] Syncing workspace", TS)).toEqual([
      { kind: "stdout", ts: TS, text: "[paperclip] Syncing workspace" },
    ]);
    expect(parsePiStdoutLine("   ", TS)).toEqual([]);
    const unknown = JSON.stringify({ type: "something_new" });
    expect(parsePiStdoutLine(unknown, TS)).toEqual([{ kind: "stdout", ts: TS, text: unknown }]);
  });
});
