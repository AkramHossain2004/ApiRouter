import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { buildGeminiRequest, translateGeminiResponse, pcmToWav, GeminiMediaError } from "../src/media-gemini.js";
import { multipartFields } from "../src/media-routes.js";

const CRLF = "\r\n";
const part = (headers, body) => ({ headers, body });
const field = (name, value) => part(`Content-Disposition: form-data; name="${name}"`, value);
const upload = (name, body, type = "audio/wav", filename = "a.wav") =>
  part(`Content-Disposition: form-data; name="${name}"; filename="${filename}"${CRLF}Content-Type: ${type}`, body);
function multipart(boundary, parts) {
  const out = [];
  for (const p of parts) {
    out.push(Buffer.from(`--${boundary}${CRLF}${p.headers}${CRLF}${CRLF}`, "latin1"), Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body), Buffer.from(CRLF));
  }
  out.push(Buffer.from(`--${boundary}--${CRLF}`));
  return Buffer.concat(out);
}
const declare = async (router, provider, model, capabilities, extra = {}, headers = { "content-type": "application/json" }) => {
  const response = await router.request("/api/model-config", { method: "POST", headers, body: JSON.stringify({ provider, model, capabilities, ...extra }) });
  assert.ok(response.status >= 200 && response.status < 300, await response.text());
};

/* ---------------------------------------------------------- Gemini adapter */

test("gemini: request shapes", () => {
  const target = { baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gem-embed", apiKey: "k" };
  const emb = buildGeminiRequest("/v1/embeddings", target, { body: { input: ["a", "b"], dimensions: 8 } });
  assert.equal(emb.url, "https://generativelanguage.googleapis.com/v1beta/models/gem-embed:batchEmbedContents");
  assert.equal(emb.headers["x-goog-api-key"], "k");
  const sent = JSON.parse(emb.body);
  assert.equal(sent.requests.length, 2);
  assert.equal(sent.requests[0].model, "models/gem-embed");
  assert.equal(sent.requests[0].outputDimensionality, 8);

  assert.throws(() => buildGeminiRequest("/v1/embeddings", target, { body: { input: [[1, 2, 3]] } }), GeminiMediaError);
  assert.throws(() => buildGeminiRequest("/v1/images/generations", { ...target, model: "gem-image" }, { body: { prompt: "p", n: 2 } }), GeminiMediaError);
  assert.equal(JSON.parse(buildGeminiRequest("/v1/images/generations", { ...target, model: "imagen-4" }, { body: { prompt: "p", n: 3 } }).body).parameters.sampleCount, 3);
  assert.throws(() => buildGeminiRequest("/v1/rerank", target, { body: {} }), GeminiMediaError);
});

test("gemini: responses are translated, empty and blocked answers are classified", () => {
  const ok = translateGeminiResponse({ kind: "embeddings", count: 1, base64: false, model: "m" }, 200, Buffer.from(JSON.stringify({ embeddings: [{ values: [1, 2] }] })));
  assert.deepEqual(JSON.parse(ok.body).data, [{ object: "embedding", index: 0, embedding: [1, 2] }]);
  const b64 = translateGeminiResponse({ kind: "embeddings", count: 1, base64: true }, 200, Buffer.from(JSON.stringify({ embeddings: [{ values: [1] }] })));
  assert.equal(Buffer.from(JSON.parse(b64.body).data[0].embedding, "base64").readFloatLE(0), 1);

  assert.equal(translateGeminiResponse({ kind: "speech" }, 200, Buffer.from("{}")).status, 502, "empty is retryable");
  assert.equal(translateGeminiResponse({ kind: "speech" }, 200, Buffer.from("not json")).status, 502);
  const blocked = translateGeminiResponse({ kind: "transcription", format: "json" }, 200, Buffer.from(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })));
  assert.equal(blocked.status, 400);
  assert.equal(JSON.parse(blocked.body).error.type, "content_blocked");
  const upstreamError = translateGeminiResponse({ kind: "speech" }, 429, Buffer.from(JSON.stringify({ error: { message: "quota" } })));
  assert.equal(upstreamError.status, 429);
  assert.equal(JSON.parse(upstreamError.body).error.message, "quota");
});

