/**
 * THE capability vocabulary, shared by the API, the Model Configurator UI and
 * the router.
 *
 * There are three different facts a capability checkbox can describe, and this
 * module keeps them apart on purpose:
 *
 *   declared     what the operator says a model can do (the checkbox)
 *   inferred     what this build assumes for a model nobody has declared yet:
 *                text in, text out, and streaming
 *   executable   what the adapter on the wire can actually carry
 *
 * A capability is only routable when the request requires it, the model
 * DECLARES it, and at least one adapter the target can speak can EXECUTE it.
 * Enabling a checkbox therefore never makes `image_output` work: no adapter in
 * this gateway has a wire form for it, so such a model is reported as
 * not executable and is skipped for that request instead of being sent a
 * payload the provider cannot accept.
 */

export const CAPABILITY_IDS = Object.freeze([
  "text_input",
  "text_output",
  "tool_calling",
  "image_input",
  "image_output",
  "video_input",
  "audio_input",
  "audio_output",
  "file_input",
  "structured_output",
  "streaming",
  "reasoning",
  "embeddings",
  "audio_transcription",
  "audio_translation",
  "realtime_audio",
  "file_search",
  "computer_use",
  "reranking",
  "moderation"
]);

const CAPABILITY_SET = new Set(CAPABILITY_IDS);

/**
 * The schema the UI renders. `group` is a display hint only; `requestable`
 * says whether a request can REQUIRE the capability (reasoning is a preference
 * the router never hard-filters on, so requiring it would break plain chat).
 */
export const CAPABILITY_INFO = Object.freeze([
  { id: "text_input", label: "Text input", group: "Text", requestable: true,
    description: "Accepts text prompts." },
  { id: "text_output", label: "Text output", group: "Text", requestable: true,
    description: "Returns generated text." },
  { id: "tool_calling", label: "Tool calling", group: "Tools and formats", requestable: true,
    description: "Accepts tool/function definitions and can call them." },
  { id: "structured_output", label: "Structured output", group: "Tools and formats", requestable: true,
    description: "Honours a JSON schema / JSON-object response format." },
  { id: "streaming", label: "Streaming", group: "Tools and formats", requestable: true,
    description: "Can answer as server-sent events." },
  { id: "reasoning", label: "Reasoning", group: "Tools and formats", requestable: false,
    description: "Supports a reasoning / thinking control. A preference, never a hard filter." },
  { id: "file_search", label: "File search", group: "Tools and formats", requestable: true,
    description: "Runs a provider-side file search / retrieval tool (e.g. OpenAI Responses file_search)." },
  { id: "computer_use", label: "Computer use", group: "Tools and formats", requestable: true,
    description: "Controls a computer desktop or browser via Anthropic's computer use tools." },
  { id: "image_input", label: "Image input", group: "Media", requestable: true,
    description: "Accepts image content parts." },
  { id: "image_output", label: "Image output", group: "Media", requestable: true,
    description: "Generates images. Executable over OpenAI chat and Gemini targets." },
  { id: "audio_input", label: "Audio input", group: "Media", requestable: true,
    description: "Accepts inline audio content parts." },
  { id: "audio_output", label: "Audio output", group: "Media", requestable: true,
    description: "Generates speech/audio. Executable over OpenAI chat and Gemini targets." },
  { id: "audio_transcription", label: "Audio transcription", group: "Media", requestable: true,
    description: "Transcribes speech/audio into text (e.g. Whisper models). Served by POST /v1/audio/transcriptions (OpenAI-compatible and Gemini targets)." },
  { id: "audio_translation", label: "Audio translation", group: "Media", requestable: true,
    description: "Translates audio into English text. Served by POST /v1/audio/translations (OpenAI-compatible and Gemini targets)." },
  { id: "realtime_audio", label: "Realtime audio", group: "Media", requestable: true,
    description: "Low-latency bidirectional audio streaming. Served by the WebSocket endpoint /v1/realtime over OpenAI-compatible targets." },
  { id: "video_input", label: "Video input", group: "Media", requestable: true,
    description: "Accepts video content parts." },
  { id: "file_input", label: "File input", group: "Media", requestable: true,
    description: "Accepts document/file content parts (for example PDFs)." },
  { id: "embeddings", label: "Embeddings", group: "Advanced", requestable: true,
    description: "Produces embeddings. Served by POST /v1/embeddings (OpenAI-compatible and Gemini targets)." },
  { id: "reranking", label: "Reranking", group: "Advanced", requestable: true,
    description: "Reranks candidate search results or documents (e.g. Cohere / Jina). Served by POST /v1/rerank over OpenAI-compatible targets." },
  { id: "moderation", label: "Moderation", group: "Advanced", requestable: true,
    description: "Checks text against safety and content moderation policies. Served by POST /v1/moderations over OpenAI-compatible targets." }
]);

