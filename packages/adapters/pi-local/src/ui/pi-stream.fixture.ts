// One Pi `--mode json` run with every event type Pi emits for it, shared by
// the transcript parser and run log compaction tests.
const assistantMessage = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "I should list the files." },
    { type: "text", text: "Listing the **repository** root." },
    { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
  ],
  usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, cost: { total: 0.01 } },
  stopReason: "toolUse",
};

const toolResultMessage = {
  role: "toolResult",
  toolCallId: "call_1",
  toolName: "bash",
  content: [{ type: "text", text: "# README.md\nsrc" }],
  isError: false,
};

const finalMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Done." }],
  usage: { input: 200, output: 10, cacheRead: 150, cacheWrite: 0, cost: { total: 0.02 } },
  stopReason: "stop",
};

export const PI_STREAM = [
  { type: "session", version: 3, id: "session-1", cwd: "/work" },
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_start", message: { role: "user", content: [{ type: "text", text: "Wake prompt" }] } },
  { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Wake prompt" }] } },
  { type: "message_start", message: { ...assistantMessage, content: [] } },
  { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "I should " } },
  { type: "message_update", assistantMessageEvent: { type: "thinking_end", content: "I should list the files." } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Listing the **repo" } },
  { type: "message_update", assistantMessageEvent: { type: "text_end", content: "Listing the **repository** root." } },
  { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "{\"command\"" } },
  { type: "message_end", message: assistantMessage },
  { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } },
  { type: "tool_execution_update", toolCallId: "call_1", toolName: "bash", partialResult: { content: [{ type: "text", text: "# README" }] } },
  { type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: { content: toolResultMessage.content }, isError: false },
  { type: "message_start", message: toolResultMessage },
  { type: "message_end", message: toolResultMessage },
  { type: "turn_end", message: assistantMessage, toolResults: [toolResultMessage] },
  { type: "turn_start" },
  { type: "message_end", message: finalMessage },
  { type: "turn_end", message: finalMessage, toolResults: [] },
  { type: "agent_end", messages: [assistantMessage, toolResultMessage, finalMessage], willRetry: false },
  { type: "agent_settled" },
].map((event) => JSON.stringify(event));
