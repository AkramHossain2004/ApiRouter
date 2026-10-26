import test from "node:test";
import assert from "node:assert/strict";
import { chatToAnthropicRequest } from "../src/anthropic-upstream.js";
import { chatToResponsesRequest } from "../src/responses-upstream.js";
import { toGeminiFromChat } from "../src/chat-bridge.js";
import { toOpenAIChatRequest, toGeminiRequest } from "../src/anthropic-bridge.js";
import { toOpenAIChatFromResponses, toGeminiFromResponses } from "../src/codex-bridge.js";
import { toChatFromGemini } from "../src/gemini-bridge.js";
import { readReasoning, withoutReasoning, anthropicThinking } from "../src/bridge-reasoning.js";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

const PDF = "JVBERi0xLjQKJSVFT0YK";
const WAV = "UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
const chatFile = { type: "file", file: { filename: "a.pdf", file_data: `data:application/pdf;base64,${PDF}` } };
const chatAudio = { type: "input_audio", input_audio: { data: WAV, format: "wav" } };
const user = (...content) => ({ messages: [{ role: "user", content: [{ type: "text", text: "d" }, ...content] }] });
const refused = (fn) => assert.throws(fn, (error) => error.name === "UnsupportedMediaError" && error.status === 400 && error.retryable === true);

// ------------------------------------------------------------------ files and audio

test("chat -> anthropic: a file becomes a document block; audio and text-position media are refused, never dropped", () => {
  const out = chatToAnthropicRequest(user(chatFile), "m");
  assert.deepEqual(out.messages[0].content[1], {
    type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF }, title: "a.pdf"
  });
  refused(() => chatToAnthropicRequest(user(chatAudio), "m"));
  refused(() => chatToAnthropicRequest({ messages: [{ role: "system", content: [chatFile] }, { role: "user", content: "x" }] }, "m"));
  refused(() => chatToAnthropicRequest(user({ type: "file", file: { file_id: "file-1" } }), "m"));
});

test("chat -> responses: a file becomes input_file; audio is refused", () => {
  const out = chatToResponsesRequest(user(chatFile), "m");
  assert.deepEqual(out.input[0].content[1], { type: "input_file", filename: "a.pdf", file_data: `data:application/pdf;base64,${PDF}` });
  refused(() => chatToResponsesRequest(user(chatAudio), "m"));
});

test("chat / responses / anthropic -> gemini: files and audio become inlineData with their real media type", () => {
  assert.deepEqual(toGeminiFromChat(user(chatFile)).contents[0].parts[1], { inlineData: { mimeType: "application/pdf", data: PDF } });
  assert.deepEqual(toGeminiFromChat(user(chatAudio)).contents[0].parts[1], { inlineData: { mimeType: "audio/wav", data: WAV } });
  refused(() => toGeminiFromChat(user({ type: "file", file: { file_id: "file-1" } })));

  const responses = { input: [{ role: "user", content: [{ type: "input_text", text: "d" }, { type: "input_file", filename: "a.pdf", file_data: `data:application/pdf;base64,${PDF}` }, chatAudio] }] };
  const parts = toGeminiFromResponses(responses).contents[0].parts;
  assert.deepEqual(parts[1], { inlineData: { mimeType: "application/pdf", data: PDF } });
  assert.deepEqual(parts[2], { inlineData: { mimeType: "audio/wav", data: WAV } });

  const anthropic = { messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF } }] }] };
  assert.deepEqual(toGeminiRequest(anthropic).contents[0].parts[0], { inlineData: { mimeType: "application/pdf", data: PDF } });
  refused(() => toGeminiRequest({ messages: [{ role: "user", content: [{ type: "document", source: { type: "url", url: "https://x/a.pdf" } }] }] }));
});