const INFO_BY_ID = new Map(CAPABILITY_INFO.map((entry) => [entry.id, entry]));

export function isCapabilityId(value) {
  return CAPABILITY_SET.has(String(value ?? "").trim());
}

export function capabilityLabel(id) {
  return INFO_BY_ID.get(id)?.label ?? String(id ?? "");
}

/** True when a request can require the capability (reasoning cannot). */
export function isRequestableCapability(id) {
  return INFO_BY_ID.get(id)?.requestable === true;
}

/**
 * Normalizes a capability list: known ids only, de-duplicated, in schema order.
 * Unknown ids are returned separately so a caller can warn without rejecting a
 * save — the schema is extensible, so an id from a newer build must not make an
 * older one fail, but it must never be persisted as if it were understood
 * either.
 */
export function normalizeCapabilities(value) {
  const input = Array.isArray(value) ? value : [];
  const unknown = [];
  const known = new Set();
  for (const raw of input) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id) continue;
    if (!CAPABILITY_SET.has(id)) {
      if (!unknown.includes(id)) unknown.push(id.slice(0, 60));
      continue;
    }
    known.add(id);
  }
  return {
    capabilities: CAPABILITY_IDS.filter((id) => known.has(id)),
    unknown
  };
}

/** Keeps only requestable ids, in schema order, de-duplicated. */
export function normalizeRequirements(value) {
  const { capabilities } = normalizeCapabilities(value);
  return capabilities.filter(isRequestableCapability);
}

/**
 * What each upstream protocol can actually carry. This is deliberately
 * conservative: a capability is listed only when the adapter (or the bridge
 * that speaks this protocol) has a wire form for it today.
 *
 * Supported provider features:
 *   - anthropic: computer_use (via native Anthropic tools like computer_20241022)
 *   - openai-responses: file_search (via native Responses API file_search tool)
 */
/** Capabilities served by their own endpoint (`/v1/embeddings`, `/v1/rerank`, ...), not by chat. */
export const MEDIA_ROUTE_CAPABILITIES = Object.freeze([
  "embeddings", "reranking", "moderation", "audio_transcription", "audio_translation", "realtime_audio"
]);

/** The subset Gemini's native REST API can serve (src/media-gemini.js). It has no rerank or moderation endpoint. */
const GEMINI_MEDIA_CAPABILITIES = Object.freeze(["embeddings", "audio_transcription", "audio_translation"]);

const CHAT_LIKE = [
  "text_input", "text_output", "streaming", "tool_calling", "structured_output",
  "image_input", "audio_input", "file_input", "reasoning",
  // Generated images and audio ride on the chat wire (`modalities`), returned in the message.
  "image_output", "audio_output"
];

