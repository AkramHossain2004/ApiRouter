import test from "node:test";
import assert from "node:assert/strict";
import {
  chatToResponsesRequest,
  responsesEventsToChat,
  responsesJsonToChat
} from "../src/responses-upstream.js";
import { chatProtocol, buildChatRequest } from "../src/chat-bridge.js";
import { geminiProtocol, buildGeminiBridgeRequest } from "../src/gemini-bridge.js";
import { bridgeProtocol, buildBridgeRequest, convertJsonResponse } from "../src/anthropic-bridge.js";
import { selectTargetsForProtocol } from "../src/observability/route-select.js";

/**
 * An endpoint that speaks only OpenAI Responses must be reachable from the
 * Anthropic, OpenAI chat and Gemini client protocols too.
 */

const responsesTarget = {
  provider: "custom-resp",
  model: "gpt-x",
  apiKey: "sk-test",
  keyIndex: 0,
  baseUrl: "https://gw.example.com/v1",
  protocols: ["openai-responses"]
};

test("a Responses-only target is eligible for every client protocol", () => {
  assert.equal(bridgeProtocol(responsesTarget), "openai-responses");
  assert.equal(chatProtocol(responsesTarget), "openai-responses");
  assert.equal(geminiProtocol(responsesTarget), "openai-responses");
  for (const protocol of ["anthropic", "openai-chat", "openai-responses", "gemini"]) {
    assert.equal(selectTargetsForProtocol([responsesTarget], protocol, "").compatible.length, 1, protocol);
  }
});

test("other upstreams keep priority over Responses", () => {
  assert.equal(chatProtocol({ protocols: ["openai-responses", "openai-chat"] }), "openai-chat");
  assert.equal(chatProtocol({ protocols: ["openai-responses", "anthropic"] }), "anthropic");
  assert.equal(bridgeProtocol({ protocols: ["openai-responses", "openai-chat"] }), "openai-chat");
  assert.equal(geminiProtocol({ protocols: ["openai-responses", "gemini"] }), "gemini");
});

test("chat request -> Responses: instructions, items, tools and limits", () => {
  const out = chatToResponsesRequest({
    stream: true,
    max_tokens: 4,
    temperature: 0.2,
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url: "https://example.com/a.png" } }] },
      { role: "assistant", content: "Checking", tool_calls: [{ id: "call_1", type: "function", function: { name: "look", arguments: "{\"a\":1}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "done" }
    ],
    tools: [{ type: "function", function: { name: "look", description: "Look", parameters: { type: "object", properties: {} } } }],
    tool_choice: { type: "function", function: { name: "look" } },
    response_format: { type: "json_schema", json_schema: { name: "out", schema: { type: "object" }, strict: true } }
  }, "gpt-x");

  assert.equal(out.model, "gpt-x");
  assert.equal(out.instructions, "Be brief.");
  assert.equal(out.stream, true);
  assert.equal(out.store, false);
  assert.equal(out.max_output_tokens, 16, "Responses rejects fewer than 16 output tokens");
  assert.equal(out.temperature, 0.2);
  assert.deepEqual(out.tool_choice, { type: "function", name: "look" });
  assert.deepEqual(out.tools, [{ type: "function", name: "look", description: "Look", parameters: { type: "object", properties: {} } }]);
  assert.deepEqual(out.text, { format: { type: "json_schema", name: "out", schema: { type: "object" }, strict: true } });
  assert.deepEqual(out.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Look" }, { type: "input_image", image_url: "https://example.com/a.png" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking" }] },
    { type: "function_call", call_id: "call_1", name: "look", arguments: "{\"a\":1}" },
    { type: "function_call_output", call_id: "call_1", output: "done" }
  ]);
});

test("an image with no URL is refused rather than dropped", () => {
  assert.throws(
    () => chatToResponsesRequest({ messages: [{ role: "user", content: [{ type: "image_url", image_url: {} }] }] }, "m"),
    (error) => error.name === "UnsupportedMediaError" && error.status === 400
  );
});