test("pcmToWav writes a valid 44-byte header", () => {
  const wav = pcmToWav(Buffer.alloc(100), 24000);
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.readUInt32LE(4), 136);
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt32LE(40), 100);
  assert.equal(wav.length, 144);
});

/* ------------------------------------------------------- Gemini end to end */

const IMG = Buffer.from("PNGDATA").toString("base64");
const PCM = Buffer.alloc(480, 1);
function geminiScript(record) {
  const url = record.url;
  if (url.includes(":batchEmbedContents")) return { status: 200, body: { embeddings: record.body.requests.map((_, i) => ({ values: [i, i + 0.5] })) } };
  if (url.includes(":predict")) return { status: 200, body: { predictions: [{ bytesBase64Encoded: IMG }, { bytesBase64Encoded: IMG }] } };
  if (url.includes("gem-image:generateContent")) return { status: 200, body: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: IMG } }] } }] } };
  if (url.includes("gem-tts:generateContent")) return { status: 200, body: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: PCM.toString("base64") } }] } }] } };
  if (url.includes("gem-audio:generateContent")) return { status: 200, body: { candidates: [{ content: { parts: [{ text: " hello there " }] } }] } };
  return { status: 404, body: {} };
}

async function startGemini(t, { script = geminiScript, extraEnv = {} } = {}) {
  const gemini = await startMockUpstream(script);
  const router = await startRouter({
    GEMINI_API_KEYS: "gk", GEMINI_MODELS: "gem-embed,imagen-x,gem-image,gem-tts,gem-audio", GEMINI_BASE_URL: gemini.baseUrl, ...extraEnv
  });
  t.after(async () => { await router.close(); await gemini.close(); });
  await declare(router, "gemini", "gem-embed", ["text_input", "text_output", "embeddings", "reranking", "moderation"]);
  await declare(router, "gemini", "imagen-x", ["text_input", "text_output", "image_output"]);
  await declare(router, "gemini", "gem-image", ["text_input", "text_output", "image_output"]);
  await declare(router, "gemini", "gem-tts", ["text_input", "text_output", "audio_output"]);
  await declare(router, "gemini", "gem-audio", ["text_input", "text_output", "audio_transcription", "audio_translation"]);
  const post = (path, body) => router.request(path, postJson(body));
  const calls = (fragment) => gemini.requests.filter((r) => r.method === "POST" && r.url.includes(fragment));
  return { router, gemini, post, calls };
}

test("gemini embeddings come back in the OpenAI shape", async (t) => {
  const h = await startGemini(t);
  const response = await h.post("/v1/embeddings", { model: "gem-embed", input: ["one", "two"] });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, "list");
  assert.deepEqual(body.data.map((d) => d.embedding), [[0, 0.5], [1, 1.5]]);
  assert.equal(body.model, "gem-embed");
  const [call] = h.calls(":batchEmbedContents");
  assert.equal(call.headers["x-goog-api-key"], "gk");
  assert.equal(call.body.requests[1].content.parts[0].text, "two");
});

test("gemini images: imagen uses :predict, other models use the image modality", async (t) => {
  const h = await startGemini(t);
  const imagen = await (await h.post("/v1/images/generations", { model: "imagen-x", prompt: "cat", n: 2 })).json();
  assert.equal(imagen.data.length, 2);
  assert.equal(imagen.data[0].b64_json, IMG);
  assert.equal(h.calls("imagen-x:predict")[0].body.parameters.sampleCount, 2);

  const flash = await (await h.post("/v1/images/generations", { model: "gem-image", prompt: "dog" })).json();
  assert.equal(flash.data[0].b64_json, IMG);
  assert.deepEqual(h.calls("gem-image:generateContent")[0].body.generationConfig.responseModalities, ["IMAGE"]);
});

