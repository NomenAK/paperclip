import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

interface ParsedPiOutput {
  sessionId: string | null;
  messages: string[];
  errors: string[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    costUsd: number;
  };
  finalMessage: string | null;
  toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown; result: string | null; isError: boolean }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractTextContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("");
}

export function parsePiJsonl(stdout: string): ParsedPiOutput {
  const result: ParsedPiOutput = {
    sessionId: null,
    messages: [],
    errors: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
    },
    finalMessage: null,
    toolCalls: [],
  };

  let currentToolCall: { toolCallId: string; toolName: string; args: unknown } | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const eventType = asString(event.type, "");

    // Pi can exit successfully after a provider failure. The terminal assistant
    // message carries that failure in both message_end and turn_end envelopes.
    const terminalMessages = eventType === "agent_end"
      ? (Array.isArray(event.messages) ? event.messages : [])
      : eventType === "message_end" || eventType === "turn_end"
        ? [event.message]
        : [];
    for (const rawMessage of terminalMessages) {
      const message = asRecord(rawMessage);
      if (message?.role !== "assistant" || message.stopReason !== "error") continue;
      const error = asString(message.errorMessage, "").trim() || "Pi provider request failed.";
      if (!result.errors.includes(error)) result.errors.push(error);
    }

    // RPC protocol messages - skip these (internal implementation detail)
    if (eventType === "response" || eventType === "extension_ui_request" || eventType === "extension_ui_response" || eventType === "extension_error") {
      continue;
    }

    // Agent lifecycle
    if (eventType === "agent_start") {
      continue;
    }

    if (eventType === "agent_end") {
      const messages = event.messages as Array<Record<string, unknown>> | undefined;
      if (messages && messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        if (lastMessage?.role === "assistant") {
          const content = lastMessage.content as string | Array<{ type: string; text?: string }>;
          result.finalMessage = extractTextContent(content);
        }
      }
      continue;
    }

    if (eventType === "auto_retry_end") {
      const succeeded = event.success === true;
      if (!succeeded) {
        const finalError = asString(event.finalError, "").trim();
        result.errors.push(finalError || "Pi exhausted automatic retries without producing a response.");
      }
      continue;
    }

    // Turn lifecycle
    if (eventType === "turn_start") {
      continue;
    }

    if (eventType === "turn_end") {
      const message = asRecord(event.message);
      if (message) {
        const content = message.content as string | Array<{ type: string; text?: string }>;
        const text = extractTextContent(content);
        if (text) {
          result.finalMessage = text;
          result.messages.push(text);
        }
        
        // Extract usage and cost from assistant message
        const usage = asRecord(message.usage);
        if (usage) {
          result.usage.inputTokens += asNumber(usage.input, 0);
          result.usage.outputTokens += asNumber(usage.output, 0);
          result.usage.cachedInputTokens += asNumber(usage.cacheRead, 0);
          
          // Pi stores cost in usage.cost.total (and broken down in usage.cost.input, etc.)
          const cost = asRecord(usage.cost);
          if (cost) {
            result.usage.costUsd += asNumber(cost.total, 0);
          }
        }
      }
      
      // Tool results are in toolResults array
      const toolResults = event.toolResults as Array<Record<string, unknown>> | undefined;
      if (toolResults) {
        for (const tr of toolResults) {
          const toolCallId = asString(tr.toolCallId, "");
          const content = tr.content;
          const isError = tr.isError === true;
          
          // Find matching tool call by toolCallId
          const existingCall = result.toolCalls.find((tc) => tc.toolCallId === toolCallId);
          if (existingCall) {
            existingCall.result = typeof content === "string" ? content : JSON.stringify(content);
            existingCall.isError = isError;
          }
        }
      }
      continue;
    }

    // Message updates (streaming)
    if (eventType === "message_update") {
      const assistantEvent = asRecord(event.assistantMessageEvent);
      if (assistantEvent) {
        const msgType = asString(assistantEvent.type, "");
        if (msgType === "text_delta") {
          const delta = asString(assistantEvent.delta, "");
          if (delta) {
            // Append to last message or create new
            if (result.messages.length === 0) {
              result.messages.push(delta);
            } else {
              result.messages[result.messages.length - 1] += delta;
            }
          }
        }
      }
      continue;
    }

    if (eventType === "error") {
      const message = asString(event.message, "").trim();
      if (message) {
        result.errors.push(message);
      }
      continue;
    }

    // Tool execution
    if (eventType === "tool_execution_start") {
      const toolCallId = asString(event.toolCallId, "");
      const toolName = asString(event.toolName, "");
      const args = event.args;
      currentToolCall = { toolCallId, toolName, args };
      result.toolCalls.push({
        toolCallId,
        toolName,
        args,
        result: null,
        isError: false,
      });
      continue;
    }

    if (eventType === "tool_execution_end") {
      const toolCallId = asString(event.toolCallId, "");
      const toolName = asString(event.toolName, "");
      const toolResult = event.result;
      const isError = event.isError === true;
      
      // Find the tool call by toolCallId (not toolName, to handle multiple calls to same tool)
      const existingCall = result.toolCalls.find((tc) => tc.toolCallId === toolCallId);
      if (existingCall) {
        existingCall.result = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
        existingCall.isError = isError;
      }
      currentToolCall = null;
      continue;
    }

    // Usage tracking if available in the event (fallback for standalone usage events)
    if (eventType === "usage" || event.usage) {
      const usage = asRecord(event.usage);
      if (usage) {
        // Support both Pi format (input/output/cacheRead) and generic format (inputTokens/outputTokens/cachedInputTokens)
        result.usage.inputTokens += asNumber(usage.inputTokens ?? usage.input, 0);
        result.usage.outputTokens += asNumber(usage.outputTokens ?? usage.output, 0);
        result.usage.cachedInputTokens += asNumber(usage.cachedInputTokens ?? usage.cacheRead, 0);
        
        // Cost may be in usage.costUsd (direct) or usage.cost.total (Pi format)
        const cost = asRecord(usage.cost);
        if (cost) {
          result.usage.costUsd += asNumber(cost.total ?? usage.costUsd, 0);
        } else {
          result.usage.costUsd += asNumber(usage.costUsd, 0);
        }
      }
    }
  }

  return result;
}

