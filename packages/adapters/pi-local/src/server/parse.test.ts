import { describe, expect, it } from "vitest";
import { classifyPiProviderFailure, parsePiJsonl, isPiUnknownSessionError } from "./parse.js";

describe("parsePiJsonl", () => {
  it("parses agent lifecycle and messages", () => {
    const stdout = [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello from Pi" }],
        },
      }),
      JSON.stringify({ type: "agent_end", messages: [] }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.messages).toContain("Hello from Pi");
    expect(parsed.finalMessage).toBe("Hello from Pi");
  });

  it("parses streaming text deltas", () => {
    const stdout = [
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hello " },
      }),
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "World" },
      }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "Hello World",
        },
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.messages).toContain("Hello World");
  });

  it("parses tool execution", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tool_1",
        toolName: "read",
        args: { path: "/tmp/test.txt" },
      }),
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "tool_1",
        toolName: "read",
        result: "file contents",
        isError: false,
      }),
      JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", content: "Done" },
        toolResults: [
          {
            toolCallId: "tool_1",
            content: "file contents",
            isError: false,
          },
        ],
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].toolName).toBe("read");
    expect(parsed.toolCalls[0].result).toBe("file contents");
    expect(parsed.toolCalls[0].isError).toBe(false);
  });

  it("handles errors in tool execution", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tool_1",
        toolName: "read",
        args: { path: "/missing.txt" },
      }),
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "tool_1",
        toolName: "read",
        result: "File not found",
        isError: true,
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].isError).toBe(true);
    expect(parsed.toolCalls[0].result).toBe("File not found");
  });

  it("extracts usage and cost from turn_end events", () => {
    const stdout = [
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "Response with usage",
          usage: {
            input: 100,
            output: 50,
            cacheRead: 20,
            totalTokens: 170,
            cost: {
              input: 0.001,
              output: 0.0015,
              cacheRead: 0.0001,
              cacheWrite: 0,
              total: 0.0026,
            },
          },
        },
        toolResults: [],
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(100);
    expect(parsed.usage.outputTokens).toBe(50);
    expect(parsed.usage.cachedInputTokens).toBe(20);
    expect(parsed.usage.costUsd).toBeCloseTo(0.0026, 4);
  });

  it("accumulates usage from multiple turns", () => {
    const stdout = [
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "First response",
          usage: {
            input: 50,
            output: 25,
            cacheRead: 0,
            cost: { total: 0.001 },
          },
        },
      }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "Second response",
          usage: {
            input: 30,
            output: 20,
            cacheRead: 10,
            cost: { total: 0.0015 },
          },
        },
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(80);
    expect(parsed.usage.outputTokens).toBe(45);
    expect(parsed.usage.cachedInputTokens).toBe(10);
    expect(parsed.usage.costUsd).toBeCloseTo(0.0025, 4);
  });

  it("handles standalone usage events with Pi format", () => {
    const stdout = [
      JSON.stringify({
        type: "usage",
        usage: {
          input: 200,
          output: 100,
          cacheRead: 50,
          cost: { total: 0.005 },
        },
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(200);
    expect(parsed.usage.outputTokens).toBe(100);
    expect(parsed.usage.cachedInputTokens).toBe(50);
    expect(parsed.usage.costUsd).toBe(0.005);
  });

  it("handles standalone usage events with generic format", () => {
    const stdout = [
      JSON.stringify({
        type: "usage",
        usage: {
          inputTokens: 150,
          outputTokens: 75,
          cachedInputTokens: 25,
          costUsd: 0.003,
        },
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(150);
    expect(parsed.usage.outputTokens).toBe(75);
    expect(parsed.usage.cachedInputTokens).toBe(25);
    expect(parsed.usage.costUsd).toBe(0.003);
  });

  it("surfaces failed auto-retry exhaustion as an error", () => {
    const stdout = [
      JSON.stringify({
        type: "auto_retry_end",
        success: false,
        attempt: 3,
        finalError: "Cloud Code Assist API error (429): RESOURCE_EXHAUSTED",
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.errors).toEqual(["Cloud Code Assist API error (429): RESOURCE_EXHAUSTED"]);
  });

  it("does not treat successful auto-retry as an error", () => {
    const stdout = [
      JSON.stringify({
        type: "auto_retry_end",
        success: true,
        attempt: 2,
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.errors).toEqual([]);
  });

  it("surfaces standalone error events", () => {
    const stdout = [
      JSON.stringify({
        type: "error",
        message: "Connection to model provider lost",
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.errors).toEqual(["Connection to model provider lost"]);
  });

  it("ignores error events with empty messages", () => {
    const stdout = [
      JSON.stringify({
        type: "error",
        message: "",
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.errors).toEqual([]);
  });
});

describe("isPiUnknownSessionError", () => {
  it("detects unknown session errors", () => {
    expect(isPiUnknownSessionError("session not found: s_123", "")).toBe(true);
    expect(isPiUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isPiUnknownSessionError("", "no session available")).toBe(true);
    expect(isPiUnknownSessionError("all good", "")).toBe(false);
    expect(isPiUnknownSessionError("working fine", "no errors")).toBe(false);
  });
});


describe("terminal provider failures", () => {
  it("surfaces and deduplicates errors from Pi assistant messages", () => {
    const message = { role: "assistant", content: [], stopReason: "error", errorMessage: "400 Context limit exceeded" };
    const parsed = parsePiJsonl([
      { type: "message_end", message },
      { type: "turn_end", message },
      { type: "agent_end", messages: [message] },
    ].map(event => JSON.stringify(event)).join("\n"));
    expect(parsed.errors).toEqual(["400 Context limit exceeded"]);
  });
  it("reports an error even when the provider omitted its message", () => {
    expect(parsePiJsonl(JSON.stringify({ type: "turn_end", message: { role: "assistant", stopReason: "error" } })).errors)
      .toEqual(["Pi provider request failed."]);
  });
});

describe("classifyPiProviderFailure", () => {
  const now = new Date("2026-09-26T00:00:00.000Z");

  it("waits for the reset of an exhausted quota behind a proxy cooldown", () => {
    const error =
      '429: {"code":"model_cooldown","last_upstream_error":"usage_limit_reached: The usage limit has been reached","message":"All credentials for model gpt-6-sol are cooling down via provider codex (last error: usage_limit_reached: The usage limit has been reached)","model":"gpt-6-sol","provider":"codex","reset_seconds":13104,"reset_time":"3h38m24s"}';
    expect(classifyPiProviderFailure({ errors: [error] }, now)).toEqual({
      errorFamily: "provider_quota",
      retryNotBefore: new Date(now.getTime() + 13_104_000),
    });
  });

  it("reads resets_in_seconds from a Codex usage limit", () => {
    const error =
      '429: {"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":1790393000,"eligible_promo":null,"resets_in_seconds":7200}';
    expect(classifyPiProviderFailure({ errors: [error] }, now)).toEqual({
      errorFamily: "provider_quota",
      retryNotBefore: new Date(now.getTime() + 7_200_000),
    });
  });

  it("treats rate limits and outages without a quota as transient", () => {
    for (const error of [
      '429 {"error":{"message":"Rate limit exceeded: free-models-per-min"}}',
      "503 No endpoints available for this model",
      "Provider overloaded, try again later",
      "fetch failed: ECONNRESET",
    ]) {
      expect(classifyPiProviderFailure({ errors: [error] }, now)).toEqual({
        errorFamily: "transient_upstream",
        retryNotBefore: null,
      });
    }
    expect(
      classifyPiProviderFailure({ errors: ['429: {"code":"model_cooldown","reset_seconds":20}'] }, now),
    ).toEqual({ errorFamily: "transient_upstream", retryNotBefore: new Date(now.getTime() + 20_000) });
    expect(
      classifyPiProviderFailure({ errors: ["You've hit your limit. Try again in 1h 30m."] }, now),
    ).toEqual({ errorFamily: "provider_quota", retryNotBefore: new Date(now.getTime() + 5_400_000) });
  });

  it("leaves other failures unclassified", () => {
    expect(classifyPiProviderFailure({ errors: ["Pi exited with code 1"], stderr: "" }, now)).toBeNull();
    expect(classifyPiProviderFailure({ errors: [], stderr: "" }, now)).toBeNull();
  });
});