test("each client bridge builds a Responses request for a Responses target", () => {
  const chat = buildChatRequest(responsesTarget, "openai-responses", { messages: [{ role: "user", content: "hi" }] });
  const claude = buildBridgeRequest(responsesTarget, "openai-responses", { max_tokens: 20, messages: [{ role: "user", content: "hi" }] });
  const gemini = buildGeminiBridgeRequest(responsesTarget, { contents: [{ role: "user", parts: [{ text: "hi" }] }] }, {}, { upstreamProtocol: "openai-responses" });

  for (const request of [chat, claude, gemini]) {
    assert.equal(request.url, "https://gw.example.com/v1/responses");
    assert.equal(request.options.headers.authorization, "Bearer sk-test");
    const body = JSON.parse(request.options.body);
    assert.equal(body.model, "gpt-x");
    assert.deepEqual(body.input, [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }]);
  }
});

test("Responses response -> chat.completion: text, function calls, usage, finish reason", () => {
  const text = responsesJsonToChat({
    status: "completed",
    output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: "Hello" }] }],
    usage: { input_tokens: 4, output_tokens: 2 }
  }, "m");
  assert.equal(text.choices[0].message.content, "Hello");
  assert.equal(text.choices[0].finish_reason, "stop");
  assert.deepEqual(text.usage, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });

  const tool = responsesJsonToChat({
    status: "completed",
    output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "weather", arguments: "{\"city\":\"Dhaka\"}" }]
  }, "m");
  assert.equal(tool.choices[0].finish_reason, "tool_calls");
  assert.equal(tool.choices[0].message.content, null);
  assert.deepEqual(tool.choices[0].message.tool_calls, [
    { id: "call_1", type: "function", function: { name: "weather", arguments: "{\"city\":\"Dhaka\"}" } }
  ]);

  assert.equal(responsesJsonToChat({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }, "m").choices[0].finish_reason, "length");
});

test("a Responses reply reaches an Anthropic client as a Messages response", () => {
  const out = convertJsonResponse("openai-responses", {
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "Hello" }] }],
    usage: { input_tokens: 3, output_tokens: 1 }
  }, "m");
  assert.equal(out.type, "message");
  assert.equal(out.content[0].text, "Hello");
  assert.equal(out.stop_reason, "end_turn");
});

async function* events(...items) {
  for (const item of items) yield typeof item === "string" ? item : JSON.stringify(item);
}
async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test("Responses SSE -> chat chunks: text, a streamed function call, usage, then [DONE]", async () => {
  const out = await collect(responsesEventsToChat(events(
    { type: "response.created", response: {} },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
    { type: "response.output_text.delta", item_id: "msg_1", delta: "Hel" },
    { type: "response.output_text.delta", item_id: "msg_1", delta: "lo" },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "weather", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: "{\"city\":" },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: "\"Dhaka\"}" },
    { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 1, arguments: "{\"city\":\"Dhaka\"}" },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 7, output_tokens: 9 } } }
  ), "m"));

  assert.equal(out.at(-1), "[DONE]");
  const chunks = out.slice(0, -1).map((s) => JSON.parse(s));
  assert.equal(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join(""), "Hello");
  const calls = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
  assert.equal(calls[0].id, "call_1");
  assert.equal(calls[0].function.name, "weather");
  assert.equal(calls.map((c) => c.function.arguments).join(""), "{\"city\":\"Dhaka\"}", "the .done event must not double the arguments");
  assert.equal(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 });
});

test("Responses SSE: arguments that only arrive on the .done event are still forwarded", async () => {
  const out = await collect(responsesEventsToChat(events(
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "weather" } },
    { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: "{\"a\":1}" },
    { type: "response.completed", response: { status: "completed" } }
  ), "m", { emitUsage: false }));
  const calls = out.slice(0, -1).map((s) => JSON.parse(s)).flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
  assert.equal(calls.map((c) => c.function.arguments).join(""), "{\"a\":1}");
});

test("Responses SSE: a failed response becomes an error chunk, not a normal stop", async () => {
  const out = await collect(responsesEventsToChat(events(
    { type: "response.output_text.delta", delta: "x" },
    { type: "response.failed", response: { error: { code: "server_error", message: "boom" } } }
  ), "m"));
  const parsed = out.slice(0, -1).map((s) => JSON.parse(s));
  assert.equal(parsed.at(-1).error.message, "boom");
  assert.equal(out.at(-1), "[DONE]");
  assert.equal(parsed.some((c) => c.choices?.[0]?.finish_reason), false);
});
