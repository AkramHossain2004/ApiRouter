import test from "node:test";
import assert from "node:assert/strict";
import { isModelRejection } from "../src/model-rejection.js";
import { toChatFromGemini } from "../src/gemini-bridge.js";
import { toOpenAIChatRequest } from "../src/anthropic-bridge.js";
import { geminiJsonToChat, streamToChat } from "../src/chat-bridge.js";
import { geminiJsonToResponses, openAIJsonToResponses, streamToResponses } from "../src/codex-bridge.js";
import { isBlockedAddress } from "../src/custom-playground.js";

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}
async function* events(...items) { for (const item of items) yield item; }
const parseData = (frames) => frames
  .flatMap((frame) => String(frame).split("\n\n"))
  .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
  .filter(Boolean)
  .map((line) => line.slice(6));

// ---------------------------------------------------------------- model rejection

test("a 400 about the model id is a model rejection", () => {
  for (const message of [
    "The model `gpt-x` does not exist",
    "model_not_found",
    "Invalid model: foo",
    "Unknown model gemini-9",
    "The requested model is not supported",
    "Could not find model xyz"
  ]) assert.equal(isModelRejection(message), true, message);
});

test("a 400 about a request parameter that merely mentions the model is not", () => {
  for (const message of [
    "Unsupported parameter: temperature is not supported with this model",
    "Invalid value for max_tokens: this model supports at most 4096",
    "tools are not supported by this model",
    "Invalid schema in tools for model gpt-4o",
    "messages: roles must alternate"
  ]) assert.equal(isModelRejection(message), false, message);
});

// ---------------------------------------------------------------- request translation

test("Gemini -> OpenAI sends at most 4 stop sequences", () => {
  const out = toChatFromGemini({
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    generationConfig: { stopSequences: ["a", "b", "c", "d", "e"] }
  }, "m");
  assert.deepEqual(out.stop, ["a", "b", "c", "d"]);
});

test("an Anthropic image with no base64 data and no URL is refused, not sent as empty text", () => {
  const body = {
    messages: [{ role: "user", content: [
      { type: "text", text: "what is this?" },
      { type: "image", source: { type: "file", file_id: "file_123" } }
    ] }]
  };
  assert.throws(() => toOpenAIChatRequest(body, "m"), (error) => {
    assert.equal(error.name, "UnsupportedMediaError");
    assert.equal(error.status, 400);
    assert.equal(error.retryable, true);
    return true;
  });
});

// ---------------------------------------------------------------- withheld answers

test("a Gemini answer withheld for safety is a content_filter chat completion", () => {
  const json = geminiJsonToChat({ candidates: [{ finishReason: "SAFETY" }] }, "m");
  assert.equal(json.choices[0].finish_reason, "content_filter");
  const prompt = geminiJsonToChat({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }, "m");
  assert.equal(prompt.choices[0].finish_reason, "content_filter");
});

test("a normal Gemini answer is still a plain stop", () => {
  const json = geminiJsonToChat({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "hello" }] } }] }, "m");
  assert.equal(json.choices[0].finish_reason, "stop");
});

test("a Gemini answer withheld for safety is an incomplete Responses object", () => {
  const response = geminiJsonToResponses({ candidates: [{ finishReason: "SAFETY" }] }, "m");
  assert.equal(response.status, "incomplete");
  assert.equal(response.incomplete_details.reason, "content_filter");
});

test("an OpenAI content_filter with no output is an incomplete Responses object", () => {
  const response = openAIJsonToResponses({ choices: [{ finish_reason: "content_filter", message: { content: "" } }] }, "m");
  assert.equal(response.status, "incomplete");
  assert.equal(response.incomplete_details.reason, "content_filter");
});

test("a blocked Gemini stream ends the chat stream with content_filter", async () => {
  const frames = await collect(streamToChat("gemini", events(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })), "m"));
  const reasons = parseData(frames).filter((d) => d !== "[DONE]").map((d) => JSON.parse(d).choices?.[0]?.finish_reason).filter(Boolean);
  assert.deepEqual(reasons, ["content_filter"]);
});

// ---------------------------------------------------------------- truncated streams

test("a Gemini stream that dies before a finish reason is an error, not a clean stop", async () => {
  const frames = await collect(streamToChat("gemini", events(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "half an ans" }] } }] })
  ), "m"));
  const payloads = parseData(frames).filter((d) => d !== "[DONE]").map((d) => JSON.parse(d));
  assert.ok(payloads.some((p) => p.error), "an error event is sent");
  assert.ok(!payloads.some((p) => p.choices?.[0]?.finish_reason === "stop"), "no clean stop is claimed");
});

test("a complete Gemini stream still finishes normally", async () => {
  const frames = await collect(streamToChat("gemini", events(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] })
  ), "m"));
  const payloads = parseData(frames).filter((d) => d !== "[DONE]").map((d) => JSON.parse(d));
  assert.ok(payloads.some((p) => p.choices?.[0]?.finish_reason === "stop"));
  assert.ok(!payloads.some((p) => p.error));
});

test("a chat stream that dies before a finish reason fails the Responses stream", async () => {
  const frames = await collect(streamToResponses("openai-chat", events(
    JSON.stringify({ choices: [{ delta: { content: "half" } }] })
  ), "m"));
  const types = parseData(frames).map((d) => JSON.parse(d).type);
  assert.ok(types.includes("response.failed"));
  assert.ok(!types.includes("response.completed"));
});

test("a finished chat stream still completes the Responses stream", async () => {
  const frames = await collect(streamToResponses("openai-chat", events(
    JSON.stringify({ choices: [{ delta: { content: "hi" } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    "[DONE]"
  ), "m"));
  const types = parseData(frames).map((d) => JSON.parse(d).type);
  assert.ok(types.includes("response.completed"));
  assert.ok(!types.includes("response.failed"));
});

test("a blocked Gemini stream ends the Responses stream as incomplete (content_filter)", async () => {
  const frames = await collect(streamToResponses("gemini", events(
    JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })
  ), "m"));
  const last = parseData(frames).map((d) => JSON.parse(d)).at(-1);
  assert.equal(last.type, "response.incomplete");
  assert.equal(last.response.incomplete_details.reason, "content_filter");
});

// ---------------------------------------------------------------- address policy

test("a 6to4 address embedding a private IPv4 address is blocked", () => {
  assert.equal(isBlockedAddress("2002:7f00:1::"), true);
  assert.equal(isBlockedAddress("2002:a00:1::"), true);
});
