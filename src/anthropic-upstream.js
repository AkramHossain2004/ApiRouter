import { randomUUID } from "node:crypto";
import { buildUpstreamRequest } from "./adapters.js";
import { base64DataUrl, streamErrorMessage, textPositionImageUnsupportedError, unsupportedMediaError } from "./bridge-utils.js";
import { stripApiVersion } from "./url-utils.js";
import { isFileOrAudioPart, mediaOfChatPart, textPositionMediaError, toAnthropicBlock } from "./bridge-media.js";
import { anthropicThinking, readReasoning } from "./bridge-reasoning.js";

/**
 * Anthropic Messages as an UPSTREAM for the OpenAI chat, OpenAI Responses and
 * Gemini client protocols.
 *
 * The three client bridges all speak OpenAI-chat internally (Responses and Gemini
 * requests are first turned into a chat request), so this module only has to
 * translate chat <-> Anthropic Messages:
 *
 *   chatToAnthropicRequest   chat request          -> Anthropic request
 *   anthropicJsonToChat      Anthropic message     -> chat.completion
 *   anthropicEventsToChat    Anthropic SSE events  -> chat.completion.chunk events
 *
 * Without it an endpoint that speaks only Anthropic (a custom endpoint saved with
 * the Anthropic protocol, say) answered Claude clients but returned "No route
 * available" for every other client protocol.
 */

/** Anthropic requires `max_tokens`; OpenAI-style clients may omit it. */
const DEFAULT_MAX_TOKENS = 4096;

const newId = (prefix) => prefix + "_" + randomUUID().replace(/-/g, "").slice(0, 24);

function safeParse(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** Plain text of a chat content value. An image here has nowhere to go. */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
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

/** Content blocks of a chat user message: text and images. */
function userBlocks(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const blocks = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (typeof part === "string") {
      if (part) blocks.push({ type: "text", text: part });
    } else if (part?.type === "image_url") {
      const url = imageUrlOf(part);
      const inline = base64DataUrl(url);
      if (inline) {
        blocks.push({ type: "image", source: { type: "base64", media_type: inline.mimeType, data: inline.data } });
      } else if (/^https?:\/\//i.test(url)) {
        blocks.push({ type: "image", source: { type: "url", url } });
      } else {
        throw unsupportedMediaError(
          "This request carries an image that cannot be converted for an Anthropic provider. "
          + "Send it as an inline base64 data URL (data:image/png;base64,...) or an https URL."
        );
      }
    } else if (part?.type === "file" || part?.type === "input_audio") {
      // A document becomes a `document` block; audio has no Anthropic form and is refused, never dropped.
      blocks.push(toAnthropicBlock(mediaOfChatPart(part)));
    } else if (typeof part?.text === "string" && part.text) {
      blocks.push({ type: "text", text: part.text });
    }
  }
  return blocks;
}

/** Appends blocks as a turn, merging into the previous turn when the role repeats. */
function pushTurn(turns, role, blocks) {
  if (blocks.length === 0) return;
  const last = turns[turns.length - 1];
  if (last && last.role === role) last.content.push(...blocks);
  else turns.push({ role, content: [...blocks] });
}

/** tool_result blocks must lead the user message that answers a tool_use. */
function toolResultsFirst(content) {
  return [
    ...content.filter((block) => block.type === "tool_result"),
    ...content.filter((block) => block.type !== "tool_result")
  ];
}

function stopSequences(body) {
  const raw = body?.stop ?? body?.stop_sequences;
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  return list.filter((value) => typeof value === "string" && value);
}

