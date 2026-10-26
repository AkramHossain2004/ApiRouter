/**
 * True when an upstream 400 body says the model id itself was rejected (unknown,
 * invalid, missing or unavailable). A complaint ABOUT a request parameter that
 * merely mentions the model ("temperature is not supported with this model",
 * "tools are not supported by this model", "this model supports at most 4096")
 * belongs to that one request, so it is not a model rejection and must not park
 * the model for every other client.
 */
const MODEL_REJECTION_PATTERNS = [
  /\bmodel_not_found\b/i,
  /\b(?:unknown|invalid|unrecognized|unrecognised|unsupported|nonexistent|non-existent|no such)\s+model\b/i,
  /\bmodel\b[^.]{0,80}?\b(?:does not exist|doesn't exist|not found|not a valid|is not valid|is invalid|is unavailable|not available)\b/i,
  /\b(?:cannot|can't|could not|couldn't) find (?:the )?model\b/i,
  /\bmodel\b[^.]{0,40}\bis not supported\b/i
];

export function isModelRejection(message) {
  const text = String(message || "");
  return MODEL_REJECTION_PATTERNS.some((pattern) => pattern.test(text));
}
