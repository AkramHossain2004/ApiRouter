/**
 * Gemini wire for the dedicated media endpoints (see media-routes.js).
 *
 * Gemini has no OpenAI-shaped embeddings / images / speech / transcription
 * route, so each request is translated to the native REST call and the answer
 * is translated back to the OpenAI shape the client expects.
 *
 *   /v1/embeddings            -> models/{m}:batchEmbedContents
 *   /v1/images/generations    -> models/{m}:predict (imagen*) | :generateContent (IMAGE modality)
 *   /v1/audio/speech          -> :generateContent (AUDIO modality), 24 kHz PCM wrapped as WAV
 *   /v1/audio/transcriptions  -> :generateContent with the audio inline + a transcribe instruction
 *   /v1/audio/translations    -> :generateContent with the audio inline + a translate-to-English instruction
 *
 * Not offered by Gemini, so never routed here: /v1/rerank, /v1/moderations.
 */
import { stripApiVersion } from "./url-utils.js";

/** Routes the Gemini wire can serve. */
export const GEMINI_MEDIA_PATHS = Object.freeze([
  "/v1/embeddings", "/v1/images/generations", "/v1/audio/speech",
  "/v1/audio/transcriptions", "/v1/audio/translations"
]);

const OPENAI_VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"]);
const DEFAULT_GEMINI_VOICE = "Kore";
const MAX_EMBEDDING_INPUTS = 100;
const MAX_IMAGES = 4;

const AUDIO_MIME_BY_EXT = Object.freeze({
  mp3: "audio/mp3", mpeg: "audio/mp3", mpga: "audio/mp3", wav: "audio/wav", m4a: "audio/aac", aac: "audio/aac",
  ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", webm: "audio/webm", mp4: "audio/mp4"
});

export class GeminiMediaError extends Error {
  constructor(status, message, type = "invalid_request_error") {
    super(message);
    this.status = status;
    this.errorType = type;
  }
}

const bad = (message) => new GeminiMediaError(400, message);

const isImagen = (model) => /^imagen/i.test(String(model || ""));

function endpoint(target, method) {
  const base = stripApiVersion(String(target.baseUrl || "").replace(/\/+$/, ""));
  return `${base}/v1beta/models/${encodeURIComponent(target.model)}:${method}`;
}

/** A WAV container around raw 16-bit little-endian mono PCM. */
export function pcmToWav(pcm, sampleRate = 24000, channels = 1) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** The audio mime type of an uploaded file part. */
export function audioMimeOf(part) {
  const declared = /content-type:\s*([^\r\n;]+)/i.exec(part?.headers ?? "")?.[1]?.trim().toLowerCase();
  if (declared && declared.startsWith("audio/")) return declared === "audio/mpeg" ? "audio/mp3" : declared;
  if (declared === "video/mp4" || declared === "video/webm") return declared.replace("video", "audio");
  const ext = /filename\s*=\s*"[^"]*\.([a-z0-9]+)"/i.exec(part?.headers ?? "")?.[1]?.toLowerCase();
  if (ext && AUDIO_MIME_BY_EXT[ext]) return AUDIO_MIME_BY_EXT[ext];
  throw bad("Could not tell the audio format of `file`; send a Content-Type or a known file extension.");
}

function textOf(response) {
  const parts = response?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? parts.filter((p) => typeof p?.text === "string").map((p) => p.text).join("") : "";
}

function inlineOf(response) {
  const parts = response?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? parts.map((p) => p?.inlineData ?? p?.inline_data).find((d) => d?.data) ?? null : null;
}

function floatsToBase64(values) {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf.toString("base64");
}

/**
 * Builds the upstream call.
 * `input` is `{ body }` for JSON routes or `{ fields: Map }` for multipart routes.
 * Returns `{ url, headers, body, ctx }`; `ctx` is handed back to `translateResponse`.
 */