/** OpenAI chat request -> Anthropic Messages request. */
export function chatToAnthropicRequest(body, model) {
  const system = [];
  const turns = [];

  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (!message || typeof message !== "object") continue;

    if (message.role === "system" || message.role === "developer") {
      const text = textOf(message.content);
      if (text) system.push(text);
      continue;
    }

    if (message.role === "assistant") {
      const blocks = [];
      const text = textOf(message.content);
      if (text) blocks.push({ type: "text", text });
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const fn = call?.function;
        if (!fn?.name) continue;
        const args = typeof fn.arguments === "string" ? safeParse(fn.arguments) : fn.arguments ?? {};
        blocks.push({ type: "tool_use", id: call.id || newId("toolu"), name: fn.name, input: args });
      }
      pushTurn(turns, "assistant", blocks);
      continue;
    }

    if (message.role === "tool") {
      const text = textOf(message.content);
      const block = { type: "tool_result", tool_use_id: message.tool_call_id };
      if (text) block.content = text;
      pushTurn(turns, "user", [block]);
      continue;
    }

    pushTurn(turns, "user", userBlocks(message.content));
  }

  const payload = {
    model,
    max_tokens: positiveInt(body?.max_completion_tokens) ?? positiveInt(body?.max_tokens) ?? DEFAULT_MAX_TOKENS,
    messages: turns.map((turn) => ({
      role: turn.role,
      content: turn.role === "user" ? toolResultsFirst(turn.content) : turn.content
    }))
  };
  if (system.length) payload.system = system.join("\n\n");
  if (body?.stream === true) payload.stream = true;

  // Anthropic takes temperature in 0..1 (OpenAI allows up to 2) and rejects a
  // request that sets both temperature and top_p on newer models.
  if (typeof body?.temperature === "number") payload.temperature = Math.min(1, Math.max(0, body.temperature));
  else if (typeof body?.top_p === "number") payload.top_p = body.top_p;
  const stops = stopSequences(body);
  if (stops.length) payload.stop_sequences = stops;

  const tools = [];
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) {
    const fn = tool?.type === "function" ? tool.function : null;
    if (!fn || typeof fn.name !== "string" || !fn.name) continue;
    tools.push({
      name: fn.name,
      description: fn.description || "",
      input_schema: fn.parameters || { type: "object", properties: {} }
    });
  }
  if (tools.length) {
    payload.tools = tools;
    const choice = body?.tool_choice;
    if (choice === "required") payload.tool_choice = { type: "any" };
    else if (choice === "none") payload.tool_choice = { type: "none" };
    else if (choice === "auto") payload.tool_choice = { type: "auto" };
    else if (choice?.type === "function" && choice.function?.name) {
      payload.tool_choice = { type: "tool", name: choice.function.name };
    }
  }

  // Reasoning control -> extended thinking. Anthropic rejects thinking together with a forced
  // tool choice, and it requires the earlier thinking blocks to be echoed back on a tool-use
  // turn, which a chat client never carries. In those cases the request goes without thinking.
  const reasoning = readReasoning(body, "openai-chat");
  // The default limit was chosen for plain answers. When the client set none and asked for
  // reasoning, add the thinking budget on top, so the answer is not squeezed out.
  const clientSetLimit = positiveInt(body?.max_completion_tokens) ?? positiveInt(body?.max_tokens);
  const withRoom = reasoning && !clientSetLimit ? { max: DEFAULT_MAX_TOKENS + reasoning.budget } : null;
  const thinking = anthropicThinking(reasoning, withRoom ? withRoom.max : payload.max_tokens);
  const forcedTool = payload.tool_choice?.type === "any" || payload.tool_choice?.type === "tool";
  const toolTurn = payload.messages.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_use"));
  if (thinking && !forcedTool && !toolTurn) {
    payload.thinking = thinking;
    if (withRoom) payload.max_tokens = withRoom.max;
    // Thinking requires the default temperature and no top_p.
    delete payload.temperature;
    delete payload.top_p;
  }
  return payload;
}

/**
 * The upstream fetch request for an Anthropic target, from an OpenAI chat body.
 * URL, auth headers and `anthropic-version` come from the same builder the
 * native Anthropic path uses, so both reach the endpoint identically. A
 * configured base URL may already end in `/v1`; it is stripped first so the
 * request does not go to `/v1/v1/messages`.
 */
export function buildAnthropicFromChat(target, chatBody, incomingHeaders = {}) {
  const payload = chatToAnthropicRequest(chatBody, target.model);
  const base = stripApiVersion(target.baseUrl);
  const headers = { accept: payload.stream ? "text/event-stream" : "application/json" };
  if (incomingHeaders["user-agent"]) headers["user-agent"] = incomingHeaders["user-agent"];
  return buildUpstreamRequest({ ...target, baseUrl: base }, "anthropic", payload, headers, { stream: payload.stream === true });
}

// ------------------------------------------------------- response -> chat

function finishReasonFor(stopReason, hasToolCalls) {
  if (hasToolCalls || stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "refusal") return "content_filter";
  return "stop";
}

