import { describe, expect, it } from "vitest";
import { parsePiStdoutLine } from "../ui/parse-stdout.js";
import { PI_STREAM } from "../ui/pi-stream.fixture.js";
import { compactPiRunLogLine, PI_RUN_LOG_LINE_MAX_CHARS } from "./log-compaction.js";

const TS = "2026-09-25T21:00:00.000Z";

function compactAll(lines: string[]) {
  return lines.map((line) => compactPiRunLogLine(line)).filter((line): line is string => line !== null);
}

describe("compactPiRunLogLine", () => {
  it("keeps the transcript identical to the one parsed from the full stream", () => {
    const fromFullStream = PI_STREAM.flatMap((line) => parsePiStdoutLine(line, TS));
    const fromRunLog = compactAll(PI_STREAM).flatMap((line) => parsePiStdoutLine(line, TS));
    expect(fromRunLog).toEqual(fromFullStream);
  });

  it("drops events that only repeat completed messages or track progress", () => {
    const types = compactAll(PI_STREAM).map((line) => JSON.parse(line).type);
    expect(types).toEqual([
      "session",
      "agent_start",
      "message_end",
      "message_end",
      "message_end",
      "message_end",
      "agent_end",
      "agent_settled",
    ]);
  });

  it("keeps only usage and stop reasons in agent_end", () => {
    const agentEnd = PI_STREAM.find((line) => JSON.parse(line).type === "agent_end")!;
    const compacted = JSON.parse(compactPiRunLogLine(agentEnd)!);
    expect(compacted.willRetry).toBe(false);
    expect(compacted.messages).toHaveLength(2);
    for (const message of compacted.messages) {
      expect(Object.keys(message).sort()).toEqual(["errorMessage", "role", "stopReason", "usage"].filter((key) => key in message).sort());
      expect(message.content).toBeUndefined();
    }
  });

  it("shortens oversized messages inside valid JSON instead of cutting the line", () => {
    const output = `${"a".repeat(60_000)}MIDDLE${"z".repeat(60_000)}`;
    const line = JSON.stringify({
      type: "message_end",
      message: { role: "toolResult", toolCallId: "call_big", toolName: "read", content: [{ type: "text", text: output }], isError: false },
    });

    const compacted = compactPiRunLogLine(line)!;
    expect(compacted.length).toBeLessThanOrEqual(PI_RUN_LOG_LINE_MAX_CHARS);
    const [entry] = parsePiStdoutLine(compacted, TS);
    expect(entry).toMatchObject({ kind: "tool_result", toolUseId: "call_big", toolName: "read", isError: false });
    const content = entry.kind === "tool_result" ? entry.content : "";
    expect(content.startsWith("aaaa")).toBe(true);
    expect(content.endsWith("zzzz")).toBe(true);
    expect(content).toMatch(/\[… \d+ characters omitted from the run log …\]/);
    expect(content).not.toContain("MIDDLE");
  });

  it("shortens large tool call arguments too", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Writing the file." },
          { type: "toolCall", id: "call_w", name: "write", arguments: { path: "big.md", content: "x".repeat(100_000) } },
        ],
        stopReason: "toolUse",
      },
    });
    const entries = parsePiStdoutLine(compactPiRunLogLine(line)!, TS);
    expect(entries[0]).toEqual({ kind: "assistant", ts: TS, text: "Writing the file." });
    expect(entries[1]).toMatchObject({ kind: "tool_call", name: "write", input: { path: "big.md" } });
  });

  it("passes non-JSON and small lines through unchanged", () => {
    expect(compactPiRunLogLine("[paperclip] Syncing workspace")).toBe("[paperclip] Syncing workspace");
    const unknown = JSON.stringify({ type: "something_new", value: 1 });
    expect(compactPiRunLogLine(unknown)).toBe(unknown);
  });
});
