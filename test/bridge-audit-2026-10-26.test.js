import test from "node:test";
import assert from "node:assert/strict";
import {
  streamToAnthropic, geminiJsonToAnthropic, openAIJsonToAnthropic, estimateInputTokens
} from "../src/anthropic-bridge.js";
import { toolCallKey } from "../src/bridge-utils.js";
import { isRetryableStatus } from "../src/router.js";

async function* gen(items) { for (const item of items) yield typeof item === "string" ? item : JSON.stringify(item); }
const collect = async (iterable) => { let out = ""; for await (const part of iterable) out += part; return out; };
const events = (text) => [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map((m) => ({ event: m[1], data: JSON.parse(m[2]) }));
const names = (text) => events(text).map((e) => e.event);

test("a stream cut off before any finish reason or [DONE] is an error, not a normal end_turn", async () => {
  const out = await collect(streamToAnthropic("openai-chat", gen([{ choices: [{ delta: { content: "Hel" } }] }]), "m"));
  assert.ok(names(out).includes("error"));
  assert.ok(!names(out).includes("message_stop"));
  assert.ok(!out.includes('"stop_reason":"end_turn"'));
});

test("a stream that finishes (finish_reason, or [DONE]) is still a normal completion", async () => {
  const withFinish = await collect(streamToAnthropic("openai-chat", gen([
    { choices: [{ delta: { content: "ok" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]), "m"));
  assert.ok(names(withFinish).includes("message_stop"));
  const withDone = await collect(streamToAnthropic("openai-chat", gen([{ choices: [{ delta: { content: "ok" } }] }, "[DONE]"]), "m"));
  assert.ok(names(withDone).includes("message_stop"));
});

test("a Gemini answer withheld for safety is reported as a refusal with a reason, not an empty end_turn", async () => {
  const json = geminiJsonToAnthropic({ promptFeedback: { blockReason: "SAFETY" } }, "m");
  assert.equal(json.stop_reason, "refusal");
  assert.match(json.content[0].text, /SAFETY/);
  const out = await collect(streamToAnthropic("gemini", gen([{ candidates: [{ finishReason: "SAFETY" }] }]), "m"));
  assert.match(out, /"stop_reason":"refusal"/);
  assert.match(out, /SAFETY/);
});

test("an OpenAI content_filter finish is reported as a refusal with a reason", () => {
  const json = openAIJsonToAnthropic({ choices: [{ message: { content: null }, finish_reason: "content_filter" }] }, "m");
  assert.equal(json.stop_reason, "refusal");
  assert.match(json.content[0].text, /content_filter/);
});

test("parallel tool calls that share index 0 but carry different ids stay separate", async () => {
  const out = await collect(streamToAnthropic("openai-chat", gen([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "f", arguments: '{"x":1}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "b", function: { name: "g", arguments: '{"y":2}' } }] }, finish_reason: "tool_calls" }] }
  ]), "m"));
  const starts = events(out).filter((e) => e.event === "content_block_start");
  assert.deepEqual(starts.map((e) => e.data.content_block.name), ["f", "g"]);
  const args = events(out).filter((e) => e.data.delta?.type === "input_json_delta").map((e) => e.data.delta.partial_json);
  assert.deepEqual(args, ['{"x":1}', '{"y":2}']);
});

test("toolCallKey: id-less fragments continue the call last opened on their index; ordinary indexes are unchanged", () => {
  const state = { last: null };
  assert.equal(toolCallKey({ index: 0, id: "a" }, state), 0);
  assert.equal(toolCallKey({ index: 0 }, state), 0);
  assert.equal(toolCallKey({ index: 1, id: "b" }, state), 1);
  assert.equal(toolCallKey({ index: 0, id: "c" }, state), "0#c");
  assert.equal(toolCallKey({ index: 0 }, state), "0#c");
  assert.equal(toolCallKey({ index: 0, id: "c" }, state), "0#c");
});

test("text that arrives while a tool call is open is written after the tool blocks, and blocks never overlap", async () => {
  const out = await collect(streamToAnthropic("openai-chat", gen([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: "{" } }] } }] },
    { choices: [{ delta: { content: "note" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish_reason: "tool_calls" }] }
  ]), "m"));
  const open = new Set();
  for (const { event, data } of events(out)) {
    if (event === "content_block_start") { assert.equal(open.size, 0, "a block started while another was open"); open.add(data.index); }
    if (event === "content_block_stop") open.delete(data.index);
  }
  assert.equal(open.size, 0);
  const tool = events(out).filter((e) => e.data.delta?.type === "input_json_delta").map((e) => e.data.delta.partial_json).join("");
  assert.equal(tool, "{}");
  assert.match(out, /"text":"note"/);
});

test("an upstream error mid-stream closes any open tool block before the error event", async () => {
  const out = await collect(streamToAnthropic("openai-chat", gen([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: "{" } }] } }] },
    { error: { message: "boom" } }
  ]), "m"));
  const order = names(out);
  assert.ok(order.indexOf("content_block_stop") !== -1 && order.indexOf("content_block_stop") < order.indexOf("error"));
});

test("count_tokens does not count base64 characters as text", () => {
  const body = { messages: [{ role: "user", content: [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(1_000_000) } },
    { type: "text", text: "hi" }] }] };
  const tokens = estimateInputTokens(body);
  assert.ok(tokens < 10000, `1 MB image estimated at ${tokens} tokens`);
  assert.ok(tokens > 100);
  assert.ok(estimateInputTokens({ messages: [{ role: "user", content: "x".repeat(4000) }] }) >= 1000);
});

test("media and realtime routes decide retryability from the configured codes", () => {
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(400, new Set([400])), true);
  assert.equal(isRetryableStatus(503, new Set([400])), false);
});

test("a content_filter answer that carries tool calls stays tool_use; without tools it is a refusal", () => {
  const call = { id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } };
  const withTools = openAIJsonToAnthropic({ choices: [{ message: { content: null, tool_calls: [call] }, finish_reason: "content_filter" }] }, "m");
  assert.equal(withTools.stop_reason, "tool_use");
  assert.ok(withTools.content.some((block) => block.type === "tool_use"));

  const plain = openAIJsonToAnthropic({ choices: [{ message: { content: null }, finish_reason: "content_filter" }] }, "m");
  assert.equal(plain.stop_reason, "refusal");
  assert.match(plain.content[0].text, /withheld/);
});
