import { randomUUID } from "node:crypto";
import { cleanSchemaForGemini, rememberSignature, signatureFor } from "./anthropic-bridge.js";
import { ensureThoughtSignatures } from "./gemini-signature.js";
import { geminiOutputTokens, geminiBlockReason, streamErrorMessage, base64DataUrl, geminiImageUnsupportedError, geminiVideoUnsupportedError, textPositionImageUnsupportedError } from "./bridge-utils.js";
import { stripApiVersion } from "./url-utils.js";
import { isFileOrAudioPart, mediaOfChatPart, textPositionMediaError, toGeminiPart } from "./bridge-media.js";
import { geminiThinking, readReasoning } from "./bridge-reasoning.js";
import { anthropicEventsToChat, anthropicJsonToChat, buildAnthropicFromChat } from "./anthropic-upstream.js";
import { buildResponsesFromChat, responsesEventsToChat, responsesJsonToChat } from "./responses-upstream.js";

/**
 * OpenAI chat-completions bridge.
 *
 * Most clients (OpenCode, Qwen Code, Cursor, Cline, OpenAI SDKs, ...) speak the
 * OpenAI chat-completions protocol (POST /v1/chat/completions). Chat-capable
 * providers are called natively; Gemini-only providers are reached by
 * translating the request to `generateContent` and the response back to a
 * `chat.completion` (or `chat.completion.chunk` stream). Without this a
 * Gemini-only provider returned 503 no_route for every chat client.
 *
 * Native chat targets (openai-chat) are preferred and passed through untouched;
 * Gemini targets are the fallback. OpenAI chat and the Responses protocol are
 * separate capabilities, so this bridge does not make a Responses provider
 * reachable — see codex-bridge.js for that direction.
 */

/** Which upstream protocol a target is called with for a chat client. */
export function chatProtocol(target) {
  const protocols = Array.isArray(target?.protocols) ? target.protocols : [];
  if (protocols.includes("openai-chat")) return "openai-chat";
  if (protocols.includes("gemini")) return "gemini";
  // An Anthropic-only endpoint is reached last: native chat and Gemini targets
  // keep their lead, but the endpoint is no longer unreachable for chat clients.
  if (protocols.includes("anthropic")) return "anthropic";
  if (protocols.includes("openai-responses")) return "openai-responses";
  return null;
}

/**
 * Target selection for chat clients: every target that can be reached natively
 * or through translation is eligible. Exact model matches come first, the
 * remaining compatible targets follow as fallback — the same rule the Codex and
 * Anthropic bridges use, so a failing preferred model falls back instead of
 * ending the request.
 */
export function selectChatTargets(targets, requestedModel) {
  const compatible = (Array.isArray(targets) ? targets : []).filter((t) => chatProtocol(t));
  const model = typeof requestedModel === "string" && requestedModel ? requestedModel : "";
  const exact = model ? compatible.filter((t) => t.model === model) : [];
  const rest = compatible.filter((t) => !exact.includes(t));
  return {
    protocol: "openai-chat",
    requestedModel: model || null,
    modelMatched: exact.length > 0,
    compatible,
    exact,
    selected: exact.length > 0 ? [...exact, ...rest] : compatible
  };
}

// ---------------------------------------------------------------- helpers

function newId(prefix) {
  return prefix + "_" + randomUUID().replace(/-/g, "").slice(0, 24);
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return {}; }
}

function chatMessages(body) {
  return (Array.isArray(body?.messages) ? body.messages : []).filter(
    (message) => message && typeof message === "object"
  );
}

/** Plain text of a chat content value (string, or content-part array). */
function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      // Only ever reached for a system prompt, an assistant turn or a tool
      // result — the user path handles image parts before calling this. A text
      // stand-in here would be content the model never received.
      if (part?.type === "image_url") throw textPositionImageUnsupportedError();
      if (isFileOrAudioPart(part)) throw textPositionMediaError();
      return typeof part?.text === "string" ? part.text : "";
    })
    .join("");
}

