import pc from "picocolors";
import { parsePiStdoutLine } from "../ui/parse-stdout.js";

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function printPiStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  for (const entry of parsePiStdoutLine(line, new Date().toISOString())) {
    switch (entry.kind) {
      case "init":
        console.log(pc.blue(`Pi session started${entry.sessionId ? ` (session: ${entry.sessionId})` : ""}`));
        break;
      case "thinking":
        console.log(pc.gray(`thinking: ${entry.text}`));
        break;
      case "assistant":
        console.log(pc.green(`assistant: ${entry.text}`));
        break;
      case "tool_call":
        console.log(pc.yellow(`tool_call: ${entry.name}`));
        if (entry.input !== undefined) console.log(pc.gray(formatJson(entry.input)));
        break;
      case "tool_result":
        console.log((entry.isError ? pc.red : pc.cyan)(`tool_result${entry.isError ? " (error)" : ""}`));
        if (entry.content) console.log((entry.isError ? pc.red : pc.gray)(entry.content));
        break;
      case "result":
        console.log(
          pc.blue(
            `Pi agent finished: tokens in=${entry.inputTokens} out=${entry.outputTokens} cached=${entry.cachedTokens} cost=$${entry.costUsd.toFixed(6)}`,
          ),
        );
        for (const error of entry.errors) console.log(pc.red(`error: ${error}`));
        break;
      case "stderr":
        console.log(pc.red(entry.text));
        break;
      case "system":
        console.log(pc.blue(entry.text));
        break;
      default:
        if ("text" in entry && typeof entry.text === "string") console.log(entry.text);
    }
  }
}
