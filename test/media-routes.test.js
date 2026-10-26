import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";
import {
  MEDIA_ROUTES,
  isMediaRoute,
  multipartBoundary,
  multipartFields,
  withMultipartModel
} from "../src/media-routes.js";

/* ------------------------------------------------------------------ units */

const CRLF = "\r\n";
function multipart(boundary, parts) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}${CRLF}${part.headers}${CRLF}${CRLF}`, "latin1"));
    chunks.push(Buffer.isBuffer(part.body) ? part.body : Buffer.from(part.body, "utf8"));
    chunks.push(Buffer.from(CRLF));
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`));
  return Buffer.concat(chunks);
}
const field = (name, value) => ({ headers: `Content-Disposition: form-data; name="${name}"`, body: value });
const file = (name, body) => ({
  headers: `Content-Disposition: form-data; name="${name}"; filename="a.wav"${CRLF}Content-Type: audio/wav`,
  body
});

test("all seven endpoints are registered, and nothing else is", () => {
  assert.deepEqual(Object.keys(MEDIA_ROUTES).sort(), [
    "/v1/audio/speech", "/v1/audio/transcriptions", "/v1/audio/translations",
    "/v1/embeddings", "/v1/images/generations", "/v1/moderations", "/v1/rerank"
  ]);
  assert.equal(isMediaRoute("/v1/chat/completions"), false);
  assert.equal(isMediaRoute("/v1/realtime"), false);
});

test("multipartBoundary reads quoted and bare boundaries", () => {
  assert.equal(multipartBoundary('multipart/form-data; boundary="abc 123"'), "abc 123");
  assert.equal(multipartBoundary("multipart/form-data; boundary=xyz"), "xyz");
  assert.equal(multipartBoundary("application/json"), null);
});

test("withMultipartModel swaps the model field and keeps binary bytes exactly", () => {
  const audio = Buffer.from([0xff, 0xfe, 0x00, 0x0d, 0x0a, 0x2d, 0x2d, 0x80, 0x00]);
  const raw = multipart("B0UND", [file("file", audio), field("model", "client-model"), field("language", "en")]);
  const out = withMultipartModel(raw, "B0UND", "target-model");
  const fields = multipartFields(out, "B0UND");
  assert.equal(fields.get("model").body.toString(), "target-model");
  assert.equal(fields.get("language").body.toString(), "en");
  assert.ok(fields.get("file").body.equals(audio), "file bytes are untouched");
  assert.ok(!out.toString("latin1").includes("client-model"));
});

test("withMultipartModel adds a missing model and drops duplicates", () => {
  const raw = multipart("B", [file("file", "x")]);
  assert.equal(multipartFields(withMultipartModel(raw, "B", "m1"), "B").get("model").body.toString(), "m1");

  const dup = multipart("B", [field("model", "a"), field("model", "b"), file("file", "x")]);
  const out = withMultipartModel(dup, "B", "m2").toString("latin1");
  assert.equal(out.match(/name="model"/g).length, 1);
  assert.ok(!out.includes("\r\n\r\na\r\n") && !out.includes("\r\n\r\nb\r\n"));
});

test("a malformed multipart body is a 400, not a crash", () => {
  assert.throws(() => multipartFields(Buffer.from("not multipart"), "B"), (e) => e.status === 400);
  assert.throws(() => multipartFields(Buffer.from(`--B${CRLF}Content-Disposition: form-data; name="a"${CRLF}${CRLF}x`), "B"), (e) => e.status === 400);
});

/* -------------------------------------------------------------------- e2e */

const ALL_MEDIA = [
  "text_input", "text_output", "embeddings", "reranking", "moderation",
  "image_output", "audio_output", "audio_transcription", "audio_translation"
];
const json200 = (body) => () => ({ status: 200, body });

async function start(t, { chat = (r) => (r.url.includes("embeddings") ? { status: 200, body: { from: "embed-a" } } : { status: 200, body: { ok: "chat" } }), media, env = {}, declareMedia = true } = {}) {
  const chatMock = await startMockUpstream(chat);
  const mediaMock = await startMockUpstream(media ?? json200({ from: "embed-b" }));
  const router = await startRouter({
    GROQ_API_KEYS: "g0", GROQ_MODELS: "chat-model,embed-a", GROQ_BASE_URL: `${chatMock.baseUrl}/v1`,
    MISTRAL_API_KEYS: "m0", MISTRAL_MODELS: "embed-b", MISTRAL_BASE_URL: `${mediaMock.baseUrl}/v1`,
    ...env
  });
  // groq serves chat-model and embed-a from one base URL (one mock); mistral serves embed-b.
  t.after(async () => { await router.close(); await chatMock.close(); await mediaMock.close(); });

  const headers = { "content-type": "application/json", ...(env.APIROUTER_API_KEYS ? { authorization: `Bearer ${env.APIROUTER_API_KEYS}` } : {}) };
  const declare = async (provider, model, capabilities) => {
    const response = await router.request("/api/model-config", { method: "POST", headers, body: JSON.stringify({ provider, model, capabilities }) });
    assert.ok(response.status >= 200 && response.status < 300, await response.text());
  };
  await declare("groq", "chat-model", ["text_input", "text_output", "streaming"]);
  if (declareMedia) {
    await declare("groq", "embed-a", ["text_input", "text_output", "embeddings"]);
    await declare("mistral", "embed-b", ALL_MEDIA);
  }
  const post = (path, body, extra = {}) => router.request(path, { ...postJson(body, extra) });
  const hits = (mock, fragment) => mock.requests.filter((r) => r.method === "POST" && r.url.includes(fragment));
  return { router, chatMock, mediaMock, post, hits, headers };
}