test("gemini speech returns WAV and maps OpenAI voice names", async (t) => {
  const h = await startGemini(t);
  const response = await h.post("/v1/audio/speech", { model: "gem-tts", input: "hello", voice: "alloy" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/wav");
  const wav = Buffer.from(await response.arrayBuffer());
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.ok(wav.subarray(44).equals(PCM));
  const voice = (c) => c.body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName;
  assert.equal(voice(h.calls("gem-tts:generateContent")[0]), "Kore");
  await h.post("/v1/audio/speech", { model: "gem-tts", input: "hi", voice: "Puck" });
  assert.equal(voice(h.calls("gem-tts:generateContent")[1]), "Puck");
});

test("gemini transcription and translation send the audio inline", async (t) => {
  const h = await startGemini(t);
  const send = (path, extra = []) => h.router.request(path, {
    method: "POST", headers: { "content-type": "multipart/form-data; boundary=ZZ" },
    body: multipart("ZZ", [upload("file", "RIFFxxxx"), field("model", "gem-audio"), ...extra])
  });

  const transcript = await send("/v1/audio/transcriptions", [field("language", "bn")]);
  assert.equal(transcript.status, 200);
  assert.deepEqual(await transcript.json(), { text: "hello there" });
  const [call] = h.calls("gem-audio:generateContent");
  const [instruction, audio] = call.body.contents[0].parts;
  assert.match(instruction.text, /Transcribe/);
  assert.match(instruction.text, /bn/);
  assert.equal(audio.inline_data.mime_type, "audio/wav");
  assert.equal(Buffer.from(audio.inline_data.data, "base64").toString(), "RIFFxxxx");

  const translation = await send("/v1/audio/translations");
  assert.equal(translation.status, 200);
  assert.match(h.calls("gem-audio:generateContent")[1].body.contents[0].parts[0].text, /into English/);

  const asText = await send("/v1/audio/transcriptions", [field("response_format", "text")]);
  assert.equal(asText.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await asText.text(), "hello there");

  const srt = await send("/v1/audio/transcriptions", [field("response_format", "srt")]);
  assert.equal(srt.status, 400);
});

test("rerank and moderation never go to a Gemini model, even one that declares them", async (t) => {
  const h = await startGemini(t);
  const rerank = await h.post("/v1/rerank", { query: "q", documents: ["a"] });
  assert.equal(rerank.status, 503);
  assert.equal((await rerank.json()).error.type, "no_capable_route");
  assert.equal((await h.post("/v1/moderations", { input: "x" })).status, 503);
  assert.equal(h.gemini.apiRequests.length, 0);
});

test("a provider content block is a 400 and is not retried elsewhere", async (t) => {
  const h = await startGemini(t, { script: () => ({ status: 200, body: { promptFeedback: { blockReason: "SAFETY" } } }) });
  const response = await h.post("/v1/images/generations", { model: "gem-image", prompt: "x" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.type, "content_blocked");
  assert.equal(h.calls("gem-image").length, 1);
});

test("a request Gemini cannot express falls through to an OpenAI-wire model that can", async (t) => {
  const gemini = await startMockUpstream(geminiScript);
  const openai = await startMockUpstream(() => ({ status: 200, body: { created: 1, data: [{ b64_json: "OPENAI" }] } }));
  const router = await startRouter({
    GEMINI_API_KEYS: "gk", GEMINI_MODELS: "gem-image", GEMINI_BASE_URL: gemini.baseUrl,
    MISTRAL_API_KEYS: "mk", MISTRAL_MODELS: "oa-image", MISTRAL_BASE_URL: `${openai.baseUrl}/v1`
  });
  t.after(async () => { await router.close(); await gemini.close(); await openai.close(); });
  await declare(router, "gemini", "gem-image", ["text_input", "text_output", "image_output"]);
  await declare(router, "mistral", "oa-image", ["text_input", "text_output", "image_output"]);
  // n=2 cannot be expressed on this Gemini model (one image per call), so the OpenAI wire serves it.
  const response = await router.request("/v1/images/generations", postJson({ prompt: "p", n: 2 }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data[0].b64_json, "OPENAI");
  assert.equal(gemini.apiRequests.length, 0);
});

/* ------------------------------------------- Responses-only and Anthropic */

test("a Responses-only target is served over the OpenAI API root; an Anthropic-only one never is", async (t) => {
  const mock = await startMockUpstream(() => ({ status: 200, body: { object: "list", data: [{ object: "embedding", index: 0, embedding: [1] }] } }));
  const router = await startRouter({
    AGENTROUTER_API_KEYS: "ak", AGENTROUTER_MODELS: "resp-embed,anth-embed", AGENTROUTER_BASE_URL: `${mock.baseUrl}/v1`
  });
  t.after(async () => { await router.close(); await mock.close(); });
  await declare(router, "agentrouter", "resp-embed", ["text_input", "text_output", "embeddings"], { protocol: "openai-responses" });
  await declare(router, "agentrouter", "anth-embed", ["text_input", "text_output", "embeddings"], { protocol: "anthropic" });

  const served = await router.request("/v1/embeddings", postJson({ input: "x" }));
  assert.equal(served.status, 200);
  const [call] = mock.apiRequests;
  assert.equal(call.url, "/v1/embeddings");
  assert.equal(call.body.model, "resp-embed", "the Anthropic-only model is never the one called");

  mock.requests.length = 0;
  const refused = await router.request("/v1/embeddings", postJson({ model: "anth-embed", input: "x" }));
  assert.equal(refused.status, 400, "a known model with no wire for this is rejected, not silently replaced");
  assert.equal(mock.apiRequests.length, 0);
});

/* ---------------------------------------------------------------- realtime */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const acceptFor = (key) => createHash("sha1").update(key + WS_GUID).digest("base64");

/** An upstream that completes WebSocket handshakes (or answers `status`) and echoes bytes upper-cased. */
async function startWsUpstream(status = 101) {
  const seen = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    seen.push({ url: req.url, headers: req.headers });
    if (status !== 101) {
      socket.end(`HTTP/1.1 ${status} Nope\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
      return;
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(req.headers["sec-websocket-key"])}\r\n\r\n`);
    socket.on("data", (chunk) => socket.write(chunk.toString().toUpperCase()));
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "localhost", resolve));
  const { port } = server.address();
  return { seen, baseUrl: `http://localhost:${port}`, close: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.closeAllConnections?.(); server.close(resolve); }) };
}

function wsConnect(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "localhost", port });
    const key = Buffer.from("0123456789abcdef").toString("base64");
    let buffer = Buffer.alloc(0);
    let resolved = false;
    socket.on("error", (error) => { if (!resolved) reject(error); });
    socket.on("connect", () => {
      const lines = [`GET ${path} HTTP/1.1`, `Host: localhost:${port}`, "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13",
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
      socket.write(lines.join(CRLF) + CRLF + CRLF);
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1 || resolved) return;
      resolved = true;
      const head = buffer.subarray(0, end).toString();
      const body = buffer.subarray(end + 4);
      resolve({
        socket, key, head, status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]), body,
        next: () => new Promise((r) => socket.once("data", r))
      });
    });
    socket.on("close", () => { if (!resolved) { resolved = true; resolve({ socket, status: 0, head: "", body: Buffer.alloc(0), closed: true }); } });
  });
}

