import { randomUUID } from "node:crypto";
import { buildUpstreamRequest } from "./adapters.js";
import { streamErrorMessage, textPositionImageUnsupportedError, unsupportedMediaError } from "./bridge-utils.js";
import { isFileOrAudioPart, mediaOfChatPart, textPositionMediaError, toResponsesPart } from "./bridge-media.js";
import { readReasoning, responsesReasoning } from "./bridge-reasoning.js";

/**
 * OpenAI Responses as an UPSTREAM for the Anthropic, OpenAI chat and Gemini
 * client protocols.
 *
 * Like anthropic-upstream.js, this only translates chat <-> Responses: the
 * Anthropic and Gemini bridges already turn their requests into a chat request,
 * and consume chat chunks / chat.completion on the way back.
 *
 *   chatToResponsesRequest   chat request            -> Responses request
 *   responsesJsonToChat      Responses response      -> chat.completion
 *   responsesEventsToChat    Responses SSE events    -> chat.completion.chunk events
 *
 * With this, every client protocol can reach every upstream protocol.
 */

const newId = (prefix) => prefix + "_" + randomUUID().replace(/-/g, "").slice(0, 24);

/** OpenAI rejects a Responses `max_output_tokens` below 16. */
const MIN_OUTPUT_TOKENS = 16;

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function argsString(args) {
  if (typeof args === "string") return args || "{}";
  return JSON.stringify(args ?? {});
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

function userParts(content) {
  if (typeof content === "string") return content ? [{ type: "input_text", text: content }] : [];
  const parts = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (typeof part === "string") {
      if (part) parts.push({ type: "input_text", text: part });
    } else if (part?.type === "image_url") {
      const url = imageUrlOf(part);
      if (!url) {
        throw unsupportedMediaError(
          "This request carries an image with no URL. Send it as a data URL or an https URL, or remove the part."
        );
      }
      parts.push({ type: "input_image", image_url: url });
    } else if (part?.type === "file" || part?.type === "input_audio") {
      // A file becomes `input_file`; audio has no Responses form and is refused, never dropped.
      parts.push(toResponsesPart(mediaOfChatPart(part)));
    } else if (typeof part?.text === "string" && part.text) {
      parts.push({ type: "input_text", text: part.text });
    }
  }
  return parts;
}

/** OpenAI chat request -> OpenAI Responses request. */
export function chatToResponsesRequest(body, model) {
  const instructions = [];
  const input = [];

  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (!message || typeof message !== "object") continue;

    if (message.role === "system" || message.role === "developer") {
      const text = textOf(message.content);
      if (text) instructions.push(text);
    } else if (message.role === "assistant") {
      const text = textOf(message.content);
      if (text) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const fn = call?.function;
        if (!fn?.name) continue;
        input.push({ type: "function_call", call_id: call.id || newId("call"), name: fn.name, arguments: argsString(fn.arguments) });
      }
    } else if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: textOf(message.content) });
    } else {
      const content = userParts(message.content);
      if (content.length) input.push({ type: "message", role: "user", content });
    }
  }

  const payload = { model, input, store: false };
  if (instructions.length) payload.instructions = instructions.join("\n\n");
  if (body?.stream === true) payload.stream = true;

  const maxTokens = positiveInt(body?.max_completion_tokens) ?? positiveInt(body?.max_tokens);
  if (maxTokens) payload.max_output_tokens = Math.max(maxTokens, MIN_OUTPUT_TOKENS);
  if (typeof body?.temperature === "number") payload.temperature = body.temperature;
  if (typeof body?.top_p === "number") payload.top_p = body.top_p;

  const tools = [];
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) {
    const fn = tool?.type === "function" ? tool.function : null;
    if (!fn || typeof fn.name !== "string" || !fn.name) continue;
    tools.push({
      type: "function",
      name: fn.name,
      description: fn.description || "",
      parameters: fn.parameters || { type: "object", properties: {} }
    });
  }
  if (tools.length) {
    payload.tools = tools;
    const choice = body?.tool_choice;
    if (choice === "auto" || choice === "required" || choice === "none") payload.tool_choice = choice;
    else if (choice?.type === "function" && choice.function?.name) {
      payload.tool_choice = { type: "function", name: choice.function.name };
    }
  }

  const format = body?.response_format;
  if (format?.type === "json_schema" && format.json_schema?.schema) {
    payload.text = {
      format: {
        type: "json_schema",
        name: format.json_schema.name || "output",
        schema: format.json_schema.schema,
        strict: format.json_schema.strict === true
      }
    };
  } else if (format?.type === "json_object") {
    payload.text = { format: { type: "json_object" } };
  }

  const reasoning = responsesReasoning(readReasoning(body, "openai-chat"), { model });
  if (reasoning) payload.reasoning = reasoning;
  return payload;
}

/** The upstream fetch request for an OpenAI Responses target, from a chat body. */
export function buildResponsesFromChat(target, chatBody, incomingHeaders = {}) {
  const payload = chatToResponsesRequest(chatBody, target.model);
  const headers = { accept: payload.stream ? "text/event-stream" : "application/json" };
  if (incomingHeaders["user-agent"]) headers["user-agent"] = incomingHeaders["user-agent"];
  return buildUpstreamRequest(target, "openai-responses", payload, headers, { stream: payload.stream === true });
}

