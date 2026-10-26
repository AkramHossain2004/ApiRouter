import test from "node:test";
import assert from "node:assert/strict";
import {
  anthropicEventsToChat,
  anthropicJsonToChat,
  chatToAnthropicRequest
} from "../src/anthropic-upstream.js";
import { chatProtocol, buildChatRequest } from "../src/chat-bridge.js";
import { codexProtocol, buildCodexRequest } from "../src/codex-bridge.js";
import { geminiProtocol, buildGeminiBridgeRequest } from "../src/gemini-bridge.js";
import { selectTargetsForProtocol } from "../src/observability/route-select.js";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * An endpoint that speaks only Anthropic Messages must be reachable from every
 * client protocol. Before this, chat / Responses / Gemini clients got
 * "No route available" for it while Claude clients worked.
 */

const anthropicTarget = {
  provider: "custom-anth",
  model: "claude-x",
  apiKey: "sk-test",
  keyIndex: 0,
  baseUrl: "https://gw.example.com",
  protocols: ["anthropic"]
};

// ------------------------------------------------------------- selection

test("an Anthropic-only target is eligible for every client protocol", () => {
  assert.equal(chatProtocol(anthropicTarget), "anthropic");
  assert.equal(codexProtocol(anthropicTarget), "anthropic");
  assert.equal(geminiProtocol(anthropicTarget), "anthropic");
  for (const protocol of ["anthropic", "openai-chat", "openai-responses", "gemini"]) {
    const selection = selectTargetsForProtocol([anthropicTarget], protocol, "");
    assert.equal(selection.compatible.length, 1, protocol);
  }
});

test("native and chat/Gemini upstreams keep priority over Anthropic", () => {
  assert.equal(chatProtocol({ protocols: ["anthropic", "openai-chat"] }), "openai-chat");
  assert.equal(chatProtocol({ protocols: ["anthropic", "gemini"] }), "gemini");
  assert.equal(codexProtocol({ protocols: ["anthropic", "openai-chat"] }), "openai-chat");
  assert.equal(geminiProtocol({ protocols: ["anthropic", "openai-chat"] }), "openai-chat");
});

// -------------------------------------------------------------- request