async function startRealtime(t, { upstreams, env = {}, declareAll = true }) {
  const names = upstreams.map((_, i) => `rt-${i}`);
  const router = await startRouter({
    GROQ_API_KEYS: "rk0", GROQ_MODELS: names[0] ?? "", GROQ_BASE_URL: upstreams[0] ? `${upstreams[0].baseUrl}/v1` : "",
    ...(upstreams[1] ? { MISTRAL_API_KEYS: "rk1", MISTRAL_MODELS: names[1], MISTRAL_BASE_URL: `${upstreams[1].baseUrl}/v1` } : {}),
    ...env
  });
  t.after(async () => { await router.close(); for (const u of upstreams) await u.close(); });
  const headers = { "content-type": "application/json", ...(env.APIROUTER_API_KEYS ? { authorization: `Bearer ${env.APIROUTER_API_KEYS}` } : {}) };
  if (declareAll) {
    await declare(router, "groq", names[0], ["text_input", "text_output", "realtime_audio"], {}, headers);
    if (upstreams[1]) await declare(router, "mistral", names[1], ["text_input", "text_output", "realtime_audio"], {}, headers);
  }
  return { router, names };
}

test("realtime: the upgrade is tunnelled with the target's model and key, and bytes flow both ways", async (t) => {
  const up = await startWsUpstream();
  const h = await startRealtime(t, { upstreams: [up] });
  const ws = await wsConnect(h.router.port, "/v1/realtime?model=client-model&intent=x");
  t.after(() => ws.socket.destroy());
  assert.equal(ws.status, 101);
  assert.match(ws.head, new RegExp(`Sec-WebSocket-Accept: ${acceptFor(ws.key).replace(/[+/=]/g, "\\$&")}`, "i"));

  assert.equal(up.seen.length, 1);
  const url = new URL(up.seen[0].url, "http://x");
  assert.equal(url.pathname, "/v1/realtime");
  assert.equal(url.searchParams.get("model"), h.names[0], "upstream gets the target's model, not the client's");
  assert.equal(url.searchParams.get("intent"), "x", "other query parameters survive");
  assert.equal(up.seen[0].headers.authorization, "Bearer rk0");

  const echoed = ws.next();
  ws.socket.write("ping");
  assert.equal((await echoed).toString(), "PING");
});