// ------------------------------------------------------- response -> chat

function chatUsage(input, output) {
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

function usageNumbers(usage) {
  const count = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  return { input: count(usage?.input_tokens), output: count(usage?.output_tokens) };
}

function finishReasonFor(response, hasToolCalls) {
  if (hasToolCalls) return "tool_calls";
  if (response?.status === "incomplete") {
    return response.incomplete_details?.reason === "content_filter" ? "content_filter" : "length";
  }
  return "stop";
}

/** OpenAI Responses response -> chat.completion. */
export function responsesJsonToChat(json, model, ctx = {}) {
  let text = "";
  const toolCalls = [];
  for (const item of Array.isArray(json?.output) ? json.output : []) {
    if (item?.type === "message") {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part?.type === "output_text" && typeof part.text === "string") text += part.text;
        else if (part?.type === "refusal" && typeof part.refusal === "string") text += part.refusal;
      }
    } else if (item?.type === "function_call") {
      toolCalls.push({
        id: item.call_id || item.id || newId("call"),
        type: "function",
        function: { name: item.name, arguments: argsString(item.arguments) }
      });
    }
    // reasoning items and hosted-tool calls have no chat equivalent.
  }

  const message = { role: "assistant", content: text || (toolCalls.length ? null : "") };
  if (toolCalls.length) message.tool_calls = toolCalls;

  const { input, output } = usageNumbers(json?.usage);
  return {
    id: newId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReasonFor(json, toolCalls.length > 0),
      logprobs: null
    }],
    usage: chatUsage(input || ctx.inputTokens || 0, output)
  };
}

/**
 * OpenAI Responses SSE -> chat.completion.chunk events.
 *
 * `events` is an async iterable of raw `data:` strings; the result is an async
 * iterable of raw chat-chunk JSON strings, ending with "[DONE]". A usage-only
 * chunk (`choices: []`) precedes "[DONE]" unless `emitUsage` is false. Never
 * throws: a failure after headers were sent becomes an `error` chunk followed by
 * "[DONE]".
 */
export async function* responsesEventsToChat(events, model, { emitUsage = true, inputTokens: estimate = 0 } = {}) {
  const id = newId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish = null) => JSON.stringify({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }]
  });
  const failure = (message) => JSON.stringify({ error: { message, type: "upstream_error" } });

  yield chunk({ role: "assistant", content: "" });

  // A function call is known by its item id, and by its output index too: the
  // argument events carry one or both depending on the provider.
  const tools = new Map();
  let nextTool = 0;
  let response = null;

  const toolFor = (event) => tools.get(event.item_id) ?? tools.get(`o${event.output_index}`);

  try {
    for await (const data of events) {
      if (data === "[DONE]") break;
      let event;
      try { event = JSON.parse(data); } catch { continue; }

      switch (event?.type) {
        case "response.output_item.added": {
          const item = event.item;
          if (item?.type !== "function_call") break;
          const tool = { index: nextTool++, streamed: false };
          if (item.id) tools.set(item.id, tool);
          tools.set(`o${event.output_index}`, tool);
          yield chunk({
            tool_calls: [{ index: tool.index, id: item.call_id || item.id || newId("call"), type: "function", function: { name: item.name, arguments: "" } }]
          });
          // Some providers send the whole call on the added event.
          if (typeof item.arguments === "string" && item.arguments) {
            tool.streamed = true;
            yield chunk({ tool_calls: [{ index: tool.index, function: { arguments: item.arguments } }] });
          }
          break;
        }

        case "response.output_text.delta":
        case "response.refusal.delta":
          if (typeof event.delta === "string" && event.delta) yield chunk({ content: event.delta });
          break;

        case "response.function_call_arguments.delta": {
          const tool = toolFor(event);
          if (tool && event.delta) {
            tool.streamed = true;
            yield chunk({ tool_calls: [{ index: tool.index, function: { arguments: event.delta } }] });
          }
          break;
        }

        case "response.function_call_arguments.done": {
          const tool = toolFor(event);
          // Only when no delta arrived: otherwise the arguments would be doubled.
          if (tool && !tool.streamed && typeof event.arguments === "string" && event.arguments) {
            tool.streamed = true;
            yield chunk({ tool_calls: [{ index: tool.index, function: { arguments: event.arguments } }] });
          }
          break;
        }

        case "response.completed":
        case "response.incomplete":
          response = event.response ?? response;
          break;

        case "response.failed":
          yield failure(streamErrorMessage(event.response?.error ?? { message: "Upstream response failed" }));
          yield "[DONE]";
          return;

        case "error":
          yield failure(streamErrorMessage(event.error ?? event));
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

  yield chunk({}, finishReasonFor(response, nextTool > 0));
  if (emitUsage) {
    const { input, output } = usageNumbers(response?.usage);
    yield JSON.stringify({
      id, object: "chat.completion.chunk", created, model, choices: [],
      usage: chatUsage(input || estimate, output)
    });
  }
  yield "[DONE]";
}