test("chat request -> Anthropic: system, turns, tool calls and tool results", () => {
  const out = chatToAnthropicRequest({
    stream: true,
    temperature: 1.7,
    stop: "END",
    messages: [
      { role: "system", content: "Be brief." },
      { role: "developer", content: "No emoji." },
      { role: "user", content: "Weather in Dhaka?" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "weather", arguments: "{\"city\":\"Dhaka\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "31C" },
      { role: "user", content: "Thanks" }
    ],
    tools: [{ type: "function", function: { name: "weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
    tool_choice: "required"
  }, "claude-x");

  assert.equal(out.model, "claude-x");
  assert.equal(out.system, "Be brief.\n\nNo emoji.");
  assert.equal(out.stream, true);
  assert.equal(out.max_tokens, 4096, "Anthropic requires max_tokens, so a default is supplied");
  assert.equal(out.temperature, 1, "OpenAI's 0..2 range is clamped to Anthropic's 0..1");
  assert.deepEqual(out.stop_sequences, ["END"]);
  assert.deepEqual(out.tool_choice, { type: "any" });
  assert.deepEqual(out.tools, [{ name: "weather", description: "Get weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }]);

  assert.deepEqual(out.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.deepEqual(out.messages[1].content, [{ type: "tool_use", id: "call_1", name: "weather", input: { city: "Dhaka" } }]);
  // The tool result and the follow-up user text share one user turn, result first.
  assert.deepEqual(out.messages[2].content, [
    { type: "tool_result", tool_use_id: "call_1", content: "31C" },
    { type: "text", text: "Thanks" }
  ]);
});

test("chat request -> Anthropic: images, explicit max_tokens and a named tool_choice", () => {
  const out = chatToAnthropicRequest({
    max_completion_tokens: 256,
    top_p: 0.5,
    messages: [{ role: "user", content: [
      { type: "text", text: "What is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "image_url", image_url: { url: "https://example.com/cat.png" } }
    ] }],
    tools: [{ type: "function", function: { name: "look" } }],
    tool_choice: { type: "function", function: { name: "look" } }
  }, "claude-x");

  assert.equal(out.max_tokens, 256);
  assert.equal(out.top_p, 0.5);
  assert.equal("temperature" in out, false);
  assert.deepEqual(out.tool_choice, { type: "tool", name: "look" });
  assert.deepEqual(out.messages[0].content, [
    { type: "text", text: "What is this?" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    { type: "image", source: { type: "url", url: "https://example.com/cat.png" } }
  ]);
});

test("an image in a position that holds only text is refused, not dropped", () => {
  assert.throws(
    () => chatToAnthropicRequest({ messages: [{ role: "system", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }] }, "m"),
    (error) => error.name === "UnsupportedMediaError" && error.status === 400 && error.retryable === true
  );
});

test("each client bridge builds an Anthropic request for an Anthropic target", () => {
  const chat = buildChatRequest(anthropicTarget, "anthropic", { messages: [{ role: "user", content: "hi" }] });
  const codex = buildCodexRequest(anthropicTarget, "anthropic", { input: "hi" });
  const gemini = buildGeminiBridgeRequest(anthropicTarget, { contents: [{ role: "user", parts: [{ text: "hi" }] }] }, {}, { upstreamProtocol: "anthropic" });

  for (const request of [chat, codex, gemini]) {
    assert.equal(request.url, "https://gw.example.com/v1/messages");
    assert.equal(request.options.headers["x-api-key"], "sk-test");
    assert.equal(request.options.headers["anthropic-version"], "2023-06-01");
    const body = JSON.parse(request.options.body);
    assert.equal(body.model, "claude-x");
    assert.deepEqual(body.messages, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  }
});

test("a base URL that already ends in /v1 does not become /v1/v1/messages", () => {
  const request = buildChatRequest({ ...anthropicTarget, baseUrl: "https://gw.example.com/v1/" }, "anthropic", { messages: [{ role: "user", content: "hi" }] });
  assert.equal(request.url, "https://gw.example.com/v1/messages");
});

// ------------------------------------------------------------- response

test("Anthropic message -> chat.completion, with text, tool calls, usage and finish reason", () => {
  const text = anthropicJsonToChat({
    content: [{ type: "text", text: "Hello" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 }
  }, "m");
  assert.equal(text.object, "chat.completion");
  assert.equal(text.choices[0].message.content, "Hello");
  assert.equal(text.choices[0].finish_reason, "stop");
  assert.deepEqual(text.usage, { prompt_tokens: 15, completion_tokens: 3, total_tokens: 18 });

  const tool = anthropicJsonToChat({
    content: [{ type: "tool_use", id: "toolu_1", name: "weather", input: { city: "Dhaka" } }],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1 }
  }, "m");
  assert.equal(tool.choices[0].finish_reason, "tool_calls");
  assert.equal(tool.choices[0].message.content, null);
  assert.deepEqual(tool.choices[0].message.tool_calls, [
    { id: "toolu_1", type: "function", function: { name: "weather", arguments: "{\"city\":\"Dhaka\"}" } }
  ]);

  assert.equal(anthropicJsonToChat({ content: [], stop_reason: "max_tokens" }, "m").choices[0].finish_reason, "length");
});

async function* events(...items) {
  for (const item of items) yield typeof item === "string" ? item : JSON.stringify(item);
}
async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test("Anthropic SSE -> chat chunks: text, an interleaved tool call, usage, then [DONE]", async () => {
  const out = await collect(anthropicEventsToChat(events(
    { type: "message_start", message: { usage: { input_tokens: 7, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "weather", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"city\":" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"Dhaka\"}" } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
    { type: "message_stop" }
  ), "m"));

  assert.equal(out.at(-1), "[DONE]");
  const chunks = out.slice(0, -1).map((s) => JSON.parse(s));
  const text = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
  assert.equal(text, "Hello");
  const calls = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
  assert.equal(calls[0].id, "toolu_1");
  assert.equal(calls[0].function.name, "weather");
  assert.equal(calls.map((c) => c.function.arguments).join(""), "{\"city\":\"Dhaka\"}");
  assert.ok(calls.every((c) => c.index === 0));
  assert.equal(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 });
  assert.deepEqual(chunks.at(-1).choices, []);
});

test("Anthropic SSE: no usage chunk when the client did not ask for one", async () => {
  const out = await collect(anthropicEventsToChat(events(
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }
  ), "m", { emitUsage: false }));
  assert.equal(out.slice(0, -1).some((s) => "usage" in JSON.parse(s)), false);
});

test("Anthropic SSE: an upstream error event becomes an error chunk, not a normal stop", async () => {
  const out = await collect(anthropicEventsToChat(events(
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
    { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }
  ), "m"));
  const parsed = out.slice(0, -1).map((s) => JSON.parse(s));
  assert.equal(parsed.at(-1).error.message, "Overloaded");
  assert.equal(out.at(-1), "[DONE]");
  assert.equal(parsed.some((c) => c.choices?.[0]?.finish_reason), false);
});

// ----------------------------------------------------------- end to end

const anthropicMessage = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-x",
  content: [{ type: "text", text: "Hello from Claude" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 4, output_tokens: 5 }
};

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const anthropicStream = [
  sse("message_start", { message: { id: "msg_1", usage: { input_tokens: 4, output_tokens: 1 } } }),
  sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
  sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello " } }),
  sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "from Claude" } }),
  sse("content_block_stop", { index: 0 }),
  sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
  sse("message_stop", {})
];

async function startAnthropicOnly(t) {
  const upstream = await startMockUpstream((record) => (record.body?.stream === true
    ? { status: 200, headers: { "content-type": "text/event-stream" }, stream: anthropicStream }
    : { status: 200, body: anthropicMessage }));
  const router = await startRouter({ PLAYGROUND_ALLOW_PRIVATE_HOSTS: "1" });
  t.after(async () => { await router.close(); await upstream.close(); });

  const created = await router.request("/api/custom-endpoints", postJson({
    name: "Anth", baseUrl: upstream.baseUrl, protocol: "anthropic", models: ["claude-x"], apiKeys: ["sk-test"]
  }));
  assert.equal(created.status, 201, await created.clone().text());
  return { router, upstream };
}

const posts = (upstream) => upstream.requests.filter((r) => r.method === "POST");

test("e2e: an Anthropic-only endpoint answers an OpenAI chat client (JSON and stream)", async (t) => {
  const { router, upstream } = await startAnthropicOnly(t);

  const response = await router.request("/v1/chat/completions", postJson({ model: "any", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(response.status, 200, await response.clone().text());
  const json = await response.json();
  assert.equal(json.object, "chat.completion");
  assert.equal(json.choices[0].message.content, "Hello from Claude");
  assert.deepEqual(json.usage, { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 });

  const call = posts(upstream).at(-1);
  assert.equal(call.url, "/v1/messages");
  assert.equal(call.headers["x-api-key"], "sk-test");
  assert.equal(call.body.max_tokens, 4096);
  assert.deepEqual(call.body.messages, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);

  const streamed = await router.request("/v1/chat/completions", postJson({ model: "any", stream: true, messages: [{ role: "user", content: "hi" }] }));
  assert.equal(streamed.status, 200);
  const body = await streamed.text();
  const chunks = body.split("\n\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)));
  assert.equal(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join(""), "Hello from Claude");
  assert.ok(body.trimEnd().endsWith("data: [DONE]"));
  assert.equal(chunks.some((c) => "usage" in c), false, "no usage chunk unless include_usage was requested");
});

test("e2e: an Anthropic-only endpoint answers an OpenAI Responses client (JSON and stream)", async (t) => {
  const { router } = await startAnthropicOnly(t);

  const response = await router.request("/v1/responses", postJson({ model: "any", input: "hi" }));
  assert.equal(response.status, 200, await response.clone().text());
  const json = await response.json();
  assert.equal(json.object, "response");
  assert.equal(json.status, "completed");
  assert.equal(json.output[0].content[0].text, "Hello from Claude");

  const streamed = await router.request("/v1/responses", postJson({ model: "any", input: "hi", stream: true }));
  assert.equal(streamed.status, 200);
  const body = await streamed.text();
  assert.match(body, /event: response\.output_text\.delta/);
  assert.match(body, /event: response\.completed/);
  assert.match(body, /Hello from Claude/);
});

test("e2e: an Anthropic-only endpoint answers a Gemini client (JSON and stream)", async (t) => {
  const { router } = await startAnthropicOnly(t);
  const request = postJson({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });

  const response = await router.request("/v1beta/models/gemini-any:generateContent", request);
  assert.equal(response.status, 200, await response.clone().text());
  const json = await response.json();
  assert.equal(json.candidates[0].content.parts[0].text, "Hello from Claude");
  assert.equal(json.candidates[0].finishReason, "STOP");
  assert.deepEqual([json.usageMetadata.promptTokenCount, json.usageMetadata.candidatesTokenCount], [4, 5]);

  const streamed = await router.request("/v1beta/models/gemini-any:streamGenerateContent?alt=sse", request);
  assert.equal(streamed.status, 200);
  const text = (await streamed.text()).split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)))
    .flatMap((c) => c.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "").join("");
  assert.equal(text, "Hello from Claude");
});

test("e2e: the Anthropic client still reaches an Anthropic endpoint natively", async (t) => {
  const { router, upstream } = await startAnthropicOnly(t);
  const response = await router.request("/v1/messages", postJson({ model: "any", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).content[0].text, "Hello from Claude");
  assert.equal(posts(upstream).at(-1).url, "/v1/messages");
});

// ------------------------------------------- saved protocol the provider lacks

const chatCompletion = {
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: "Hello from OpenAI" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
};

test("e2e: an endpoint saved as Anthropic whose provider only speaks OpenAI chat still answers, and the fix is remembered", async (t) => {
  // Like Inception: /v1/chat/completions works, /v1/messages is a 404.
  const upstream = await startMockUpstream((record) => (record.url === "/v1/chat/completions"
    ? { status: 200, body: chatCompletion }
    : { status: 404, body: { detail: "Not Found" } }));
  const router = await startRouter({ PLAYGROUND_ALLOW_PRIVATE_HOSTS: "1" });
  t.after(async () => { await router.close(); await upstream.close(); });

  const created = await router.request("/api/custom-endpoints", postJson({
    name: "OaiOnly", baseUrl: upstream.baseUrl, protocol: "anthropic", models: ["mercury-2"], apiKeys: ["sk-test"]
  }));
  assert.equal(created.status, 201, await created.clone().text());

  const ask = () => router.request("/v1/messages", postJson({ model: "mercury-2", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }));

  const first = await ask();
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal((await first.json()).content[0].text, "Hello from OpenAI");
  assert.deepEqual(posts(upstream).map((r) => r.url), ["/v1/messages", "/v1/chat/completions"]);

  const before = posts(upstream).length;
  const second = await ask();
  assert.equal(second.status, 200);
  assert.deepEqual(posts(upstream).slice(before).map((r) => r.url), ["/v1/chat/completions"], "the correction is remembered");
});

async function startWrongProtocolRouter(t, handler, protocol) {
  const upstream = await startMockUpstream(handler);
  const router = await startRouter({ PLAYGROUND_ALLOW_PRIVATE_HOSTS: "1" });
  t.after(async () => { await router.close(); await upstream.close(); });
  const created = await router.request("/api/custom-endpoints", postJson({
    name: "Dyn", baseUrl: upstream.baseUrl, protocol, models: ["m1"], apiKeys: ["sk-test"]
  }));
  assert.equal(created.status, 201, await created.clone().text());
  return { router, upstream };
}

test("e2e: an endpoint saved as OpenAI chat whose provider only speaks Anthropic still answers every client protocol", async (t) => {
  const { router, upstream } = await startWrongProtocolRouter(t, (record) => (record.url === "/v1/messages"
    ? { status: 200, body: anthropicMessage }
    : { status: 404, body: { detail: "Not Found" } }), "openai-chat");

  const chat = await router.request("/v1/chat/completions", postJson({ model: "m1", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(chat.status, 200, await chat.clone().text());
  assert.equal((await chat.json()).choices[0].message.content, "Hello from Claude");

  const claude = await router.request("/v1/messages", postJson({ model: "m1", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }));
  assert.equal(claude.status, 200, await claude.clone().text());
  assert.equal(posts(upstream).at(-1).url, "/v1/messages");
});

test("e2e: a 400 or 422 from the wrong route also triggers the protocol switch", async (t) => {
  for (const status of [400, 422]) {
    const { router, upstream } = await startWrongProtocolRouter(t, (record) => (record.url === "/v1/chat/completions"
      ? { status: 200, body: chatCompletion }
      : { status, body: { error: "Unexpected body shape: field required: messages" } }), "anthropic");
    const response = await router.request("/v1/chat/completions", postJson({ model: "m1", messages: [{ role: "user", content: "hi" }] }));
    assert.equal(response.status, 200, `${status}: ${await response.clone().text()}`);
    assert.equal(posts(upstream).at(-1).url, "/v1/chat/completions");
  }
});

test("e2e: an endpoint saved as OpenAI Responses falls back to chat completions", async (t) => {
  const { router, upstream } = await startWrongProtocolRouter(t, (record) => (record.url === "/v1/chat/completions"
    ? { status: 200, body: chatCompletion }
    : { status: 404, body: { detail: "Not Found" } }), "openai-responses");
  const response = await router.request("/v1/responses", postJson({ model: "m1", input: "hi" }));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(posts(upstream).at(-1).url, "/v1/chat/completions");
});

test("e2e: a saved protocol that has worked is never second-guessed", async (t) => {
  let fail = false;
  const { router, upstream } = await startWrongProtocolRouter(t, (record) => (record.url === "/v1/messages" && !fail
    ? { status: 200, body: anthropicMessage }
    : { status: record.url === "/v1/messages" ? 400 : 200, body: record.url === "/v1/messages" ? { error: "bad param" } : chatCompletion }), "anthropic");
  const ask = () => router.request("/v1/messages", postJson({ model: "m1", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }));

  assert.equal((await ask()).status, 200);
  fail = true;
  const before = posts(upstream).length;
  const bad = await ask();
  assert.equal(bad.status, 400, "the real 400 reaches the client");
  assert.deepEqual(posts(upstream).slice(before).map((r) => r.url), ["/v1/messages"], "no other protocol is tried");
});

test("e2e: a genuine 400 (bad parameter) does not trigger any protocol probing", async (t) => {
  const { router, upstream } = await startWrongProtocolRouter(t, () => ({ status: 400, body: { error: "temperature must be between 0 and 1" } }), "anthropic");
  const before = posts(upstream).length;
  const response = await router.request("/v1/messages", postJson({ model: "m1", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }));
  assert.equal(response.status, 400);
  assert.deepEqual(posts(upstream).slice(before).map((r) => r.url), ["/v1/messages"], "exactly one upstream call");
});

test("e2e: concurrent requests share one protocol search", async (t) => {
  const { router, upstream } = await startWrongProtocolRouter(t, (record) => (record.url === "/v1/chat/completions"
    ? { status: 200, body: chatCompletion }
    : { status: 404, body: { detail: "Not Found" } }), "anthropic");
  const ask = () => router.request("/v1/chat/completions", postJson({ model: "m1", messages: [{ role: "user", content: "hi" }] }));
  const results = await Promise.all([ask(), ask(), ask()]);
  for (const r of results) assert.equal(r.status, 200, await r.clone().text());
  const wrongRoute = posts(upstream).filter((r) => r.url === "/v1/messages");
  assert.ok(wrongRoute.length <= 3, "no more than one saved-protocol attempt per request");
  assert.equal(posts(upstream).filter((r) => r.url === "/v1/responses").length <= 1, true, "the third protocol is probed at most once");
});

test("e2e: a learned protocol is searched again when the provider stops serving it", async (t) => {
  let mode = "chat";
  const { router, upstream } = await startWrongProtocolRouter(t, (record) => {
    if (mode === "chat") return record.url === "/v1/chat/completions" ? { status: 200, body: chatCompletion } : { status: 404, body: { detail: "Not Found" } };
    return record.url === "/v1/messages" ? { status: 200, body: anthropicMessage } : { status: 404, body: { detail: "Not Found" } };
  }, "anthropic");
  const ask = () => router.request("/v1/chat/completions", postJson({ model: "m1", messages: [{ role: "user", content: "hi" }] }));
  assert.equal((await ask()).status, 200);
  mode = "anthropic";
  const again = await ask();
  assert.equal(again.status, 200, await again.clone().text());
  assert.equal(posts(upstream).at(-1).url, "/v1/messages");
});
