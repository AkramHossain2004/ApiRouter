import { unsupportedMediaError } from "./bridge-utils.js";

/**
 * File and audio parts across the four protocols.
 *
 * Every bridge used to carry images only: a `file` / `input_file` / `document`
 * or `input_audio` part fell through the "text parts only" branch and vanished,
 * so the model answered a question about a document it never received while the
 * client saw a normal 200. This module gives each protocol one reader that
 * turns its own part into a canonical description, and one writer per
 * destination protocol. A destination with no wire form for the media raises
 * `unsupportedMediaError` (retryable, no cooldown) so the fallback walk can try
 * a target that can carry it, exactly as it already does for images.
 *
 * Canonical media: { kind: "file"|"audio", mimeType, data (base64), text, url,
 * fileId, filename }.
 */

const AUDIO_FORMAT_MIME = Object.freeze({
  wav: "audio/wav", mp3: "audio/mp3", mpeg: "audio/mpeg", flac: "audio/flac", ogg: "audio/ogg",
  aac: "audio/aac", m4a: "audio/mp4", mp4: "audio/mp4", webm: "audio/webm", opus: "audio/ogg", aiff: "audio/aiff"
});

const MIME_EXT = Object.freeze({
  "application/pdf": "pdf", "text/plain": "txt", "text/markdown": "md", "text/csv": "csv",
  "text/html": "html", "application/json": "json"
});

const EXT_MIME = Object.freeze({
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv",
  html: "text/html", json: "application/json"
});

/** The part types that carry a file or audio clip in some protocol. */
export const MEDIA_PART_TYPES = Object.freeze(["file", "input_file", "document", "input_audio", "audio", "audio_url"]);