function imageUrlOf(part) {
  const url = part?.image_url ?? part?.url;
  return typeof url === "string" ? url : url?.url || "";
}

function argsString(args) {
  if (typeof args === "string") return args || "{}";
  return JSON.stringify(args ?? {});
}

function argsObject(args) {
  if (typeof args === "string") return safeParse(args);
  return args && typeof args === "object" ? args : {};
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** Function tools in the request's `tools` array, in chat-completions shape. */
function toolList(body) {
  const out = [];
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) {
    const fn = tool?.type === "function" ? tool.function : null;
    if (!fn || typeof fn.name !== "string" || !fn.name) continue;
    out.push({
      name: fn.name,
      description: fn.description || "",
      parameters: fn.parameters || { type: "object", properties: {} }
    });
  }
  return out;
}

/** Stop sequences: `stop` may be a string or an array, `stop_sequences` a legacy alias. */
function stopSequences(body) {
  if (typeof body?.stop === "string" && body.stop) return [body.stop];
  if (Array.isArray(body?.stop)) return body.stop.filter((s) => typeof s === "string" && s);
  if (Array.isArray(body?.stop_sequences)) return body.stop_sequences.filter((s) => typeof s === "string" && s);
  return [];
}

// ---------------------------------------------------------- request -> Gemini

export function toGeminiFromChat(body) {
  // Gemini's functionResponse must name the function; the chat protocol only
  // carries the call id, so map it from the assistant turns.
  const callNames = new Map();
  for (const message of chatMessages(body)) {
    for (const call of message.tool_calls || []) {
      if (call?.id) callNames.set(call.id, call.function?.name || "tool");
    }
  }

  const system = [];
  const contents = [];
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = contents.at(-1);
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };

  for (const message of chatMessages(body)) {
    const role = message.role;

    if (role === "system" || role === "developer") {
      const text = textOfContent(message.content);
      if (text) system.push(text);
      continue;
    }

    if (role === "assistant") {
      const parts = [];
      const text = textOfContent(message.content);
      if (text) parts.push({ text });
      for (const call of message.tool_calls || []) {
        if (!call || typeof call.function?.name !== "string" || !call.function.name) continue;
        const part = { functionCall: { name: call.function.name, args: argsObject(call.function.arguments) } };
        // Echo the thoughtSignature a previous Gemini response returned with
        // this call, when the client sent the same tool-call id back.
        const signature = signatureFor(call.id);
        if (signature) part.thoughtSignature = signature;
        parts.push(part);
      }
      push("model", parts);
      continue;
    }

    if (role === "tool" || role === "function") {
      const text = textOfContent(message.content);
      push("user", [{
        functionResponse: {
          name: callNames.get(message.tool_call_id) || (typeof message.name === "string" && message.name) || "tool",
          response: { output: text }
        }
      }]);
      continue;
    }

    // user (and anything unrecognised, treated as user input)
    const parts = [];
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === "image_url") {
          // Gemini takes inline bytes. A remote URL has no equivalent, so it is
          // refused rather than dropped: the client must not receive an answer
          // that pretends the model saw an image it never received.
          const inline = base64DataUrl(imageUrlOf(part));
          if (!inline) throw geminiImageUnsupportedError();
          parts.push({ inlineData: inline });
        } else if (part?.type === "video_url" || part?.type === "video") {
          // Same rule as images: Gemini takes inline bytes, and a remote URL has
          // no equivalent. Dropping the part would answer about a video the
          // model never saw.
          const inline = base64DataUrl(part?.video_url?.url ?? part?.url);
          if (!inline) throw geminiVideoUnsupportedError();
          parts.push({ inlineData: inline });
        } else if (part?.type === "file" || part?.type === "input_audio") {
          parts.push(toGeminiPart(mediaOfChatPart(part)));
        } else {
          const text = textOfContent([part]);
          if (text) parts.push({ text });
        }
      }
    } else {
      const text = textOfContent(message.content);
      if (text) parts.push({ text });
    }
    push("user", parts);
  }

  const payload = { contents: ensureThoughtSignatures(contents) };
  if (system.length) payload.systemInstruction = { parts: [{ text: system.join("\n\n") }] };

  const generationConfig = {};
  const maxTokens = positiveInt(body?.max_tokens ?? body?.max_completion_tokens);
  if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
  if (typeof body?.temperature === "number") generationConfig.temperature = body.temperature;
  if (typeof body?.top_p === "number") generationConfig.topP = body.top_p;
  const stop = stopSequences(body);
  if (stop.length) generationConfig.stopSequences = stop.slice(0, 5);

  const format = body?.response_format;
  const schema = format?.json_schema?.schema || format?.schema;
  if (format?.type === "json_schema" && schema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = cleanSchemaForGemini(schema);
  } else if (format?.type === "json_object") {
    generationConfig.responseMimeType = "application/json";
  }
  const responseModalities = geminiResponseModalities(body?.modalities);
  if (responseModalities) generationConfig.responseModalities = responseModalities;
  const thinking = geminiThinking(readReasoning(body, "openai-chat"));
  if (thinking) generationConfig.thinkingConfig = thinking;
  if (Object.keys(generationConfig).length) payload.generationConfig = generationConfig;

  const tools = toolList(body);
  if (tools.length) {
    payload.tools = [{
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: cleanSchemaForGemini(tool.parameters)
      }))
    }];
    const choice = body?.tool_choice;
    if (choice === "required") payload.toolConfig = { functionCallingConfig: { mode: "ANY" } };
    else if (choice === "none") payload.toolConfig = { functionCallingConfig: { mode: "NONE" } };
    else if (choice?.type === "function" && choice.function?.name) {
      payload.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.function.name] } };
    }
    // "auto" is Gemini's default; no toolConfig needed.
  }
  return payload;
}

