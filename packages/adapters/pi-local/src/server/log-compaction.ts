// Pi's `--mode json` stream repeats every message several times: streaming
// deltas, `message_start`/`message_end`, `turn_end`, cumulative tool output in
// `tool_execution_update`, and the whole conversation again in `agent_end`.
// Runs routinely produced multi-megabyte logs, and the server cuts any log
// chunk above its persisted limit in the middle of the JSON, so large tool
// results were lost from the transcript.
//
// The run log only keeps what the transcript and CLI formatters read (see
// ui/parse-stdout.ts): completed messages, lifecycle and error events. Result
// parsing is unaffected: it reads the full process stdout, not the run log.

const REDUNDANT_EVENT_TYPES = new Set([
  "message_start",
  "message_update",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "turn_start",
  "turn_end",
  "bash_execution_update",
]);

/** Stays below the server's persisted run log chunk limit (64 KiB) with room for secret redaction. */
export const PI_RUN_LOG_LINE_MAX_CHARS = 60_000;

const MIN_ELIDED_STRING_CHARS = 1_000;
const MAX_ELISION_PASSES = 64;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function elide(value: string, keepChars: number): string {
  const head = Math.ceil(keepChars * 0.7);
  const tail = keepChars - head;
  const omitted = value.length - head - tail;
  return `${value.slice(0, head)}\n\n[… ${omitted} characters omitted from the run log …]\n\n${value.slice(value.length - tail)}`;
}

interface StringSlot {
  length: number;
  set: (value: string) => void;
  get: () => string;
}

function findLongestString(root: unknown): StringSlot | null {
  let best: StringSlot | null = null;
  const visit = (container: Record<string, unknown> | unknown[]) => {
    const keys = Array.isArray(container) ? container.keys() : Object.keys(container).values();
    for (const key of keys) {
      const value = (container as Record<string | number, unknown>)[key];
      if (typeof value === "string") {
        if (!best || value.length > best.length) {
          best = {
            length: value.length,
            get: () => (container as Record<string | number, unknown>)[key] as string,
            set: (next) => {
              (container as Record<string | number, unknown>)[key] = next;
            },
          };
        }
      } else if (typeof value === "object" && value !== null) {
        visit(value as Record<string, unknown> | unknown[]);
      }
    }
  };
  if (typeof root === "object" && root !== null) visit(root as Record<string, unknown>);
  return best;
}

/** Shortens the longest strings (tool output, file contents in tool arguments) until the event fits. */
function serializeWithinLimit(event: Record<string, unknown>, maxChars: number): string {
  let serialized = JSON.stringify(event);
  for (let pass = 0; pass < MAX_ELISION_PASSES && serialized.length > maxChars; pass += 1) {
    const longest = findLongestString(event);
    if (!longest || longest.length <= MIN_ELIDED_STRING_CHARS) break;
    const keep = Math.max(MIN_ELIDED_STRING_CHARS, longest.length - (serialized.length - maxChars) - 200);
    longest.set(elide(longest.get(), keep));
    serialized = JSON.stringify(event);
  }
  return serialized;
}

function compactAgentEnd(event: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  return {
    ...event,
    messages: messages
      .map(asRecord)
      .filter((message): message is Record<string, unknown> => message?.role === "assistant")
      .map((message) => ({
        role: "assistant",
        usage: message.usage,
        stopReason: message.stopReason,
        errorMessage: message.errorMessage,
      })),
  };
}

/**
 * Returns the line to write to the run log for one line of Pi stdout, or null
 * when the event only repeats content that another event already carries.
 */
export function compactPiRunLogLine(line: string, maxChars = PI_RUN_LOG_LINE_MAX_CHARS): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  const event = asRecord(parsed);
  if (!event) return line;

  const type = typeof event.type === "string" ? event.type : "";
  if (REDUNDANT_EVENT_TYPES.has(type)) return null;
  if (type === "agent_end") return serializeWithinLimit(compactAgentEnd(event), maxChars);
  if (line.length <= maxChars) return line;
  return serializeWithinLimit(event, maxChars);
}