/** Anthropic counts cached prompt tokens separately; the real input is the sum. */
function inputTokensOf(usage) {
  const count = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  return count(usage?.input_tokens) + count(usage?.cache_creation_input_tokens) + count(usage?.cache_read_input_tokens);
}

function chatUsage(input, output) {
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

/** Anthropic message -> chat.completion. */
export function anthropicJsonToChat(json, model, ctx = {}) {
  let text = "";
  const toolCalls = [];
  for (const block of Array.isArray(json?.content) ? json.content : []) {
    if (block?.type === "text" && typeof block.text === "string") {
      text += block.text;
    } else if (block?.type === "tool_use") {
      toolCalls.push({
        id: block.id || newId("call"),
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
      });
    }
  }

  const message = { role: "assistant", content: text || (toolCalls.length ? null : "") };
  if (toolCalls.length) message.tool_calls = toolCalls;

  const input = inputTokensOf(json?.usage) || ctx.inputTokens || 0;
  const output = Number(json?.usage?.output_tokens) || 0;
  return {
    id: newId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReasonFor(json?.stop_reason, toolCalls.length > 0),
      logprobs: null
    }],
    usage: chatUsage(input, output)
  };
}

/**
 * Anthropic SSE -> chat.completion.chunk events.
 *
 * `events` is an async iterable of raw `data:` strings; the result is an async
 * iterable of raw chat-chunk JSON strings, ending with "[DONE]". The client
 * bridges (chat, Responses, Gemini) consume exactly that shape, so one converter
 * serves all three. A usage-only chunk (`choices: []`) precedes "[DONE]" unless
 * `emitUsage` is false. Never throws: an upstream failure after headers were sent
 * becomes an `error` chunk followed by "[DONE]".
 */
export async function* anthropicEventsToChat(events, model, { emitUsage = true, inputTokens: estimate = 0 } = {}) {
  const id = newId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish = null, extra = {}) => JSON.stringify({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    ...extra
  });

  yield chunk({ role: "assistant", content: "" });

  const toolIndex = new Map(); // Anthropic content-block index -> chat tool index
  let nextTool = 0;
  let stopReason = null;
  let inputTokens = 0;
  let outputTokens = 0;

  const failure = (message) => JSON.stringify({ error: { message, type: "upstream_error" } });

  try {
    for await (const data of events) {
      if (data === "[DONE]") break;
      let event;
      try { event = JSON.parse(data); } catch { continue; }

      switch (event?.type) {
        case "message_start":
          inputTokens = inputTokensOf(event.message?.usage) || inputTokens;
          outputTokens = Number(event.message?.usage?.output_tokens) || outputTokens;
          break;

        case "content_block_start": {
          const block = event.content_block;
          if (block?.type === "tool_use") {
            const index = nextTool++;
            toolIndex.set(event.index, index);
            yield chunk({
              tool_calls: [{ index, id: block.id || newId("call"), type: "function", function: { name: block.name, arguments: "" } }]
            });
          }
          break;
        }

        case "content_block_delta": {
          const delta = event.delta;
          if (delta?.type === "text_delta" && delta.text) {
            yield chunk({ content: delta.text });
          } else if (delta?.type === "input_json_delta" && toolIndex.has(event.index)) {
            if (delta.partial_json) {
              yield chunk({ tool_calls: [{ index: toolIndex.get(event.index), function: { arguments: delta.partial_json } }] });
            }
          }
          break;
        }

        case "message_delta":
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          inputTokens = inputTokensOf(event.usage) || inputTokens;
          outputTokens = Number(event.usage?.output_tokens) || outputTokens;
          break;

        case "error":
          yield failure(streamErrorMessage(event.error));
          yield "[DONE]";
          return;

        default:
          break;
      }
    }
  } catch (error) {
    yield failure(String(error?.message || "Upstream stream failed").slice(0, 500));
    yield "[DONE]";
    return;
  }

  yield chunk({}, finishReasonFor(stopReason, nextTool > 0));
  if (emitUsage) {
    yield JSON.stringify({
      id, object: "chat.completion.chunk", created, model, choices: [],
      usage: chatUsage(inputTokens || estimate, outputTokens)
    });
  }
  yield "[DONE]";
}