test("anthropic / responses -> chat: documents and files become chat file parts, text documents become text", () => {
  const anthropic = { messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF } }, { type: "document", title: "n", source: { type: "text", media_type: "text/plain", data: "hello" } }] }] };
  const content = toOpenAIChatRequest(anthropic, "m").messages[0].content;
  assert.deepEqual(content[0], { type: "file", file: { filename: "document.pdf", file_data: `data:application/pdf;base64,${PDF}` } });
  assert.deepEqual(content[1], { type: "text", text: "[n]\nhello" });

  const responses = { input: [{ role: "user", content: [{ type: "input_text", text: "d" }, { type: "input_file", filename: "a.pdf", file_data: `data:application/pdf;base64,${PDF}` }, chatAudio] }] };
  const parts = toOpenAIChatFromResponses(responses, "m").messages[0].content;
  assert.deepEqual(parts[1], { type: "file", file: { filename: "a.pdf", file_data: `data:application/pdf;base64,${PDF}` } });
  assert.deepEqual(parts[2], { type: "input_audio", input_audio: { data: WAV, format: "wav" } });
});

test("gemini -> chat: inline media is classified by its media type, not relabelled as an image", () => {
  const body = { contents: [{ role: "user", parts: [
    { inlineData: { mimeType: "image/png", data: "AAAA" } },
    { inlineData: { mimeType: "audio/wav", data: WAV } },
    { inlineData: { mimeType: "application/pdf", data: PDF } }
  ] }] };
  const content = toChatFromGemini(body, "m").messages[0].content;
  assert.equal(content[0].type, "image_url");
  assert.deepEqual(content[1], { type: "input_audio", input_audio: { data: WAV, format: "wav" } });
  assert.equal(content[2].type, "file");
  refused(() => toChatFromGemini({ contents: [{ role: "user", parts: [{ inlineData: { mimeType: "video/mp4", data: "AAAA" } }] }] }, "m"));
});

// ------------------------------------------------------------------ reasoning

test("reasoning controls are read from every protocol into one canonical form", () => {
  assert.equal(readReasoning({ reasoning_effort: "high" }, "openai-chat").effort, "high");
  assert.equal(readReasoning({ reasoning: { effort: "low" } }, "openai-responses").effort, "low");
  assert.deepEqual(readReasoning({ thinking: { type: "enabled", budget_tokens: 2048 } }, "anthropic"), { effort: "low", budget: 2048 });
  assert.equal(readReasoning({ generationConfig: { thinkingConfig: { thinkingBudget: 20000 } } }, "gemini").effort, "high");
  assert.equal(readReasoning({ thinking: { type: "disabled" } }, "anthropic"), null);
  assert.equal(readReasoning({}, "openai-chat"), null);
});

test("reasoning is translated to each upstream's own control", () => {
  const chat = { ...user(), reasoning_effort: "medium", max_tokens: 8000 };
  assert.deepEqual(chatToAnthropicRequest(chat, "m").thinking, { type: "enabled", budget_tokens: 4096 });
  assert.deepEqual(chatToResponsesRequest(chat, "m").reasoning, { effort: "medium" });
  assert.deepEqual(toGeminiFromChat(chat).generationConfig.thinkingConfig, { thinkingBudget: 4096 });
  assert.equal(toOpenAIChatRequest({ messages: [{ role: "user", content: "x" }], thinking: { type: "enabled", budget_tokens: 9000 } }, "m").reasoning_effort, "high");
  assert.equal(toOpenAIChatFromResponses({ input: "x", reasoning: { effort: "low" } }, "m").reasoning_effort, "low");
  assert.equal(toChatFromGemini({ contents: [{ role: "user", parts: [{ text: "x" }] }], generationConfig: { thinkingConfig: { thinkingBudget: 1024 } } }, "m").reasoning_effort, "low");
});

test("extended thinking never squeezes out the answer and is skipped where Anthropic would reject it", () => {
  // No client limit: room is added on top of the default so the answer still fits.
  const open = chatToAnthropicRequest({ ...user(), reasoning_effort: "high" }, "m");
  assert.ok(open.max_tokens > open.thinking.budget_tokens + 1000, JSON.stringify(open));
  // A small client limit shrinks the budget; one too small for the 1024 minimum drops thinking.
  assert.equal(anthropicThinking({ effort: "high", budget: 16384 }, 1000), null);
  assert.ok(anthropicThinking({ effort: "high", budget: 16384 }, 4000).budget_tokens <= 3000);
  // Thinking requires the default temperature.
  assert.equal(chatToAnthropicRequest({ ...user(), reasoning_effort: "low", temperature: 0.2, max_tokens: 8000 }, "m").temperature, undefined);
  // A forced tool choice, or a tool-use turn whose thinking blocks a chat client cannot return, skip it.
  const tools = [{ type: "function", function: { name: "t", parameters: { type: "object", properties: {} } } }];
  assert.equal(chatToAnthropicRequest({ ...user(), reasoning_effort: "low", tools, tool_choice: "required" }, "m").thinking, undefined);
  const toolTurn = { messages: [
    { role: "user", content: "x" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "r" }
  ], reasoning_effort: "low", tools };
  assert.equal(chatToAnthropicRequest(toolTurn, "m").thinking, undefined);
});

