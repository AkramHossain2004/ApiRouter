import test from "node:test";
import assert from "node:assert/strict";
import {
  applyFallbackNotice,
  applyOutputModalities,
  capabilityFallbackNotice,
  detectOutputIntent
} from "../src/intent-detect.js";

const chat = (text, extra = {}) => ({ operation: "chat", body: { messages: [{ role: "user", content: text }], ...extra } });
const outputs = (text, extra) => detectOutputIntent(chat(text, extra)).outputs;

test("only the listed image phrases are an image request", () => {
  for (const text of [
    "create a image", "create a photo", "create photo", "create image",
    "genarete a photo", "genarete a image", "genarete photo", "genarete image",
    "generate a photo", "generate a image", "generate photo", "generate image",
    "Create A Photo", "please create a photo of a cat", "create   image"
  ]) {
    assert.deepEqual(outputs(text), ["image_output"], text);
  }
});

test("anything else is left to the text model", () => {
  for (const text of [
    "give me an image of a sunset", "I want a picture of a cat", "I need a logo for my shop",
    "make a photo", "draw an image of a cat", "create a logo", "create a beautiful photo",
    "generate an image", "generate images", "create an image", "create images",
    "create photos", "creat a photo", "create videos", "generate videos",
    "Create aphoto", "create a image2",
    "I need to update the files", "convert this to a pdf", "export the data to xlsx",
    "generate a voice-over for this script", "create a PDF file with my notes",
    "produce a photo for me", "turn this text into a picture", "please produce an illustration from this text"
  ]) {
    const intent = detectOutputIntent(chat(text));
    assert.deepEqual([intent.outputs, intent.unsupported], [[], []], text);
  }
});

test("one message can ask for an image and a video", () => {
  const intent = detectOutputIntent(chat("create image of a cat. Then genarete video of it"));
  assert.deepEqual(intent.outputs, ["image_output"]);
  assert.deepEqual(intent.unsupported, ["video"]);
});

test("questions about a thing are not requests for it", () => {
  assert.deepEqual(outputs("How does video compression work?"), []);
  assert.deepEqual(outputs("explain what a PDF file is"), []);
  assert.deepEqual(outputs("how to edit a video"), []);
  assert.deepEqual(outputs("hello, how are you"), []);
});

test("agent clients with tools and non-chat operations are never inferred", () => {
  assert.deepEqual(outputs("create a file src/app.js", { tools: [{ type: "function", function: { name: "write" } }] }), []);
  assert.deepEqual(detectOutputIntent({ operation: "embeddings", body: chat("make a video").body }).outputs, []);
});

test("only the latest user message counts", () => {
  const body = { messages: [
    { role: "user", content: "make a video" },
    { role: "assistant", content: "sorry" },
    { role: "user", content: "thanks, what time is it?" }
  ] };
  assert.deepEqual(detectOutputIntent({ operation: "chat", body }).outputs, []);
});

test("the fallback notice names the missing output and is added in each protocol's own field", () => {
  const notice = capabilityFallbackNotice(["image_output"]);
  assert.match(notice, /image/);
  assert.equal(capabilityFallbackNotice([]), "");

  const chatBody = { messages: [{ role: "user", content: "x" }] };
  applyFallbackNotice("openai-chat", chatBody, notice);
  assert.equal(chatBody.messages[0].role, "system");
  assert.equal(chatBody.messages.length, 2);

  const anth = { system: "be brief", messages: [] };
  applyFallbackNotice("anthropic", anth, notice);
  assert.ok(anth.system.startsWith(notice) && anth.system.endsWith("be brief"));

  const resp = { input: "x" };
  applyFallbackNotice("openai-responses", resp, notice);
  assert.equal(resp.instructions, notice);

  const gem = { contents: [], systemInstruction: { parts: [{ text: "old" }] } };
  applyFallbackNotice("gemini", gem, notice);
  assert.equal(gem.systemInstruction.parts.length, 2);
  assert.equal(gem.systemInstruction.parts[0].text, notice);
});

test("output modalities are requested only in the chat and Gemini wire forms", () => {
  const chatBody = {};
  assert.equal(applyOutputModalities("openai-chat", chatBody, ["image_output"]), true);
  assert.deepEqual(chatBody.modalities, ["image", "text"]);

  const keep = { modalities: ["text"] };
  assert.equal(applyOutputModalities("openai-chat", keep, ["image_output"]), false);
  assert.deepEqual(keep.modalities, ["text"]);

  const gem = {};
  applyOutputModalities("gemini", gem, ["image_output"]);
  assert.deepEqual(gem.generationConfig.responseModalities, ["TEXT", "IMAGE"]);

  assert.equal(applyOutputModalities("anthropic", {}, ["image_output"]), false);
});

test("only the listed video phrases are a video request, reported as unsupported (not a capability)", () => {
  const unsupported = (text, extra) => detectOutputIntent(chat(text, extra)).unsupported;
  for (const text of ["create video", "create a video", "genarete video", "genarete a video", "generate video", "generate a video", "Create Video of a cat"]) {
    assert.deepEqual(unsupported(text), ["video"], text);
  }
  assert.deepEqual(outputs("create video"), []);
  // Other wording, questions and agent clients (own write-file tool) are left alone.
  for (const text of ["create videos", "make a video", "produce a video", "explain how video compression works", "how do I create video"]) {
    assert.deepEqual(unsupported(text), [], text);
  }
  assert.deepEqual(unsupported("create video", { tools: [{ type: "function", function: { name: "write" } }] }), []);
  assert.match(capabilityFallbackNotice(["video"]), /video/);
});

test("a question is never turned into a request", () => {
  assert.deepEqual(outputs("explain how to create photo"), []);
  assert.deepEqual(outputs("how do I create image"), []);
});