test("embeddings: a text-only model is never tried, the capable one gets ITS model id", async (t) => {
  const h = await start(t);
  const response = await h.post("/v1/embeddings", { model: "anything", input: "hello" });
  assert.equal(response.status, 200);
  const [call] = h.hits(h.mediaMock, "embeddings").concat(h.hits(h.chatMock, "embeddings"));
  assert.ok(call, "an upstream embeddings call was made");
  assert.ok(["embed-a", "embed-b"].includes(call.body.model), "upstream gets the target's id, not the client's");
  assert.equal(call.body.input, "hello");
  assert.equal(call.headers.authorization.startsWith("Bearer "), true);
  // chat-model is text-only: no call may carry its id.
  for (const mock of [h.chatMock, h.mediaMock]) {
    for (const r of mock.apiRequests) assert.notEqual(r.body?.model, "chat-model");
  }
});

test("a named capable model narrows the walk to that model", async (t) => {
  const h = await start(t);
  const response = await h.post("/v1/embeddings", { model: "embed-b", input: "x" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { from: "embed-b" });
  assert.equal(h.hits(h.chatMock, "embeddings").length, 0, "the other provider is not touched");
  assert.equal(h.hits(h.mediaMock, "embeddings")[0].body.model, "embed-b");
});

test("a known model that cannot do this is a 400, never silently replaced", async (t) => {
  const h = await start(t);
  const response = await h.post("/v1/embeddings", { model: "chat-model", input: "x" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.type, "model_capability_mismatch");
  assert.equal(h.mediaMock.apiRequests.length, 0);
});

test("falls back to the next capable model on a retryable failure, and cools the failed one down", async (t) => {
  const h = await start(t, {
    chat: (r) => (r.url.includes("embeddings") ? { status: 500, body: { error: "down" } } : { status: 200, body: {} }),
    media: json200({ from: "embed-b" })
  });
  // embed-a (groq) always 500s; embed-b (mistral) serves. Start by naming neither.
  const first = await h.post("/v1/embeddings", { input: "x" });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { from: "embed-b" });
  const failedCalls = h.hits(h.chatMock, "embeddings").length;
  assert.ok(failedCalls <= 1);
  await h.post("/v1/embeddings", { input: "y" });
  assert.equal(h.hits(h.chatMock, "embeddings").length, failedCalls, "a cooled-down model is not retried");
});

test("a client error (400) is relayed as-is and does not fall through", async (t) => {
  const h = await start(t, {
    chat: (r) => (r.url.includes("embeddings") ? { status: 400, body: { error: { message: "bad input" } } } : { status: 200, body: {} })
  });
  const response = await h.post("/v1/embeddings", { model: "embed-a", input: "x" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.message, "bad input");
  assert.equal(h.hits(h.mediaMock, "embeddings").length, 0, "no second model is asked");
});

test("when every capable model fails the client gets 502 upstream_failed", async (t) => {
  const down = (r) => (r.url.includes("/v1/") ? { status: 503, body: {} } : { status: 200, body: {} });
  const h = await start(t, { chat: down, media: down });
  const response = await h.post("/v1/embeddings", { input: "x" });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.type, "upstream_failed");
  assert.ok(Array.isArray(body.error.attempts) && body.error.attempts.length >= 1);
});

test("rerank, moderations and images are forwarded to the capable model on the right path", async (t) => {
  const h = await start(t);
  for (const [path, body, fragment] of [
    ["/v1/rerank", { query: "q", documents: ["a", "b"] }, "/v1/rerank"],
    ["/v1/moderations", { input: "text" }, "/v1/moderations"],
    ["/v1/images/generations", { prompt: "a cat" }, "/v1/images/generations"]
  ]) {
    const response = await h.post(path, body);
    assert.equal(response.status, 200, path);
    const call = h.mediaMock.apiRequests.find((r) => r.url === fragment);
    assert.ok(call, `${path} reached the upstream`);
    assert.equal(call.body.model, "embed-b");
  }
  assert.equal(h.chatMock.apiRequests.length, 0, "models that declare none of these are never called");
});

test("speech returns the upstream audio byte for byte with its content type", async (t) => {
  const audio = Buffer.from([0x49, 0x44, 0x33, 0x00, 0xff, 0xfb, 0x90, 0x00, 0x0d, 0x0a, 0x80]);
  const h = await start(t, { media: () => ({ status: 200, headers: { "content-type": "audio/mpeg" }, body: audio }) });
  const response = await h.post("/v1/audio/speech", { input: "hello", voice: "alloy" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(audio));
  assert.equal(h.mediaMock.apiRequests[0].body.voice, "alloy", "other fields pass through");
});

for (const [path, upstreamPath] of [
  ["/v1/audio/transcriptions", "/v1/audio/transcriptions"],
  ["/v1/audio/translations", "/v1/audio/translations"]
]) {
  test(`${path}: multipart upload is forwarded with the target's model and the file intact`, async (t) => {
    const h = await start(t, { media: json200({ text: "hello world" }) });
    const raw = multipart("XBOUNDARYX", [file("file", "RIFFwavdata"), field("model", "whisper-client"), field("language", "en")]);
    const response = await h.router.request(path, {
      method: "POST", headers: { "content-type": "multipart/form-data; boundary=XBOUNDARYX" }, body: raw
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "hello world" });
    const call = h.mediaMock.apiRequests.find((r) => r.url === upstreamPath);
    assert.ok(call, "reached the upstream path");
    assert.match(call.headers["content-type"], /^multipart\/form-data; boundary=XBOUNDARYX/);
    const fields = multipartFields(Buffer.from(call.rawBody, "utf8"), "XBOUNDARYX");
    assert.equal(fields.get("model").body.toString(), "embed-b");
    assert.equal(fields.get("language").body.toString(), "en");
    assert.equal(fields.get("file").body.toString(), "RIFFwavdata");
  });
}

test("an upload that is not multipart, or has no file, is rejected locally", async (t) => {
  const h = await start(t);
  const asJson = await h.post("/v1/audio/transcriptions", { model: "x" });
  assert.equal(asJson.status, 400);
  const noFile = await h.router.request("/v1/audio/transcriptions", {
    method: "POST", headers: { "content-type": "multipart/form-data; boundary=B" }, body: multipart("B", [field("model", "m")])
  });
  assert.equal(noFile.status, 400);
  assert.equal(h.mediaMock.apiRequests.length, 0);
});

test("missing required fields and bad JSON are 400s that never reach an upstream", async (t) => {
  const h = await start(t);
  assert.equal((await h.post("/v1/embeddings", { model: "embed-b" })).status, 400);
  assert.equal((await h.post("/v1/rerank", { query: "q" })).status, 400);
  assert.equal((await h.post("/v1/images/generations", {})).status, 400);
  assert.equal((await h.post("/v1/moderations", "{not json")).status, 400);
  assert.equal(h.mediaMock.apiRequests.length + h.chatMock.apiRequests.length, 0);
});

test("with no model declaring the capability the answer is 503 no_capable_route and nothing is sent", async (t) => {
  const h = await start(t, { declareMedia: false });
  for (const [path, body] of [
    ["/v1/embeddings", { input: "x" }], ["/v1/rerank", { query: "q", documents: ["a"] }],
    ["/v1/moderations", { input: "x" }], ["/v1/images/generations", { prompt: "p" }], ["/v1/audio/speech", { input: "x" }]
  ]) {
    const response = await h.post(path, body);
    assert.equal(response.status, 503, path);
    assert.equal((await response.json()).error.type, "no_capable_route");
  }
  assert.equal(h.mediaMock.apiRequests.length + h.chatMock.apiRequests.length, 0);
});

test("the router API key is enforced", async (t) => {
  const h = await start(t, { env: { APIROUTER_API_KEYS: "secret-key" } });
  const denied = await h.router.request("/v1/embeddings", postJson({ input: "x" }));
  assert.equal(denied.status, 401);
  const allowed = await h.router.request("/v1/embeddings", postJson({ input: "x" }, { authorization: "Bearer secret-key" }));
  assert.equal(allowed.status, 200);
});

test("the request body limit applies", async (t) => {
  const h = await start(t, { env: { MAX_REQUEST_BODY_BYTES: "2000" } });
  const response = await h.post("/v1/embeddings", { input: "x".repeat(5000) });
  assert.equal(response.status, 413);
  assert.equal(h.mediaMock.apiRequests.length + h.chatMock.apiRequests.length, 0);
});