test("withoutReasoning strips every protocol's control and leaves the rest untouched", () => {
  const stripped = withoutReasoning({ model: "x", reasoning_effort: "high", reasoning: { effort: "low" }, thinking: { type: "enabled", budget_tokens: 2048 }, generationConfig: { temperature: 0.2, thinkingConfig: { thinkingBudget: 1 } } });
  assert.deepEqual(stripped, { model: "x", generationConfig: { temperature: 0.2 } });
  const plain = { a: 1 };
  assert.equal(withoutReasoning(plain), plain);
  // `enable_thinking` is detected as a reasoning request, so it is stripped with the rest.
  assert.deepEqual(withoutReasoning({ model: "x", enable_thinking: true }), { model: "x" });
});

test("a reasoning control reaches only targets whose model declares `reasoning`", async (t) => {
  const mock = await startMockUpstream(() => ({ body: {
    id: "m", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }
  } }));
  const router = await startRouter({ PLAYGROUND_ALLOW_PRIVATE_HOSTS: "1" });
  t.after(async () => { await router.close(); await mock.close(); });

  const created = await router.request("/api/custom-endpoints", postJson({
    name: "Only", baseUrl: mock.baseUrl, protocol: "anthropic", models: ["m"], apiKeys: ["sk-test"]
  }));
  assert.equal(created.status, 201);
  const row = (await (await router.request("/api/model-config")).json()).models.find((m) => m.model === "m");
  const ask = () => router.request("/v1/chat/completions", postJson({ model: "any", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high", max_tokens: 9000 }));

  assert.equal((await ask()).status, 200);
  assert.equal(mock.apiRequests.at(-1).body.thinking, undefined, "not declared: the control is stripped");

  const saved = await router.request("/api/model-config", postJson({ provider: row.provider, model: "m", capabilities: ["text_input", "text_output", "streaming", "reasoning"] }));
  assert.ok(saved.status < 300, await saved.text());
  assert.equal((await ask()).status, 200);
  assert.equal(mock.apiRequests.at(-1).body.thinking?.type, "enabled", "declared: translated to Anthropic extended thinking");
});

test("native passthrough follows the same rule: reasoning_effort reaches only models that declare `reasoning`", async (t) => {
  const mock = await startMockUpstream(() => ({ body: {
    id: "c", object: "chat.completion", created: 1, model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  } }));
  const router = await startRouter({ PLAYGROUND_ALLOW_PRIVATE_HOSTS: "1" });
  t.after(async () => { await router.close(); await mock.close(); });

  const created = await router.request("/api/custom-endpoints", postJson({
    name: "Native", baseUrl: mock.baseUrl, protocol: "openai-chat", models: ["m"], apiKeys: ["sk-test"]
  }));
  assert.equal(created.status, 201);
  const row = (await (await router.request("/api/model-config")).json()).models.find((m) => m.model === "m");
  const ask = () => router.request("/v1/chat/completions", postJson({
    model: "any", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high"
  }));

  assert.equal((await ask()).status, 200);
  assert.equal(mock.apiRequests.at(-1).body.reasoning_effort, undefined, "not declared: stripped on a native call too");

  const saved = await router.request("/api/model-config", postJson({
    provider: row.provider, model: "m", capabilities: ["text_input", "text_output", "streaming", "reasoning"]
  }));
  assert.ok(saved.status < 300, await saved.text());
  assert.equal((await ask()).status, 200);
  assert.equal(mock.apiRequests.at(-1).body.reasoning_effort, "high", "declared: passed through untouched");
});