export const isFileOrAudioPart = (part) => Boolean(part) && typeof part === "object" && MEDIA_PART_TYPES.includes(part.type);

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function audioMime(format) {
  const key = String(format ?? "").toLowerCase().replace(/^audio\//, "");
  return AUDIO_FORMAT_MIME[key] ?? (key ? `audio/${key}` : "audio/wav");
}

export function audioFormat(mimeType) {
  const type = String(mimeType ?? "").toLowerCase().replace(/^audio\//, "");
  if (type === "mpeg") return "mp3";
  if (type === "x-wav" || type === "wave") return "wav";
  if (type === "mp4") return "m4a";
  return type || "wav";
}

function mimeFromFilename(filename) {
  const ext = String(filename ?? "").split(".").pop()?.toLowerCase();
  return EXT_MIME[ext] ?? null;
}

/** Splits `data:<mime>;base64,<data>`; accepts a bare base64 payload too. */
function splitData(value, fallbackMime) {
  if (typeof value !== "string" || !value) return null;
  const match = /^data:([^;,]+)?;base64,(.+)$/s.exec(value);
  if (match) return { mimeType: match[1] || fallbackMime || "application/octet-stream", data: match[2] };
  if (/^data:/i.test(value)) return null;
  return /^[A-Za-z0-9+/=\s]+$/.test(value) ? { mimeType: fallbackMime || "application/octet-stream", data: value.replace(/\s+/g, "") } : null;
}

const fail = (what) => unsupportedMediaError(
  `This request carries ${what} that has no usable content (no inline base64 data, URL or file id). `
  + "Send it inline as base64, or remove the part."
);

// ------------------------------------------------------------- readers

/** Chat completions: `{type:"file", file:{filename,file_data|file_id}}`, `{type:"input_audio", input_audio:{data,format}}`. */
export function mediaOfChatPart(part) {
  if (!isObject(part)) return null;
  if (part.type === "file") {
    const file = isObject(part.file) ? part.file : part;
    const filename = typeof file.filename === "string" ? file.filename : null;
    const inline = splitData(file.file_data, mimeFromFilename(filename));
    if (inline) return { kind: "file", ...inline, filename };
    if (typeof file.file_id === "string" && file.file_id) return { kind: "file", fileId: file.file_id, filename };
    throw fail("a file part");
  }
  if (part.type === "input_audio") {
    const audio = isObject(part.input_audio) ? part.input_audio : part;
    if (typeof audio.data !== "string" || !audio.data) throw fail("an audio part");
    return { kind: "audio", data: audio.data, mimeType: audioMime(audio.format) };
  }
  return null;
}

/** Responses: `{type:"input_file", file_data|file_id|file_url, filename}` and the (non-standard) `input_audio`. */
export function mediaOfResponsesPart(part) {
  if (!isObject(part)) return null;
  if (part.type === "input_file") {
    const filename = typeof part.filename === "string" ? part.filename : null;
    const inline = splitData(part.file_data, mimeFromFilename(filename));
    if (inline) return { kind: "file", ...inline, filename };
    if (typeof part.file_id === "string" && part.file_id) return { kind: "file", fileId: part.file_id, filename };
    if (typeof part.file_url === "string" && part.file_url) return { kind: "file", url: part.file_url, filename };
    throw fail("an `input_file` part");
  }
  if (part.type === "input_audio") return mediaOfChatPart(part);
  return null;
}

/** Anthropic: `{type:"document", source:{type:"base64"|"text"|"url"|"content", ...}, title}`. */
export function mediaOfAnthropicBlock(block) {
  if (!isObject(block) || block.type !== "document") return null;
  const source = isObject(block.source) ? block.source : {};
  const filename = typeof block.title === "string" && block.title ? block.title : null;
  if (source.type === "base64" && typeof source.data === "string" && source.data) {
    return { kind: "file", mimeType: source.media_type || "application/pdf", data: source.data, filename };
  }
  if (source.type === "text" && typeof source.data === "string") {
    return { kind: "file", mimeType: source.media_type || "text/plain", text: source.data, filename };
  }
  if (source.type === "content") {
    const text = (Array.isArray(source.content) ? source.content : [])
      .map((item) => (typeof item === "string" ? item : typeof item?.text === "string" ? item.text : ""))
      .join("");
    if (text) return { kind: "file", mimeType: "text/plain", text, filename };
  }
  if (source.type === "url" && typeof source.url === "string" && source.url) {
    return { kind: "file", url: source.url, filename };
  }
  throw fail("a `document` block");
}

/** A Gemini part, classified by its real media type (never assumed to be an image). */
export function mediaOfGeminiInline(inline) {
  const data = inline?.data;
  const mimeType = inline?.mimeType ?? inline?.mime_type ?? "application/octet-stream";
  if (typeof data !== "string" || !data) return null;
  if (/^image\//i.test(mimeType)) return { kind: "image", mimeType, data };
  if (/^audio\//i.test(mimeType)) return { kind: "audio", mimeType, data };
  if (/^video\//i.test(mimeType)) return { kind: "video", mimeType, data };
  return { kind: "file", mimeType, data };
}

// ------------------------------------------------------------- writers

const dataUrl = (media) => `data:${media.mimeType};base64,${media.data}`;
const fileName = (media) => media.filename || `document.${MIME_EXT[media.mimeType] ?? "bin"}`;
const labelled = (media) => (media.filename ? `[${media.filename}]\n${media.text}` : media.text);

function refuse(protocolName, media, hint) {
  const what = media.kind === "audio" ? "an audio clip" : media.kind === "video" ? "a video" : "a file";
  return unsupportedMediaError(
    `This request carries ${what} that cannot be converted for ${protocolName}. ${hint}`
  );
}

/** -> OpenAI chat content part. */
export function toChatPart(media) {
  if (media.kind === "audio") return { type: "input_audio", input_audio: { data: media.data, format: audioFormat(media.mimeType) } };
  if (media.kind === "file") {
    if (media.text !== undefined) return { type: "text", text: labelled(media) };
    if (media.data) return { type: "file", file: { filename: fileName(media), file_data: dataUrl(media) } };
    if (media.fileId) return { type: "file", file: { file_id: media.fileId } };
    throw refuse("an OpenAI chat provider", media, "Chat completions accept inline base64 files or file ids, not URLs: send the file inline as base64.");
  }
  throw refuse("an OpenAI chat provider", media, "Send it as an image/audio/file part the provider supports.");
}

/** -> OpenAI Responses input part. */
export function toResponsesPart(media) {
  if (media.kind === "file") {
    if (media.text !== undefined) return { type: "input_text", text: labelled(media) };
    if (media.data) return { type: "input_file", filename: fileName(media), file_data: dataUrl(media) };
    if (media.fileId) return { type: "input_file", file_id: media.fileId };
    if (media.url) return { type: "input_file", file_url: media.url };
  }
  throw refuse("an OpenAI Responses provider", media, media.kind === "audio"
    ? "The Responses API has no audio input; use a provider that speaks chat completions or Gemini."
    : "Send a file as inline base64, a file id or a URL.");
}

/** -> Anthropic content block. */
export function toAnthropicBlock(media) {
  if (media.kind === "file") {
    const title = media.filename ? { title: media.filename } : {};
    if (media.text !== undefined) {
      return { type: "document", source: { type: "text", media_type: "text/plain", data: media.text }, ...title };
    }
    if (media.data && media.mimeType === "application/pdf") {
      return { type: "document", source: { type: "base64", media_type: "application/pdf", data: media.data }, ...title };
    }
    if (media.data && /^text\//i.test(media.mimeType)) {
      return { type: "document", source: { type: "text", media_type: "text/plain", data: Buffer.from(media.data, "base64").toString("utf8") }, ...title };
    }
    if (media.url && /^https?:\/\//i.test(media.url)) {
      return { type: "document", source: { type: "url", url: media.url }, ...title };
    }
    throw refuse("an Anthropic provider", media, "Anthropic accepts PDF (base64 or https URL) and plain-text documents only; file ids are provider-private.");
  }
  throw refuse("an Anthropic provider", media, media.kind === "audio"
    ? "Anthropic models have no audio input; use a provider that accepts audio."
    : "Anthropic accepts images, PDFs and text documents only.");
}

/** -> Gemini part. Gemini carries inline bytes only. */
export function toGeminiPart(media) {
  if (media.kind === "file" && media.text !== undefined) return { text: labelled(media) };
  if (media.data && (media.kind === "file" || media.kind === "audio" || media.kind === "video")) {
    return { inlineData: { mimeType: media.mimeType, data: media.data } };
  }
  throw refuse("a Gemini provider", media, "Gemini accepts inline base64 media only (no file ids or remote URLs): send the file inline as base64.");
}

/** What a text-only position (system prompt, assistant turn, tool result) says about file/audio parts. */
export function textPositionMediaError() {
  return unsupportedMediaError(
    "This request carries a file or audio part in a position that holds only text — a system "
    + "prompt, an assistant turn, or a tool result. Forwarding it would mean substituting text the "
    + "model never saw. Move it into a user message, or configure a provider that accepts it there."
  );
}