export function buildGeminiRequest(pathname, target, input) {
  const headers = { "content-type": "application/json", "x-goog-api-key": target.apiKey };
  const json = (url, payload, ctx) => ({ url, headers, body: JSON.stringify(payload), ctx });
  const body = input.body ?? {};

  if (pathname === "/v1/embeddings") {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    if (inputs.length === 0 || inputs.length > MAX_EMBEDDING_INPUTS || !inputs.every((v) => typeof v === "string" && v !== "")) {
      throw bad(`\`input\` must be a non-empty string or an array of up to ${MAX_EMBEDDING_INPUTS} non-empty strings (token arrays are not supported on Gemini).`);
    }
    const dimensions = Number.isInteger(body.dimensions) && body.dimensions > 0 ? body.dimensions : undefined;
    const requests = inputs.map((text) => ({
      model: `models/${target.model}`,
      content: { parts: [{ text }] },
      ...(dimensions ? { outputDimensionality: dimensions } : {})
    }));
    return json(endpoint(target, "batchEmbedContents"), { requests }, { kind: "embeddings", count: inputs.length, base64: body.encoding_format === "base64", model: target.model });
  }

  if (pathname === "/v1/images/generations") {
    const n = body.n === undefined ? 1 : body.n;
    if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGES) throw bad(`\`n\` must be an integer from 1 to ${MAX_IMAGES}.`);
    if (isImagen(target.model)) {
      return json(endpoint(target, "predict"), { instances: [{ prompt: String(body.prompt) }], parameters: { sampleCount: n } }, { kind: "images-imagen" });
    }
    if (n !== 1) throw bad("This Gemini image model returns one image per request; use n=1.");
    return json(endpoint(target, "generateContent"), {
      contents: [{ role: "user", parts: [{ text: String(body.prompt) }] }],
      generationConfig: { responseModalities: ["IMAGE"] }
    }, { kind: "images-gemini" });
  }

  if (pathname === "/v1/audio/speech") {
    const requested = typeof body.voice === "string" ? body.voice.trim() : "";
    // OpenAI voice names do not exist on Gemini; a Gemini voice name passes straight through.
    const voice = requested && !OPENAI_VOICES.has(requested.toLowerCase()) ? requested : DEFAULT_GEMINI_VOICE;
    return json(endpoint(target, "generateContent"), {
      contents: [{ role: "user", parts: [{ text: String(body.input) }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
      }
    }, { kind: "speech", pcm: body.response_format === "pcm" });
  }

  if (pathname === "/v1/audio/transcriptions" || pathname === "/v1/audio/translations") {
    const translate = pathname.endsWith("translations");
    const fields = input.fields;
    const file = fields.get("file");
    const format = (fields.get("response_format")?.body.toString("utf8").trim() || "json").toLowerCase();
    if (!["json", "text", "verbose_json"].includes(format)) {
      throw bad(`response_format "${format}" is not supported on Gemini; use json, text or verbose_json.`);
    }
    const language = fields.get("language")?.body.toString("utf8").trim();
    const hint = fields.get("prompt")?.body.toString("utf8").trim();
    const instruction = translate
      ? "Translate the speech in this audio into English. Output only the English translation, with no commentary."
      : `Transcribe the speech in this audio verbatim${language ? ` (the language is ${language})` : ""}. Output only the transcript, with no commentary.`;
    const parts = [{ text: hint ? `${instruction}\nContext: ${hint}` : instruction }, { inline_data: { mime_type: audioMimeOf(file), data: file.body.toString("base64") } }];
    return json(endpoint(target, "generateContent"), {
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0 }
    }, { kind: "transcription", format, translate, language: translate ? "english" : (language || null) });
  }

  throw bad("This endpoint is not served by Gemini targets.");
}

const jsonResult = (status, payload) => ({
  status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(payload))
});

const errorResult = (status, message, type) => jsonResult(status, { error: { message, type } });

/** Gemini error body -> OpenAI error shape (status is kept). */
function relayError(status, raw) {
  let message = `Gemini answered ${status}`;
  try { message = JSON.parse(raw.toString("utf8"))?.error?.message || message; } catch { /* keep generic */ }
  return errorResult(status, String(message).slice(0, 500), status >= 500 || status === 429 ? "upstream_error" : "invalid_request_error");
}

/**
 * Translates Gemini's answer to the OpenAI shape.
 * `status` 2xx with nothing usable becomes 502 (retryable, so fallback applies);
 * a content block becomes a 400 (the request is the problem, not the model).
 */
export function translateGeminiResponse(ctx, status, raw) {
  if (status < 200 || status >= 300) return relayError(status, raw);

  let data;
  try { data = JSON.parse(raw.toString("utf8")); }
  catch { return errorResult(502, "Gemini returned a body that is not JSON", "upstream_error"); }

  const blocked = data?.promptFeedback?.blockReason;
  if (blocked) return errorResult(400, `The request was blocked by the provider (${String(blocked).slice(0, 60)}).`, "content_blocked");
  const empty = (what) => errorResult(502, `Gemini returned no ${what}`, "upstream_error");

  switch (ctx.kind) {
    case "embeddings": {
      const list = data?.embeddings;
      if (!Array.isArray(list) || list.length !== ctx.count || !list.every((e) => Array.isArray(e?.values))) return empty("embeddings");
      return jsonResult(200, {
        object: "list",
        data: list.map((e, index) => ({ object: "embedding", index, embedding: ctx.base64 ? floatsToBase64(e.values) : e.values })),
        model: ctx.model,
        usage: { prompt_tokens: 0, total_tokens: 0 }
      });
    }
    case "images-imagen": {
      const images = (data?.predictions ?? []).map((p) => p?.bytesBase64Encoded).filter(Boolean);
      if (images.length === 0) return empty("image");
      return jsonResult(200, { created: Math.floor(Date.now() / 1000), data: images.map((b64_json) => ({ b64_json })) });
    }
    case "images-gemini": {
      const inline = inlineOf(data);
      if (!inline?.data) return empty("image");
      return jsonResult(200, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: inline.data }] });
    }
    case "speech": {
      const inline = inlineOf(data);
      if (!inline?.data) return empty("audio");
      const pcm = Buffer.from(inline.data, "base64");
      const rate = Number(/rate=(\d+)/.exec(String(inline.mimeType ?? inline.mime_type ?? ""))?.[1]) || 24000;
      if (ctx.pcm) return { status: 200, headers: { "content-type": "audio/pcm" }, body: pcm };
      return { status: 200, headers: { "content-type": "audio/wav" }, body: pcmToWav(pcm, rate) };
    }
    case "transcription": {
      const text = textOf(data).trim();
      if (!text) return empty("text");
      if (ctx.format === "text") return { status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, body: Buffer.from(text) };
      if (ctx.format === "verbose_json") {
        return jsonResult(200, { task: ctx.translate ? "translate" : "transcribe", language: ctx.language, duration: null, text });
      }
      return jsonResult(200, { text });
    }
    default:
      return empty("output");
  }
}
