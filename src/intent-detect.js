/**
 * Output intent: what the USER asked the model to produce, read from the last
 * user message ("create a photo", "generate a video").
 *
 * The payload alone cannot say this: a plain chat request that asks for a video
 * carries only text parts, so the capability layer used to see a text request
 * and hand it to any text model. This module reports the generated-media
 * capabilities the message asks for, so routing can prefer models that declare
 * them (see `server.js`) and fall back, with an honest notice, when none do.
 *
 * Deliberately strict: ONLY these exact phrases count, nothing else.
 *
 *   image: "create a image", "create a photo", "create photo", "create image",
 *          "genarete a photo", "genarete a image", "genarete photo", "genarete image"
 *          and the same four with the correct spelling "generate"
 *   video: "create video", "create a video", "genarete video", "genarete a video",
 *          "generate video", "generate a video"
 *
 * Every other wording ("make a picture", "I need a logo",
 * "give me an image", "create videos" ...) is left to the text model.
 *
 *   - requests that carry client tools are skipped: coding agents (Claude Code,
 *     Codex) say "create a file" and mean their own write-file tool;
 *   - an explicit `modalities` / media endpoint already states the need.
 */

// The only phrases that count. Image has a capability a model can declare.
const PHRASES = Object.freeze({
  image_output: [
    "create a image", "create a photo", "create photo", "create image",
    "genarete a photo", "genarete a image", "genarete photo", "genarete image",
    "generate a photo", "generate a image", "generate photo", "generate image"
  ]
});

// Outputs no adapter can generate. They are not capabilities (nothing to declare or route on): a
// request for one is still answered by a text model that is told to say plainly it cannot be made.
const UNSUPPORTED_PHRASES = Object.freeze({
  video: [
    "create video", "create a video",
    "genarete video", "genarete a video",
    "generate video", "generate a video"
  ]
});

// "how to / what is / explain" is a question about the thing, not a request for it.
const QUESTION_OPENER = /^\s*(how|what|why|when|which|explain|describe|tell me about)\b/i;

// The whole phrase, case-insensitive, any run of spaces between words, not glued to other letters.
const phrasePattern = (phrases) =>
  new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${phrases.map((p) => p.split(" ").join("\\s+")).join("|")})(?=$|[^\\p{L}\\p{N}])`, "iu");

const NOUN_RE = Object.fromEntries(Object.entries(PHRASES).map(([id, list]) => [id, phrasePattern(list)]));
const UNSUPPORTED_RE = Object.fromEntries(Object.entries(UNSUPPORTED_PHRASES).map(([kind, list]) => [kind, phrasePattern(list)]));

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function textOfContent(content) {
  if (typeof content === "string") return content;
  const parts = Array.isArray(content) ? content : isObject(content) ? [content] : [];
  return parts
    .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** The last thing the user said, in any of the four client protocols. */
export function lastUserText(body) {
  if (!isObject(body)) return "";
  const lists = [body.messages, body.input, body.contents];
  for (const list of lists) {
    if (typeof list === "string") return list;
    if (!Array.isArray(list)) continue;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const entry = list[i];
      if (!isObject(entry)) continue;
      const role = String(entry.role ?? "user").toLowerCase();
      if (role !== "user") continue;
      const text = textOfContent(entry.content ?? entry.parts);
      if (text.trim()) return text;
    }
  }
  return "";
}

function hasClientTools(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : Array.isArray(body?.functions) ? body.functions : [];
  return tools.length > 0;
}

/**
 * @returns {{ outputs: string[], unsupported: string[], text: string }} `outputs` are capability ids
 * (image_output), possibly empty; `unsupported` are output kinds ("video") that no model can generate.
 */
export function detectOutputIntent({ operation = "chat", body = {} } = {}) {
  const none = { outputs: [], unsupported: [], text: "" };
  if (operation !== "chat") return none;
  if (hasClientTools(body)) return none;
  const text = lastUserText(body).slice(0, 2000);
  if (!text.trim()) return none;

  const found = new Set();
  const unsupported = new Set();
  for (const sentence of text.split(/[.!?\n।]+/)) {
    if (!sentence.trim()) continue;
    if (QUESTION_OPENER.test(sentence)) continue;
    for (const [id, re] of Object.entries(NOUN_RE)) {
      if (re.test(sentence)) found.add(id);
    }
    for (const [kind, re] of Object.entries(UNSUPPORTED_RE)) {
      if (re.test(sentence)) unsupported.add(kind);
    }
  }
  return { outputs: [...found], unsupported: [...unsupported], text: "" };
}

const KIND = { image_output: "image" };

/** The notice a model is given when no configured model can produce the output. */
export function capabilityFallbackNotice(missing) {
  const kinds = (Array.isArray(missing) ? missing : [])
    .map((id) => KIND[id] ?? (Object.hasOwn(UNSUPPORTED_PHRASES, id) ? id : undefined))
    .filter(Boolean);
  if (kinds.length === 0) return "";
  const list = kinds.join(" / ");
  return [
    `Router notice: the user appears to be asking you to create a ${list}, but no configured model can generate that output.`,
    `Begin your reply by telling the user plainly that the ${list} could not be generated here.`,
    "Do not pretend to produce it, and do not invent links or attachments.",
    "Then offer the closest text-based help (for example a prompt or a description)."
  ].join(" ");
}

/** Adds the notice as a system-level instruction in the client's own protocol. */
export function applyFallbackNotice(protocol, body, notice) {
  if (!notice || !isObject(body)) return false;
  if (protocol === "anthropic") {
    if (Array.isArray(body.system)) body.system = [{ type: "text", text: notice }, ...body.system];
    else body.system = body.system ? `${notice}\n\n${body.system}` : notice;
    return true;
  }
  if (protocol === "openai-responses") {
    body.instructions = body.instructions ? `${notice}\n\n${body.instructions}` : notice;
    return true;
  }
  if (protocol === "gemini") {
    const key = isObject(body.system_instruction) ? "system_instruction" : "systemInstruction";
    const current = isObject(body[key]) ? body[key] : {};
    body[key] = { ...current, parts: [{ text: notice }, ...(Array.isArray(current.parts) ? current.parts : [])] };
    return true;
  }
  if (Array.isArray(body.messages)) {
    body.messages = [{ role: "system", content: notice }, ...body.messages];
    return true;
  }
  return false;
}

/**
 * Asks a capable target for the media itself. Only the two protocols whose
 * native wire form is known get a field; everything else is left untouched.
 */
export function applyOutputModalities(protocol, body, outputs) {
  const kinds = (Array.isArray(outputs) ? outputs : [])
    .map((id) => KIND[id])
    .filter((kind) => kind === "image");
  if (!isObject(body) || kinds.length === 0) return false;
  if (protocol === "openai-chat") {
    if (Array.isArray(body.modalities)) return false;
    body.modalities = [...kinds, "text"];
    return true;
  }
  if (protocol === "gemini") {
    const key = isObject(body.generation_config) ? "generation_config" : "generationConfig";
    const config = isObject(body[key]) ? body[key] : {};
    const field = "responseModalities" in config || !("response_modalities" in config) ? "responseModalities" : "response_modalities";
    if (Array.isArray(config[field])) return false;
    body[key] = { ...config, [field]: ["TEXT", ...kinds.map((kind) => kind.toUpperCase())] };
    return true;
  }
  return false;
}