export function isPiUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\s+not\s+found|session\s+.*\s+not\s+found|no\s+session/i.test(haystack);
}

// Provider failures are classified from Pi's error messages only (assistant
// errorMessage, auto_retry_end finalError, error events, stderr), never from
// tool output, which routinely contains words like "429" or "rate limit".
const PI_PROVIDER_QUOTA_RE =
  /(?:usage_limit_reached|usage\s+limit\s+(?:has\s+been\s+)?(?:reached|exceeded)|insufficient_quota|exceeded\s+your\s+current\s+quota|quota\s+(?:limit\s+)?exceeded|you(?:'|’)ve\s+hit\s+your\s+(?:\w+\s+)?limit|out\s+of\s+extra\s+usage|(?:5[-\s]?hour|weekly|session)\s+limit\s+reached)/i;
const PI_TRANSIENT_UPSTREAM_RE =
  /(?:\b(?:429|500|502|503|504|529)\b|rate[-\s_]?limit|too\s+many\s+requests|model_cooldown|cooling\s+down|overloaded|service\s+unavailable|temporarily\s+unavailable|high\s+demand|try\s+again\s+later|no\s+(?:allowed\s+)?(?:providers|endpoints)\s+(?:are\s+)?available|ECONNRESET|ETIMEDOUT|socket\s+hang\s+up|fetch\s+failed|error\s+injected\s+into\s+sse\s+stream|provider\s+returned\s+error)/i;
const PI_RETRY_AFTER_SECONDS_RE =
  /"?(?:resets_in_seconds|reset_seconds|retry_after_seconds|retry_after)"?\s*[:=]\s*"?(\d+(?:\.\d+)?)/i;
const PI_RESETS_AT_RE = /"?resets_at"?\s*[:=]\s*"?(\d{10,13})\b/i;
const PI_RETRY_IN_RE = /(?:try\s+again|retry|resets?)\s+in\s+((?:\d+(?:\.\d+)?\s*(?:h|hours?|m|min(?:ute)?s?|s|sec(?:ond)?s?)\s*)+)/i;

function parseDurationMs(text: string): number | null {
  let total = 0;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(h|m|s)/gi)) {
    const value = Number.parseFloat(match[1] ?? "");
    const unit = (match[2] ?? "").toLowerCase();
    total += value * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000);
  }
  return total > 0 ? total : null;
}

function extractPiRetryNotBefore(haystack: string, now: Date): Date | null {
  const seconds = haystack.match(PI_RETRY_AFTER_SECONDS_RE);
  if (seconds) return new Date(now.getTime() + Number.parseFloat(seconds[1] ?? "0") * 1000);
  const resetsAt = haystack.match(PI_RESETS_AT_RE);
  if (resetsAt) {
    const value = Number.parseInt(resetsAt[1] ?? "", 10);
    const date = new Date(resetsAt[1]!.length > 10 ? value : value * 1000);
    if (date.getTime() > now.getTime()) return date;
  }
  const retryIn = haystack.match(PI_RETRY_IN_RE);
  const delayMs = retryIn ? parseDurationMs(retryIn[1] ?? "") : null;
  return delayMs ? new Date(now.getTime() + delayMs) : null;
}

export interface PiProviderFailure {
  errorFamily: "provider_quota" | "transient_upstream";
  retryNotBefore: Date | null;
}

export function classifyPiProviderFailure(
  input: { errors: string[]; stderr?: string | null },
  now = new Date(),
): PiProviderFailure | null {
  const haystack = [...input.errors, input.stderr ?? ""].join("\n").trim();
  if (!haystack) return null;
  const errorFamily = PI_PROVIDER_QUOTA_RE.test(haystack)
    ? "provider_quota"
    : PI_TRANSIENT_UPSTREAM_RE.test(haystack)
      ? "transient_upstream"
      : null;
  if (!errorFamily) return null;
  return { errorFamily, retryNotBefore: extractPiRetryNotBefore(haystack, now) };
}