function joinUrl(baseUrl, suffix) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return base + "/" + String(suffix || "").replace(/^\/+/, "");
}

/** Builds the upstream fetch request for a translated (non-chat) target. */
export function buildChatRequest(target, upstreamProtocol, body, incomingHeaders = {}) {
  if (upstreamProtocol === "anthropic") return buildAnthropicFromChat(target, body, incomingHeaders);
  if (upstreamProtocol === "openai-responses") return buildResponsesFromChat(target, body, incomingHeaders);

  const headers = { "content-type": "application/json" };
  if (incomingHeaders["user-agent"]) headers["user-agent"] = incomingHeaders["user-agent"];
  const base = String(target.baseUrl || "").replace(/\/+$/, "");
  const stream = body.stream === true;

  if (upstreamProtocol === "gemini") {
    headers.accept = stream ? "text/event-stream" : "application/json";
    headers["x-goog-api-key"] = target.apiKey;
    const method = stream ? ":streamGenerateContent?alt=sse" : ":generateContent";
    // A configured base URL may already carry the API version (`.../v1beta`),
    // so it is stripped first — otherwise the request goes to
    // `/v1beta/v1beta/models/...`.
    const url = joinUrl(stripApiVersion(base), "v1beta/models/" + encodeURIComponent(target.model) + method);
    return { url, options: { method: "POST", headers, body: JSON.stringify(toGeminiFromChat(body)) } };
  }
  throw new Error("Unsupported Chat bridge protocol: " + upstreamProtocol);
}

/** Cheap input-token estimate, used when the upstream reports no usage. */
export function estimateChatInputTokens(body) {
  const text = JSON.stringify({ messages: body?.messages, tools: body?.tools, response_format: body?.response_format }) || "";
  return Math.ceil(text.length / 4);
}

// ------------------------------------------------- generated media

/** chat `modalities` -> Gemini `responseModalities`; null when text only / absent. */
function geminiResponseModalities(modalities) {
  if (!Array.isArray(modalities)) return null;
  const wanted = new Set(modalities.map((value) => String(value ?? "").toLowerCase()));
  if (!wanted.has("image") && !wanted.has("audio")) return null;
  return ["TEXT", ...["image", "audio"].filter((kind) => wanted.has(kind)).map((kind) => kind.toUpperCase())];
}