export const ADAPTER_CAPABILITIES = Object.freeze({
  // Chat passes `video_url` parts through untouched; Responses has no video part.
  // The dedicated OpenAI-compatible media routes (src/media-routes.js) are forwarded over this
  // wire only: Responses, Anthropic and Gemini have no embeddings/rerank/moderation/audio form here.
  "openai-chat": Object.freeze([...CHAT_LIKE, "video_input", ...MEDIA_ROUTE_CAPABILITIES]),
  // The Responses API has no audio input part, so it is not listed here: a request needing
  // audio_input is routed to chat / Gemini targets instead of reaching a bridge that must refuse.
  // Generated media has no Responses wire form here either.
  "openai-responses": Object.freeze([
    ...CHAT_LIKE.filter((id) => !["audio_input", "image_output", "audio_output"].includes(id)),
    "file_search",
    ...MEDIA_ROUTE_CAPABILITIES
  ]),
  anthropic: Object.freeze([
    "text_input", "text_output", "streaming", "tool_calling",
    "image_input", "file_input", "reasoning", "computer_use"
  ]),
  gemini: Object.freeze([
    "text_input", "text_output", "streaming", "tool_calling", "structured_output",
    "image_input", "audio_input", "video_input", "file_input", "reasoning",
    "image_output", "audio_output",
    ...GEMINI_MEDIA_CAPABILITIES
  ])
});

/** Union of what every protocol a target speaks can execute. */
export function adapterCapabilities(protocols) {
  const out = new Set();
  for (const protocol of Array.isArray(protocols) ? protocols : []) {
    for (const id of ADAPTER_CAPABILITIES[protocol] ?? []) out.add(id);
  }
  // An unknown protocol can execute nothing: fail closed rather than assume the
  // OpenAI wire format.
  return out;
}

/** Which declared capabilities no adapter can execute for this target. */
export function unsupportedCapabilities(capabilities, protocols) {
  const executable = adapterCapabilities(protocols);
  return normalizeCapabilities(capabilities).capabilities.filter((id) => !executable.has(id));
}

/**
 * The capabilities a model has until somebody declares otherwise: text_input,
 * text_output, and streaming, and NOTHING else.
 *
 * Optional capabilities (tool_calling, image_input, image_output, audio_*,
 * video_input, file_input, structured_output, reasoning, embeddings)
 * are never inferred from a model name, a provider, a protocol or a former pool membership. They stay false until the
 * operator declares them in the Model Configurator, and even then a request
 * only reaches the model when an adapter it speaks can execute them (see
 * `evaluateCandidate`). The default does not depend on the model's protocols:
 * an undeclared model is text-in/text-out/streaming whether or not a provider currently
 * configures it.
 *
 * `capabilitiesSource` is "inferred" so every surface can say the claim is
 * provisional.
 */
export const DEFAULT_CAPABILITIES = Object.freeze(["text_input", "text_output", "streaming"]);

export function inferCapabilities() {
  return [...DEFAULT_CAPABILITIES];
}

/**
 * The routing decision for one candidate.
 *
 * Returns `{ eligible, reason, missing }` where `reason` is a fixed label safe
 * to log and show (never upstream text):
 *
 *   model_config_disabled    the unified configuration switched it off
 *   capability_not_configured  the model does not declare a required capability
 *   adapter_unsupported      it declares it, but no adapter can execute it
 */
export function evaluateCandidate({ required = [], declared = [], protocols = [], enabled = true } = {}) {
  if (enabled === false) return { eligible: false, reason: "model_config_disabled", missing: [] };
  const needs = normalizeRequirements(required);
  if (needs.length === 0) return { eligible: true, reason: null, missing: [] };

  const have = new Set(normalizeCapabilities(declared).capabilities);
  const executable = adapterCapabilities(protocols);

  const missingConfigured = needs.filter((id) => !have.has(id));
  if (missingConfigured.length > 0) {
    return { eligible: false, reason: "capability_not_configured", missing: missingConfigured };
  }
  const missingAdapter = needs.filter((id) => !executable.has(id));
  if (missingAdapter.length > 0) {
    return { eligible: false, reason: "adapter_unsupported", missing: missingAdapter };
  }
  // Every need is executable by SOME protocol of the target, but one call goes
  // out over ONE protocol: at least one protocol must carry them all together.
  // (e.g. structured_output from openai-chat plus computer_use from anthropic is
  // not a route if neither protocol can do both.)
  if (protocolsExecuting(needs, protocols).length === 0) {
    return { eligible: false, reason: "adapter_unsupported", missing: needs };
  }
  return { eligible: true, reason: null, missing: [] };
}

/**
 * The protocols of a target that can execute EVERY required capability in a
 * single call. A request goes upstream over exactly one protocol, so this is
 * the set the call may use; an empty list means no single protocol can carry
 * the request.
 */
