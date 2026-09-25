import type { TranscriptEntry } from "@paperclipai/adapter-utils";

// Pi's `--mode json` stream reports each completed message once, in a
// `message_end` event: the assistant's thinking, text and tool calls (in
// order), and every tool result. The other events either repeat that content
// (streaming deltas, `turn_end`, `agent_end.messages`) or only track progress
// (`tool_execution_*`). Like the Claude and Codex parsers, the transcript is
// built from completed messages only, so every block is rendered once and in
// full.

const IGNORED_EVENT_TYPES = new Set([
  "agent_start",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "entry_appended",
  "session_info_changed",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "bash_execution_update",
  // RPC protocol messages
  "response",
  "extension_ui_request",
  "extension_ui_response",
  "extension_error",
]);

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const partRaw of content) {
    const part = asRecord(partRaw);
    if (!part) continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    } else if (part.type === "image") {
      parts.push(`[image${typeof part.mimeType === "string" ? `: ${part.mimeType}` : ""}]`);
    }
  }
  return parts.join("\n");
}

function parseAssistantMessage(message: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const content = Array.isArray(message.content) ? message.content : [];
  for (const blockRaw of content) {
    const block = asRecord(blockRaw);
    if (!block) continue;
    if (block.type === "thinking") {
      const text = asString(block.thinking);
      if (text) entries.push({ kind: "thinking", ts, text });
    } else if (block.type === "text") {
      const text = asString(block.text);
      if (text) entries.push({ kind: "assistant", ts, text });
    } else if (block.type === "toolCall") {
      entries.push({
        kind: "tool_call",
        ts,
        name: asString(block.name, "tool"),
        toolUseId: asString(block.id) || undefined,
        input: block.arguments ?? {},
      });
    }
  }

  const stopReason = asString(message.stopReason);
  if (stopReason === "error" || stopReason === "aborted") {
    const fallback = stopReason === "aborted" ? "Pi request aborted." : "Pi provider request failed.";
    entries.push({ kind: "stderr", ts, text: asString(message.errorMessage).trim() || fallback });
  }
  return entries;
}

function parseMessageEnd(message: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const role = asString(message.role);
  if (role === "assistant") return parseAssistantMessage(message, ts);
  if (role === "toolResult") {
    return [{
      kind: "tool_result",
      ts,
      toolUseId: asString(message.toolCallId),
      toolName: asString(message.toolName) || undefined,
      content: toolResultText(message.content),
      isError: message.isError === true,
    }];
  }
  // The system prompt and the Paperclip wake prompt (user) are not part of the
  // transcript, matching the Claude and Codex adapters.
  return [];
}

function parseAgentEnd(event: Record<string, unknown>, ts: string): TranscriptEntry[] {
  // A failed attempt that Pi is about to retry is not the end of the run.
  if (event.willRetry === true) return [];

  const messages = Array.isArray(event.messages) ? event.messages : [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let costUsd = 0;
  let lastAssistant: Record<string, unknown> | null = null;
  for (const messageRaw of messages) {
    const message = asRecord(messageRaw);
    if (!message || message.role !== "assistant") continue;
    lastAssistant = message;
    const usage = asRecord(message.usage);
    if (!usage) continue;
    inputTokens += asNumber(usage.input);
    outputTokens += asNumber(usage.output);
    cachedTokens += asNumber(usage.cacheRead);
    costUsd += asNumber(asRecord(usage.cost)?.total);
  }

  const stopReason = asString(lastAssistant?.stopReason);
  const isError = stopReason === "error" || stopReason === "aborted";
  const errorMessage = asString(lastAssistant?.errorMessage).trim();
  return [{
    kind: "result",
    ts,
    text: "",
    inputTokens,
    outputTokens,
    cachedTokens,
    costUsd,
    subtype: isError ? stopReason : "success",
    isError,
    errors: isError && errorMessage ? [errorMessage] : [],
  }];
}

export function parsePiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    const trimmed = line.trim();
    return trimmed ? [{ kind: "stdout", ts, text: trimmed }] : [];
  }

  const type = asString(parsed.type);
  if (IGNORED_EVENT_TYPES.has(type)) return [];

  if (type === "session") {
    return [{ kind: "init", ts, model: "pi", sessionId: asString(parsed.id) }];
  }

  if (type === "message_end") {
    const message = asRecord(parsed.message);
    return message ? parseMessageEnd(message, ts) : [];
  }

  if (type === "agent_end") {
    return parseAgentEnd(parsed, ts);
  }

  if (type === "auto_retry_start") {
    const attempt = asNumber(parsed.attempt);
    const maxAttempts = asNumber(parsed.maxAttempts);
    const delaySec = Math.round(asNumber(parsed.delayMs) / 1000);
    const reason = asString(parsed.errorMessage).trim();
    return [{
      kind: "system",
      ts,
      text: `Provider request failed${reason ? `: ${reason}` : ""}. Retrying (attempt ${attempt}/${maxAttempts}) in ${delaySec}s.`,
    }];
  }

  if (type === "auto_retry_end") {
    if (parsed.success === true) return [];
    return [{
      kind: "stderr",
      ts,
      text: asString(parsed.finalError).trim() || "Pi exhausted automatic retries without producing a response.",
    }];
  }

  if (type === "compaction_start") {
    return [{ kind: "system", ts, text: `Compacting conversation context (${asString(parsed.reason, "threshold")}).` }];
  }

  if (type === "compaction_end") {
    if (parsed.aborted === true || asString(parsed.errorMessage)) {
      return [{ kind: "stderr", ts, text: asString(parsed.errorMessage).trim() || "Context compaction aborted." }];
    }
    return [{ kind: "system", ts, text: "Conversation context compacted." }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
