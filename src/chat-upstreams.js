import { anthropicEventsToChat, anthropicJsonToChat } from "./anthropic-upstream.js";
import { responsesEventsToChat, responsesJsonToChat } from "./responses-upstream.js";

/**
 * Upstreams that are reached by translating to and from OpenAI chat.
 *
 * Gemini clients consume plain chat JSON / chat chunks, so for an upstream that
 * is not itself chat-shaped this converts the response first. A chat upstream
 * passes through untouched.
 */

export function upstreamJsonToChat(upstreamProtocol, json, model, ctx = {}) {
  if (upstreamProtocol === "anthropic") return anthropicJsonToChat(json, model, ctx);
  if (upstreamProtocol === "openai-responses") return responsesJsonToChat(json, model, ctx);
  return json;
}

export function upstreamEventsToChat(upstreamProtocol, events, model, options = {}) {
  if (upstreamProtocol === "anthropic") return anthropicEventsToChat(events, model, options);
  if (upstreamProtocol === "openai-responses") return responsesEventsToChat(events, model, options);
  return events;
}