export function protocolsExecuting(required = [], protocols = []) {
  const needs = normalizeRequirements(required);
  return (Array.isArray(protocols) ? protocols : []).filter((protocol) => {
    const executable = new Set(ADAPTER_CAPABILITIES[protocol] ?? []);
    return needs.every((id) => executable.has(id));
  });
}

/**
 * Filters a target list for one request. `lookup(target)` returns the effective
 * model entry (`{ enabled, capabilities }`) from the unified configuration.
 *
 * The input is never mutated and every exclusion carries a reason and the
 * capability ids that caused it, so a caller can explain the route it did not
 * take without guessing. Exclusions are de-duplicated by provider/model: the
 * reason is a property of the model, not of each key.
 */
export function filterTargetsByRequirements(targets, required = [], lookup = () => null) {
  const eligible = [];
  const exclusions = [];
  const seen = new Set();

  for (const target of Array.isArray(targets) ? targets : []) {
    const entry = lookup(target) ?? {};
    const verdict = evaluateCandidate({
      required,
      declared: entry.capabilities ?? [],
      protocols: target?.protocols ?? [],
      enabled: entry.enabled !== false
    });

    if (verdict.eligible) {
      // Narrow the target to the protocols that can carry THIS request, so the
      // protocol picked later (which only knows preference order) cannot land
      // on one that would drop or refuse a required capability.
      const usable = protocolsExecuting(required, target?.protocols ?? []);
      const narrowed = usable.length > 0 && usable.length < (target?.protocols ?? []).length
        ? { ...target, protocols: usable }
        : target;
      eligible.push(narrowed);
      continue;
    }

    const id = `${target?.provider ?? ""}/${target?.model ?? ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    exclusions.push({
      provider: target?.provider ?? null,
      model: target?.model ?? null,
      reason: verdict.reason,
      missing: verdict.missing
    });
  }

  return { eligible, exclusions };
}

/** A safe, bounded message for "no model can serve this". */
export function noCapableRouteMessage(required) {
  const needs = normalizeRequirements(required);
  const list = needs.map(capabilityLabel).join(", ");
  return `No configured model can serve this request: it requires ${list || "capabilities no model declares"}.`
    + " Configure a compatible model in the Model Configurator.";
}

/**
 * Capability validation for a client that named a model explicitly.
 *
 * A model the router knows nothing about keeps the historical "widen to every compatible target"
 * behaviour (custom and freshly released ids must keep working), while a model
 * the unified configuration DOES know is rejected clearly when none of its
 * provider entries can satisfy the request. Silently answering with a different
 * model would be worse than an error.
 *
 * `index` is the effective model index from model-config.js (Map keyed
 * `provider/model`). Only capabilities are judged here: `enabled` is a routing
 * decision with its own error (`models_disabled`), so a model that is switched
 * off but capable is not reported as a capability mismatch.
 */
export function validateRequestedModel(index, modelId, required = []) {
  const wanted = typeof modelId === "string" ? modelId.trim() : "";
  if (!wanted || !index || typeof index.values !== "function") return null;
  const needs = normalizeRequirements(required);
  if (needs.length === 0) return null;

  const matches = [...index.values()].filter((row) => row.model === wanted && row.configuredInEnvironment !== false);
  if (matches.length === 0) return null;

  const providers = matches.map((row) => {
    const verdict = evaluateCandidate({
      required: needs,
      declared: row.capabilities,
      protocols: row.protocols
    });
    return { provider: row.provider, eligible: verdict.eligible, reason: verdict.reason, missing: verdict.missing };
  });

  if (providers.some((entry) => entry.eligible)) return null;
  return { model: wanted, required: needs, providers };
}

/** The message an operator sees when their explicit model cannot serve the request. */
export function requestedModelCapabilityMessage(rejection) {
  const needs = (rejection?.required ?? []).map(capabilityLabel).join(", ");
  return `Model "${rejection?.model}" cannot serve this request: it requires ${needs || "capabilities the model does not declare"}.`;
}