/**
 * A Gemini `inlineData` part that the model GENERATED, in the shape OpenAI-chat
 * clients read it: images as `message.images[]` (data URLs), audio as
 * `message.audio`. Anything else is not representable on the chat wire.
 */
function generatedMedia(part) {
  const inline = part?.inlineData ?? part?.inline_data;
  const mime = String(inline?.mimeType ?? inline?.mime_type ?? "").toLowerCase();
  const data = inline?.data;
  if (!data || typeof data !== "string") return null;
  if (mime.startsWith("image/")) {
    return { kind: "image", value: { type: "image_url", image_url: { url: `data:${mime};base64,${data}` } } };
  }
  if (mime.startsWith("audio/")) {
    return { kind: "audio", value: { data, format: mime.replace(/^audio\//, "").replace("mpeg", "mp3") || "wav" } };
  }
  return null;
}

// ------------------------------------------------- JSON response -> chat

function finishReasonFor(reason, hasToolCalls, blocked = null) {
  if (hasToolCalls) return "tool_calls";
  // A withheld answer is not a normal stop: an empty "stop" would read as a
  // model that simply had nothing to say.
  if (blocked) return "content_filter";
  return reason === "MAX_TOKENS" ? "length" : "stop";
}

function chatUsage(input, output) {
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

export function geminiJsonToChat(json, model, ctx = {}) {
  const candidate = json?.candidates?.[0] ?? {};
  const toolCalls = [];
  const images = [];
  let audio = null;
  let text = "";

  for (const part of candidate.content?.parts || []) {
    if (part.thought) continue;
    if (typeof part.text === "string" && part.text) {
      text += part.text;
    } else if (generatedMedia(part)) {
      const media = generatedMedia(part);
      if (media.kind === "image") images.push({ index: images.length, ...media.value });
      else if (!audio) audio = media.value;
    } else if (part.functionCall) {
      const id = newId("call");
      rememberSignature(id, part.thoughtSignature);
      toolCalls.push({
        id,
        type: "function",
        function: { name: part.functionCall.name, arguments: argsString(part.functionCall.args) }
      });
    }
  }

  const input = json?.usageMetadata?.promptTokenCount ?? ctx.inputTokens ?? 0;
  const output = geminiOutputTokens(json?.usageMetadata);
  const message = { role: "assistant", content: text || (toolCalls.length ? null : "") };
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (images.length) message.images = images;
  if (audio) message.audio = audio;

  return {
    id: newId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReasonFor(candidate.finishReason, toolCalls.length > 0, geminiBlockReason(json, candidate)),
      logprobs: null
    }],
    usage: chatUsage(input, output)
  };
}

export function convertChatJson(upstreamProtocol, json, model, ctx = {}) {
  if (upstreamProtocol === "gemini") return geminiJsonToChat(json, model, ctx);
  if (upstreamProtocol === "anthropic") return anthropicJsonToChat(json, model, ctx);
  if (upstreamProtocol === "openai-responses") return responsesJsonToChat(json, model, ctx);
  throw new Error("Unsupported Chat bridge protocol: " + upstreamProtocol);
}

// ------------------------------------------------------------- streaming

const chunk = (id, created, model, choices, extra = {}) =>
  "data: " + JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices, ...extra }) + "\n\n";

/**
 * Converts a Gemini SSE stream into `chat.completion.chunk` SSE, ending with
 * `data: [DONE]` (the terminator OpenAI-compatible clients wait for). `events`
 * is an async iterable of raw `data:` strings. Never throws: an upstream
 * failure after headers were sent becomes an error event followed by [DONE].
 */
