import test from "node:test";
import assert from "node:assert/strict";
import { geminiJsonToChat, streamToChat, toGeminiFromChat } from "../src/chat-bridge.js";

const PNG = "iVBORw0KGgo=";
const gemini = (parts) => ({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });

test("chat modalities become Gemini responseModalities; text-only requests add nothing", () => {
  const withImage = toGeminiFromChat({ messages: [{ role: "user", content: "cat" }], modalities: ["image", "text"] });
  assert.deepEqual(withImage.generationConfig.responseModalities, ["TEXT", "IMAGE"]);
  const both = toGeminiFromChat({ messages: [{ role: "user", content: "x" }], modalities: ["text", "audio", "image"] });
  assert.deepEqual(both.generationConfig.responseModalities, ["TEXT", "IMAGE", "AUDIO"]);
  assert.equal(toGeminiFromChat({ messages: [{ role: "user", content: "x" }], modalities: ["text"] }).generationConfig, undefined);
  assert.equal(toGeminiFromChat({ messages: [{ role: "user", content: "x" }] }).generationConfig, undefined);
});

test("an image the Gemini model generated reaches the chat client instead of being dropped", () => {
  const out = geminiJsonToChat(gemini([{ text: "here" }, { inlineData: { mimeType: "image/png", data: PNG } }]), "m");
  const message = out.choices[0].message;
  assert.equal(message.content, "here");
  assert.equal(message.images.length, 1);
  assert.equal(message.images[0].image_url.url, `data:image/png;base64,${PNG}`);
});

test("generated audio is returned as message.audio; an image-only answer has empty text", () => {
  const audio = geminiJsonToChat(gemini([{ inlineData: { mimeType: "audio/mpeg", data: "AAA" } }]), "m").choices[0].message;
  assert.deepEqual(audio.audio, { data: "AAA", format: "mp3" });
  const image = geminiJsonToChat(gemini([{ inlineData: { mimeType: "image/jpeg", data: PNG } }]), "m").choices[0].message;
  assert.equal(image.content, "");
  assert.equal(image.images.length, 1);
});

test("streamed Gemini images arrive as delta.images", async () => {
  const events = (async function* () {
    yield JSON.stringify(gemini([{ inlineData: { mimeType: "image/png", data: PNG } }]));
  })();
  let joined = "";
  for await (const chunk of streamToChat("gemini", events, "m", {})) joined += chunk;
  assert.match(joined, /"images":\[\{"index":0,"type":"image_url"/);
  assert.ok(joined.includes(`data:image/png;base64,${PNG}`));
});

test("an inline video reaches Gemini; a remote video is refused instead of silently dropped", () => {
  const inline = toGeminiFromChat({ messages: [{ role: "user", content: [
    { type: "text", text: "describe" },
    { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } }
  ] }] });
  const parts = inline.contents[0].parts;
  assert.equal(parts.length, 2);
  assert.equal(parts[1].inlineData.mimeType, "video/mp4");

  assert.throws(
    () => toGeminiFromChat({ messages: [{ role: "user", content: [{ type: "video_url", video_url: { url: "https://example.com/a.mp4" } }] }] }),
    (error) => error.retryable === true && error.skipCooldown === true && /video/i.test(error.message)
  );
});