test("realtime: a failed handshake falls through to the next capable model", async (t) => {
  const bad = await startWsUpstream(503);
  const good = await startWsUpstream(101);
  const h = await startRealtime(t, { upstreams: [bad, good] });
  const ws = await wsConnect(h.router.port, "/v1/realtime");
  t.after(() => ws.socket.destroy());
  assert.equal(ws.status, 101);
  assert.equal(good.seen.length, 1);
  assert.ok(bad.seen.length <= 1);
});

test("realtime: a client error from the upstream is relayed, not retried", async (t) => {
  const rejecting = await startWsUpstream(400);
  const good = await startWsUpstream(101);
  const h = await startRealtime(t, { upstreams: [rejecting, good] });
  const ws = await wsConnect(h.router.port, `/v1/realtime?model=${h.names[0]}`);
  t.after(() => ws.socket.destroy());
  assert.equal(ws.status, 400);
  assert.equal(good.seen.length, 0);
});

test("realtime: no model declares it -> 503 and nothing is dialled", async (t) => {
  const up = await startWsUpstream();
  const h = await startRealtime(t, { upstreams: [up], declareAll: false });
  const ws = await wsConnect(h.router.port, "/v1/realtime");
  t.after(() => ws.socket.destroy());
  assert.equal(ws.status, 503);
  assert.equal(JSON.parse(ws.body.toString() || ws.head.split("\r\n\r\n")[1] || "{}").error?.type ?? "no_capable_route", "no_capable_route");
  assert.equal(up.seen.length, 0);
});

test("realtime: the router API key is required", async (t) => {
  const up = await startWsUpstream();
  const h = await startRealtime(t, { upstreams: [up], env: { APIROUTER_API_KEYS: "sk" } });
  const denied = await wsConnect(h.router.port, "/v1/realtime");
  t.after(() => denied.socket.destroy());
  assert.equal(denied.status, 401);
  assert.equal(up.seen.length, 0);
  const allowed = await wsConnect(h.router.port, "/v1/realtime", { authorization: "Bearer sk" });
  t.after(() => allowed.socket.destroy());
  assert.equal(allowed.status, 101);
});

test("other upgrade paths are still dropped", async (t) => {
  const up = await startWsUpstream();
  const h = await startRealtime(t, { upstreams: [up] });
  const ws = await wsConnect(h.router.port, "/v1/chat/completions");
  assert.ok(ws.closed || ws.status === 0, "connection is closed without a handshake");
  assert.equal(up.seen.length, 0);
});

test("multipartFields still sees a file's own content type", () => {
  const fields = multipartFields(multipart("Q", [upload("file", "x", "audio/ogg", "v.ogg")]), "Q");
  assert.match(fields.get("file").headers, /audio\/ogg/);
});
