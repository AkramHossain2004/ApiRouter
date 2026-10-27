import test from "node:test";
import assert from "node:assert/strict";
import { withDefaultGeminiThinking, readReasoning } from "../src/bridge-reasoning.js";

const gemini = (model) => ({ provider: "gemini", model });

test("a Gemini 3 text model gets low thinking when the client asked for none", () => {
  const chat = withDefaultGeminiThinking({ messages: [] }, "openai-chat", gemini("gemini-3.8-flash"));
  assert.equal(chat.reasoning_effort, "low");
  assert.equal(readReasoning(chat, "openai-chat").budget, 1024);

  const responses = withDefaultGeminiThinking({ input: "x" }, "openai-responses", gemini("gemini-3.6-flash"));
  assert.equal(readReasoning(responses, "openai-responses").budget, 1024);

  const anthropic = withDefaultGeminiThinking({ messages: [], max_tokens: 4096 }, "anthropic", gemini("gemini-3.5-flash-lite"));
  assert.equal(readReasoning(anthropic, "anthropic").budget, 1024);

  const native = withDefaultGeminiThinking({ contents: [], generationConfig: { temperature: 0.2 } }, "gemini", gemini("models/gemini-3-flash-preview"));
  assert.equal(native.generationConfig.thinkingConfig.thinkingBudget, 1024);
  assert.equal(native.generationConfig.temperature, 0.2);
});

test("a client's own reasoning choice is kept", () => {
  const body = { messages: [], reasoning_effort: "high" };
  assert.equal(withDefaultGeminiThinking(body, "openai-chat", gemini("gemini-3.8-flash")), body);
  const config = { contents: [], generationConfig: { thinkingConfig: { thinkingBudget: 8000 } } };
  assert.equal(withDefaultGeminiThinking(config, "gemini", gemini("gemini-3.8-flash")), config);
});

test("other providers and non-text Gemini models are left alone", () => {
  const body = { messages: [] };
  assert.equal(withDefaultGeminiThinking(body, "openai-chat", { provider: "groq", model: "gemini-3.8-flash" }), body);
  assert.equal(withDefaultGeminiThinking(body, "openai-chat", gemini("gemini-nano-banana-2.1")), body);
  assert.equal(withDefaultGeminiThinking(body, "openai-chat", gemini("gemini-2.5-pro")), body);
});
