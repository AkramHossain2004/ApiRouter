/**
 * Reasoning controls across the four protocols.
 *
 *   chat       reasoning_effort: "minimal"|"low"|"medium"|"high"  (or reasoning:{effort})
 *   responses  reasoning: { effort }
 *   anthropic  thinking: { type: "enabled", budget_tokens }
 *   gemini     generationConfig.thinkingConfig: { thinkingBudget | thinkingLevel }
 *
 * A bridge used to drop all of them, so a client asking for deep reasoning got a
 * plain answer. They are now translated through one canonical form
 * `{ effort, budget }`. Because a model that does not reason rejects these fields
 * outright, they are only forwarded to a target that DECLARES the `reasoning`
 * capability (`withoutReasoning` strips them for every other target).
 */

const EFFORT_BUDGET = Object.freeze({ minimal: 1024, low: 1024, medium: 4096, high: 16384 });
export const MIN_THINKING_BUDGET = 1024;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function effortFromBudget(budget) {
  if (!Number.isFinite(budget) || budget <= 0) return null;
  if (budget <= 2048) return "low";
  if (budget <= 8192) return "medium";
  return "high";
}

const normEffort = (value) => {
  const text = String(value ?? "").toLowerCase();
  if (text === "minimal" || text === "low" || text === "medium" || text === "high") return text;
  if (text === "xhigh" || text === "max") return "high";
  return null;
};

/** Canonical `{ effort, budget }` from a request in `clientProtocol`, or null when none was asked for. */
export function readReasoning(body, clientProtocol) {
  if (!isObject(body)) return null;
  let effort = null;
  let budget = null;

  if (clientProtocol === "openai-chat") {
    effort = normEffort(body.reasoning_effort ?? body.reasoning?.effort);
  } else if (clientProtocol === "openai-responses") {
    effort = normEffort(body.reasoning?.effort);
  } else if (clientProtocol === "anthropic") {
    const thinking = body.thinking;
    if (isObject(thinking) && thinking.type === "enabled" && Number.isFinite(thinking.budget_tokens)) budget = thinking.budget_tokens;
    else if (isObject(thinking) && thinking.type === "adaptive") effort = "medium";
  } else if (clientProtocol === "gemini") {
    const config = body.generationConfig ?? body.generation_config;
    const thinking = config?.thinkingConfig ?? config?.thinking_config;
    if (isObject(thinking)) {
      const value = thinking.thinkingBudget ?? thinking.thinking_budget;
      if (Number.isFinite(value) && value > 0) budget = value;
      effort = normEffort(thinking.thinkingLevel ?? thinking.thinking_level);
    }
  }

  if (!effort && budget === null) return null;
  return {
    effort: effort ?? effortFromBudget(budget),
    budget: budget ?? EFFORT_BUDGET[effort]
  };
}

/** A copy of the request without any reasoning control (for targets that do not declare `reasoning`). */
export function withoutReasoning(body) {
  if (!isObject(body)) return body;
  const hasTop = "reasoning_effort" in body || "reasoning" in body || "thinking" in body || "enable_thinking" in body;
  const config = body.generationConfig ?? body.generation_config;
  const hasGemini = isObject(config) && ("thinkingConfig" in config || "thinking_config" in config);
  if (!hasTop && !hasGemini) return body;

  const { reasoning_effort, reasoning, thinking, enable_thinking, ...rest } = body;
  if (hasGemini) {
    const key = body.generationConfig ? "generationConfig" : "generation_config";
    const { thinkingConfig, thinking_config, ...cleaned } = config;
    rest[key] = cleaned;
  }
  return rest;
}

/** `reasoning_effort` for an OpenAI chat request. */
export const chatEffort = (reasoning) => reasoning?.effort ?? null;

/** Responses `reasoning` object. */
export const responsesReasoning = (reasoning) => (reasoning?.effort ? { effort: reasoning.effort } : null);

/** Gemini `thinkingConfig`. */
export const geminiThinking = (reasoning) => (reasoning ? { thinkingBudget: reasoning.budget } : null);

/**
 * Anthropic `thinking`, or null when it cannot be requested correctly: the
 * budget must be at least 1024 and leave room in `max_tokens` for the visible
 * answer (at most three quarters of it). The caller decides whether thinking
 * is compatible with the rest of the request.
 */
export function anthropicThinking(reasoning, maxTokens) {
  if (!reasoning) return null;
  const budget = Math.min(reasoning.budget, Math.floor((Number(maxTokens) || 0) * 0.75));
  if (!(budget >= MIN_THINKING_BUDGET)) return null;
  return { type: "enabled", budget_tokens: budget };
}
