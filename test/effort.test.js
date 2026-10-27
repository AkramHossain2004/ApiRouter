import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EffortState, DEFAULT_EFFORT, normalizeEffortLevel } from "../src/effort-state.js";
import { withEffort, readReasoning, chatEffort, responsesReasoning } from "../src/bridge-reasoning.js";

test("effort defaults to medium and accepts the four levels", () => {
  const state = new EffortState();
  assert.equal(DEFAULT_EFFORT, "medium");
  assert.equal(state.effort, "medium");
  for (const level of ["low", "medium", "high", "xhigh"]) assert.equal(state.set(level).effort, level);
  assert.equal(state.set("Extra High / Max").effort, "xhigh");
  assert.equal(state.set("max").effort, "xhigh");
  assert.equal(state.set("bogus"), null);
  assert.equal(state.effort, "xhigh");
  assert.equal(normalizeEffortLevel("minimal"), null);
});

test("effort survives a restart and ignores a corrupt file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "effort-"));
  const file = path.join(dir, "effort.json");
  new EffortState({ file }).set("high");
  assert.equal(new EffortState({ file }).effort, "high");
  fs.writeFileSync(file, "{not json");
  assert.equal(new EffortState({ file }).effort, "medium");
});

test("withEffort replaces the client's reasoning control in every protocol", () => {
  const chat = withEffort({ model: "m", reasoning_effort: "low", reasoning: { effort: "low" } }, "openai-chat", "high");
  assert.equal(chat.reasoning_effort, "high");
  assert.equal("reasoning" in chat, false);

  const responses = withEffort({ model: "m", reasoning: { effort: "low", summary: "auto" } }, "openai-responses", "xhigh");
  assert.deepEqual(responses.reasoning, { effort: "xhigh", summary: "auto" });

  const gemini = withEffort({ generationConfig: { temperature: 1, thinkingConfig: { thinkingLevel: "low" } } }, "gemini", "medium");
  assert.deepEqual(gemini.generationConfig, { temperature: 1, thinkingConfig: { thinkingBudget: 4096 } });

  const anthropic = withEffort({ max_tokens: 32000, temperature: 0.2, top_p: 0.9, messages: [] }, "anthropic", "high");
  assert.deepEqual(anthropic.thinking, { type: "enabled", budget_tokens: 16384 });
  assert.equal("temperature" in anthropic, false);
  assert.equal("top_p" in anthropic, false);
});

test("withEffort leaves Anthropic thinking alone when it cannot be requested correctly", () => {
  const small = { max_tokens: 1000, messages: [] };
  assert.equal(withEffort(small, "anthropic", "high"), small);
  const forced = { max_tokens: 32000, tool_choice: { type: "tool", name: "x" }, messages: [] };
  assert.equal(withEffort(forced, "anthropic", "high"), forced);
  const toolTurn = { max_tokens: 32000, messages: [{ role: "assistant", content: [{ type: "tool_use", id: "1", name: "x", input: {} }] }] };
  assert.equal(withEffort(toolTurn, "anthropic", "high"), toolTurn);
  const withThinking = { max_tokens: 32000, messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "tool_use", id: "1", name: "x", input: {} }] }] };
  assert.equal(withEffort(withThinking, "anthropic", "low").thinking.budget_tokens, 1024);
});

test("xhigh carries a bigger budget and only reaches models that accept it as an effort string", () => {
  const body = withEffort({ model: "m" }, "openai-chat", "xhigh");
  assert.deepEqual(readReasoning(body, "openai-chat"), { effort: "xhigh", budget: 24576 });
  assert.equal(chatEffort({ effort: "xhigh" }, { model: "gpt-5.2" }), "xhigh");
  assert.equal(chatEffort({ effort: "xhigh" }, { model: "deepseek-reasoner" }), "high");
  assert.equal(chatEffort({ effort: "medium" }, { model: "deepseek-reasoner" }), "medium");
  assert.deepEqual(responsesReasoning({ effort: "xhigh" }, { model: "llama-3" }), { effort: "high" });
  assert.equal(readReasoning({ thinking: { type: "enabled", budget_tokens: 30000 } }, "anthropic").effort, "xhigh");
});