export async function* streamToChat(upstreamProtocol, events, model, ctx = {}) {
  if (upstreamProtocol === "anthropic" || upstreamProtocol === "openai-responses") {
    // The converter already yields complete chat chunks and the "[DONE]"
    // terminator; a usage-only chunk is added only when the client asked for it.
    const convert = upstreamProtocol === "anthropic" ? anthropicEventsToChat : responsesEventsToChat;
    for await (const data of convert(events, model, { emitUsage: ctx.includeUsage === true, inputTokens: ctx.inputTokens })) {
      yield "data: " + data + "\n\n";
    }
    return;
  }
  if (upstreamProtocol !== "gemini") throw new Error("Unsupported Chat bridge protocol: " + upstreamProtocol);

  const id = newId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  const emit = (choices, extra) => chunk(id, created, model, choices, extra);

  yield emit([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);

  let nextToolIndex = 0;
  let nextImageIndex = 0;
  let sawTool = false;
  let finish = null;
  let blocked = null;
  let sawDone = false;
  let inputTokens = null;
  let outputTokens = 0;
  let outputChars = 0;

  try {
    for await (const data of events) {
      if (data === "[DONE]") { sawDone = true; break; }
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }

      // Surface an upstream error chunk instead of ending as a normal "stop".
      if (parsed?.error) {
        yield "data: " + JSON.stringify({ error: { message: streamErrorMessage(parsed.error), type: "upstream_error" } }) + "\n\n";
        yield "data: [DONE]\n\n";
        return;
      }

      const candidate = parsed.candidates?.[0];
      for (const part of candidate?.content?.parts || []) {
        if (part.thought) continue;
        if (typeof part.text === "string" && part.text) {
          outputChars += part.text.length;
          yield emit([{ index: 0, delta: { content: part.text }, finish_reason: null }]);
        } else if (generatedMedia(part)) {
          const media = generatedMedia(part);
          const delta = media.kind === "image" ? { images: [{ index: nextImageIndex++, ...media.value }] } : { audio: media.value };
          yield emit([{ index: 0, delta, finish_reason: null }]);
        } else if (part.functionCall) {
          const index = nextToolIndex++;
          sawTool = true;
          const callId = newId("call");
          rememberSignature(callId, part.thoughtSignature);
          yield emit([{
            index: 0,
            delta: { tool_calls: [{ index, id: callId, type: "function", function: { name: part.functionCall.name, arguments: "" } }] },
            finish_reason: null
          }]);
          const args = argsString(part.functionCall.args);
          outputChars += args.length;
          yield emit([{ index: 0, delta: { tool_calls: [{ index, function: { arguments: args } }] }, finish_reason: null }]);
        }
      }
      if (candidate?.finishReason) finish = candidate.finishReason === "MAX_TOKENS" ? "length" : "stop";
      blocked = blocked || geminiBlockReason(parsed, candidate);
      // A blocked prompt arrives as a chunk with no candidate and no finishReason.
      if (parsed.promptFeedback?.blockReason) finish = finish || "stop";
      if (parsed.usageMetadata?.promptTokenCount) inputTokens = parsed.usageMetadata.promptTokenCount;
      if (parsed.usageMetadata) outputTokens = geminiOutputTokens(parsed.usageMetadata) || outputTokens;
    }
  } catch (error) {
    yield "data: " + JSON.stringify({
      error: { message: String(error?.message || "Upstream stream failed").slice(0, 500), type: "upstream_error" }
    }) + "\n\n";
    yield "data: [DONE]\n\n";
    return;
  }

  // A stream that ends with neither a finish reason nor [DONE] was cut off.
  // Reported as a normal "stop" it would hand the client a truncated answer
  // (or a half-written tool call) as complete, so it is an error instead.
  if (finish === null && !sawDone) {
    yield "data: " + JSON.stringify({ error: { message: "The upstream stream ended before the response was complete.", type: "upstream_error" } }) + "\n\n";
    yield "data: [DONE]\n\n";
    return;
  }

  yield emit([{ index: 0, delta: {}, finish_reason: sawTool ? "tool_calls" : blocked ? "content_filter" : finish || "stop" }]);

  if (ctx.includeUsage) {
    const input = inputTokens ?? ctx.inputTokens ?? 0;
    const output = outputTokens || Math.ceil(outputChars / 4);
    yield emit([], { usage: chatUsage(input, output) });
  }

  yield "data: [DONE]\n\n";
}
