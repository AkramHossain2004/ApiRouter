/**
 * Dedicated OpenAI-compatible endpoints that are not chat:
 *
 *   POST /v1/embeddings            capability: embeddings
 *   POST /v1/rerank                capability: reranking
 *   POST /v1/moderations           capability: moderation
 *   POST /v1/images/generations    capability: image_output
 *   POST /v1/audio/speech          capability: audio_output   (binary audio back)
 *   POST /v1/audio/transcriptions  capability: audio_transcription (multipart upload)
 *   POST /v1/audio/translations    capability: audio_translation   (multipart upload)
 *
 * Wires: an OpenAI-compatible or Responses-only target is forwarded as-is (same API
 * root); a Gemini target gets a native translation (src/media-gemini.js) for embeddings,
 * images, speech, transcription and translation. Anthropic has no such API and is never
 * a candidate; Gemini has no rerank / moderation, so those stay on the OpenAI wire.
 *
 * Routing rules, deliberately narrower than the chat route:
 *   - Only a model that DECLARES the capability (Model Configurator) and has a wire
 *     for it is a candidate. A text-only model is never tried.
 *   - Candidates are walked in health order. There is NO preference ordering and
 *     the Manual Selection list is not consulted: a selection list is about chat
 *     models and would conflict with these capability-specific pools.
 *   - A client `model` that names a capable model narrows the walk to that model
 *     (every key of it); an unknown or non-capable name widens to all capable
 *     targets, like the chat route's behaviour for ids it does not know.
 *   - The upstream always receives the TARGET's model id, never the client's.
 *   - Retryable upstream failures and network errors fall through to the next
 *     candidate; a client error (400/422...) is the client's, so it is relayed
 *     as-is and the target is not penalised.
 */
import { analyzeRequest } from "./request-profile.js";
import {
  filterTargetsByRequirements,
  noCapableRouteMessage,
  requestedModelCapabilityMessage,
  validateRequestedModel
} from "./model-capabilities.js";
import {
  RATE_LIMIT_COOLDOWN_MS,
  RATE_LIMIT_MIN_COOLDOWN_MS,
  RATE_LIMIT_MAX_COOLDOWN_MS,
  isRetryableStatus,
  parseRetryAfterMs
} from "./router.js";
import { openAiSuffixPath } from "./url-utils.js";
import { GEMINI_MEDIA_PATHS, GeminiMediaError, buildGeminiRequest, translateGeminiResponse } from "./media-gemini.js";

export const MEDIA_ROUTES = Object.freeze({
  "/v1/embeddings": Object.freeze({ suffix: "embeddings", body: "json", needs: ["input"] }),
  "/v1/rerank": Object.freeze({ suffix: "rerank", body: "json", needs: ["query", "documents"] }),
  "/v1/moderations": Object.freeze({ suffix: "moderations", body: "json", needs: ["input"] }),
  "/v1/images/generations": Object.freeze({ suffix: "images/generations", body: "json", needs: ["prompt"] }),
  "/v1/audio/speech": Object.freeze({ suffix: "audio/speech", body: "json", needs: ["input"] }),
  "/v1/audio/transcriptions": Object.freeze({ suffix: "audio/transcriptions", body: "multipart", needs: ["file"] }),
  "/v1/audio/translations": Object.freeze({ suffix: "audio/translations", body: "multipart", needs: ["file"] })
});

export const isMediaRoute = (pathname) => Object.hasOwn(MEDIA_ROUTES, pathname);

const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");

class HttpError extends Error {
  constructor(status, message, type = "invalid_request_error") {
    super(message);
    this.status = status;
    this.errorType = type;
  }
}

async function readRawBody(req, maxBytes) {
  const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0 ? Number(maxBytes) : 10 * 1024 * 1024;
  const tooLarge = () => new HttpError(413, `Request body exceeds the maximum allowed size of ${limit} bytes`);
  const declared = Number(req.headers?.["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    throw tooLarge();
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += Buffer.byteLength(chunk);
    if (total > limit) {
      req.resume();
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The multipart boundary from a Content-Type header, or null. */
export function multipartBoundary(contentType) {
  const match = /^\s*multipart\/form-data\s*;.*?\bboundary\s*=\s*(?:"([^"]+)"|([^\s;]+))/i.exec(String(contentType || ""));
  return match ? (match[1] ?? match[2]) : null;
}

/**
 * Splits a multipart body into its parts without touching their bytes.
 * Binary safe: only Buffer search is used, a file's content is never decoded.
 */
function parseMultipart(raw, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const marks = [];
  for (let at = raw.indexOf(delimiter); at !== -1; at = raw.indexOf(delimiter, at + delimiter.length)) marks.push(at);
  if (marks.length < 2) throw new HttpError(400, "Malformed multipart/form-data body");

  const parts = [];
  let closed = false;
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i] + delimiter.length;
    const end = i + 1 < marks.length ? marks[i + 1] : raw.length;
    const segment = raw.subarray(start, end);
    if (segment.subarray(0, 2).toString("latin1") === "--") { closed = true; break; }
    if (!segment.subarray(0, 2).equals(CRLF)) throw new HttpError(400, "Malformed multipart/form-data body");
    const headerEnd = segment.indexOf(HEADER_END, 2);
    if (headerEnd === -1) throw new HttpError(400, "Malformed multipart/form-data body");
    const headers = segment.subarray(2, headerEnd).toString("latin1");
    let body = segment.subarray(headerEnd + HEADER_END.length);
    // The CRLF before the next delimiter belongs to the delimiter, not the value.
    if (body.length >= 2 && body.subarray(body.length - 2).equals(CRLF)) body = body.subarray(0, body.length - 2);
    const name = /\bname\s*=\s*"([^"]*)"/i.exec(headers)?.[1] ?? null;
    const isFile = /\bfilename\s*=/i.test(headers);
    parts.push({ headers, body, name, isFile });
  }
  if (!closed) throw new HttpError(400, "Malformed multipart/form-data body: missing closing boundary");
  return { delimiter, parts };
}

export function multipartFields(raw, boundary) {
  const { parts } = parseMultipart(raw, boundary);
  const fields = new Map();
  for (const part of parts) if (part.name && !fields.has(part.name)) fields.set(part.name, part);
  return fields;
}

/** Same upload, with its `model` field set to `model` (added when absent). Every other byte is kept. */
export function withMultipartModel(raw, boundary, model) {
  const { delimiter, parts } = parseMultipart(raw, boundary);
  const out = [];
  let replaced = false;
  const emit = (headers, body) => {
    out.push(delimiter, CRLF, Buffer.from(headers, "latin1"), HEADER_END, body, CRLF);
  };
  for (const part of parts) {
    if (!replaced && part.name === "model" && !part.isFile) {
      emit(part.headers, Buffer.from(String(model), "utf8"));
      replaced = true;
    } else if (part.name === "model" && !part.isFile) {
      continue; // a duplicate `model` field would let the client's id through
    } else {
      emit(part.headers, part.body);
    }
  }
  if (!replaced) emit('Content-Disposition: form-data; name="model"', Buffer.from(String(model), "utf8"));
  out.push(delimiter, Buffer.from("--\r\n"));
  return Buffer.concat(out);
}

const upstreamUrl = (target, route) => {
  const base = String(target.baseUrl || "").replace(/\/+$/, "");
  return `${base}/${openAiSuffixPath(base, route.suffix)}`;
};

const failureReason = (status) => `media route: upstream answered ${status}`;

/**
 * @param {object} deps
 *   getTargets()        the live target array (custom endpoints are spliced into it)
 *   modelConfig         unified model configuration (index / explicitlyDisabled)
 *   health              HealthRegistry
 *   config              loaded config (maxBodyBytes, timeoutMs)
 *   authorized(req)     router API key check
 *   isPaused()          gateway master switch
 *   respondPaused(res)  the paused response
 *   json(res, status, body, headers)
 *   recordRequest(fields)
 *   fetchImpl           defaults to global fetch (injected by tests)
 */
export function createMediaRoutes(deps) {
  const {
    getTargets, modelConfig, health, config, authorized, isPaused, respondPaused, json, recordRequest,
    fetchImpl = (...args) => globalThis.fetch(...args)
  } = deps;

  const fail = (res, receivedAt, requestedModel, status, type, message, attempts = []) => {
    recordRequest({
      receivedAt, completedAt: Date.now(), protocol: "openai-chat", requestedModel,
      httpStatus: status, outcome: "failed", errorType: type, errorMessage: message, attempts: []
    });
    return json(res, status, { error: { message, type, ...(attempts.length > 0 ? { attempts } : {}) } });
  };

  async function callUpstream(url, headers, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(url, { method: "POST", headers, body: payload, signal: controller.signal, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        try { await response.body?.cancel(); } catch { /* already closed */ }
        throw new Error("upstream answered with a redirect; redirects are not followed");
      }
      const body = Buffer.from(await response.arrayBuffer());
      return { status: response.status, headers: response.headers, body };
    } finally {
      clearTimeout(timer);
    }
  }

  const asHeaders = (plain) => ({ get: (name) => plain[String(name).toLowerCase()] ?? null });

  async function handle(req, res, pathname) {
    const receivedAt = Date.now();
    const route = MEDIA_ROUTES[pathname];

    if (!authorized(req)) {
      return json(res, 401, { error: { message: "Unauthorized", type: "authentication_error" } });
    }
    if (isPaused()) return respondPaused(res);

    // ---- read and validate the client's request ---------------------------
    let raw;
    let requestedModel = "";
    let payloadFor;
    let contentTypeFor;
    let geminiInput;
    try {
      raw = await readRawBody(req, config.maxBodyBytes);
      const incomingType = String(req.headers["content-type"] || "");

      if (route.body === "multipart") {
        const boundary = multipartBoundary(incomingType);
        if (!boundary) throw new HttpError(400, "This endpoint expects multipart/form-data");
        const fields = multipartFields(raw, boundary);
        for (const need of route.needs) {
          if (!fields.has(need)) throw new HttpError(400, `Missing required field: ${need}`);
        }
        const modelPart = fields.get("model");
        requestedModel = modelPart && !modelPart.isFile ? modelPart.body.toString("utf8").trim() : "";
        payloadFor = (target) => withMultipartModel(raw, boundary, target.model);
        contentTypeFor = () => incomingType;
        geminiInput = { fields };
      } else {
        let body = {};
        if (raw.length > 0) {
          try { body = JSON.parse(raw.toString("utf8")); }
          catch { throw new HttpError(400, "Invalid JSON request body"); }
        }
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          throw new HttpError(400, "Request body must be a JSON object");
        }
        for (const need of route.needs) {
          if (body[need] === undefined || body[need] === null || body[need] === "") {
            throw new HttpError(400, `Missing required field: ${need}`);
          }
        }
        requestedModel = typeof body.model === "string" ? body.model.trim() : "";
        payloadFor = (target) => JSON.stringify({ ...body, model: target.model });
        contentTypeFor = () => "application/json";
        geminiInput = { body };
      }
    } catch (error) {
      const status = error.status || 400;
      return fail(res, receivedAt, requestedModel, status, error.errorType || "invalid_request_error", error.message);
    }

    // ---- which models may serve it ----------------------------------------
    // The endpoint decides the requirement; the body is not analysed (an
    // embeddings `input` or an audio `file` is not chat media).
    const profile = analyzeRequest({ pathname, body: {} });
    const targets = getTargets();
    const modelIndex = modelConfig.index(targets);
    const configured = targets.map((target) => {
      const hint = modelIndex.get(`${target.provider}/${target.model}`)?.protocol;
      const protocols = target.protocols ?? [];
      return hint && protocols.length > 1 && protocols.includes(hint) ? { ...target, protocols: [hint] } : target;
    });
    const enabled = configured.filter((target) => !modelConfig.explicitlyDisabled(target.provider, target.model));
    const lookup = (target) => modelIndex.get(`${target.provider}/${target.model}`);
    // Each target is judged on the wire this endpoint would use for it. A Responses-only target
    // shares the OpenAI API root, so it is forwarded the same way; Anthropic has no wire here.
    const geminiServes = GEMINI_MEDIA_PATHS.includes(pathname);
    const wired = [];
    for (const target of enabled) {
      const protocols = target.protocols ?? [];
      if (protocols.includes("openai-chat") || protocols.includes("openai-responses")) wired.push({ ...target, protocols: ["openai-chat"], wire: "openai" });
      else if (protocols.includes("gemini") && geminiServes) wired.push({ ...target, protocols: ["gemini"], wire: "gemini" });
    }
    const { eligible } = filterTargetsByRequirements(wired, profile.required, lookup);

    const rejection = validateRequestedModel(modelIndex, requestedModel, profile.required);
    if (rejection) {
      return fail(res, receivedAt, requestedModel, 400, "model_capability_mismatch", requestedModelCapabilityMessage(rejection));
    }
    // A model the gateway knows, named on purpose, that has no wire for this endpoint (an
    // Anthropic-only target, a Gemini model on /v1/rerank): say so rather than answer with another model.
    if (requestedModel && enabled.some((t) => t.model === requestedModel) && !eligible.some((t) => t.model === requestedModel)) {
      return fail(res, receivedAt, requestedModel, 400, "model_capability_mismatch",
        `Model "${requestedModel.slice(0, 120)}" cannot serve ${pathname}: it is not declared for it, or its provider has no ${pathname} API.`);
    }
    if (configured.length > 0 && enabled.length === 0) {
      return fail(res, receivedAt, requestedModel, 503, "models_disabled", "Every model is switched off in the Model Configurator");
    }
    if (eligible.length === 0) {
      return fail(res, receivedAt, requestedModel, 503, "no_capable_route", noCapableRouteMessage(profile.required));
    }

    // A capable model named by the client narrows the walk to it; anything else widens.
    const named = eligible.filter((target) => target.model === requestedModel);
    const pool = named.length > 0 ? named : eligible;
    const usable = pool.filter((target) => health.isAvailable(target));
    if (usable.length === 0) {
      res.setHeader?.("retry-after", "30");
      return fail(res, receivedAt, requestedModel, 503, "no_available_route",
        "Every capable model is cooling down after recent failures. Try again shortly.");
    }

    // ---- walk the candidates ------------------------------------------------
    const attempts = [];
    let buildError = null;
    for (const target of health.rank(usable)) {
      const startedAt = Date.now();
      let result;
      let geminiCtx = null;
      try {
        if (target.wire === "gemini") {
          let built;
          try { built = buildGeminiRequest(pathname, target, geminiInput); }
          catch (error) {
            if (!(error instanceof GeminiMediaError)) throw error;
            // This request cannot be expressed on this target; another wire may still take it.
            buildError = error;
            continue;
          }
          geminiCtx = built.ctx;
          result = await callUpstream(built.url, built.headers, built.body);
        } else {
          const headers = { authorization: `Bearer ${target.apiKey}`, accept: req.headers.accept || "*/*", "content-type": contentTypeFor() };
          if (req.headers["user-agent"]) headers["user-agent"] = req.headers["user-agent"];
          result = await callUpstream(upstreamUrl(target, route), headers, payloadFor(target));
        }
      } catch (error) {
        const timedOut = error?.name === "AbortError";
        const status = timedOut ? 504 : 502;
        health.markFailure(target, status, { reason: timedOut ? "media route: upstream timed out" : "media route: upstream unreachable" });
        attempts.push({ provider: target.provider, model: target.model, status, error: timedOut ? "timeout" : "unreachable" });
        continue;
      }

      if (geminiCtx) {
        const retryAfter = result.headers.get("retry-after");
        const translated = translateGeminiResponse(geminiCtx, result.status, result.body);
        result = { status: translated.status, headers: asHeaders({ ...translated.headers, ...(retryAfter ? { "retry-after": retryAfter } : {}) }), body: translated.body };
      }

      const latencyMs = Date.now() - startedAt;
      if (result.status >= 200 && result.status < 300) {
        health.markSuccess(target, { latencyMs, status: result.status });
        attempts.push({ provider: target.provider, model: target.model, status: result.status });
        recordRequest({
          receivedAt, completedAt: Date.now(), protocol: "openai-chat", requestedModel,
          httpStatus: result.status, outcome: "success", attempts: []
        });
        const headers = { "content-length": result.body.length };
        for (const name of ["content-type", "content-disposition"]) {
          const value = result.headers.get(name);
          if (value) headers[name] = value;
        }
        res.writeHead(result.status, headers);
        return res.end(result.body);
      }

      attempts.push({ provider: target.provider, model: target.model, status: result.status });
      if (!isRetryableStatus(result.status, config.retryableStatus)) {
        // The request itself is wrong (400/422/413...). Another model would say the same.
        recordRequest({
          receivedAt, completedAt: Date.now(), protocol: "openai-chat", requestedModel,
          httpStatus: result.status, outcome: "failed", errorType: "invalid_request_error",
          errorMessage: `upstream rejected the request (${result.status})`, attempts: []
        });
        const headers = { "content-length": result.body.length };
        const type = result.headers.get("content-type");
        if (type) headers["content-type"] = type;
        res.writeHead(result.status, headers);
        return res.end(result.body);
      }

      let cooldownMs;
      if (result.status === 429) {
        const wait = parseRetryAfterMs(result.headers.get("retry-after"));
        cooldownMs = Math.min(RATE_LIMIT_MAX_COOLDOWN_MS, Math.max(RATE_LIMIT_MIN_COOLDOWN_MS, wait ?? RATE_LIMIT_COOLDOWN_MS));
      }
      health.markFailure(target, result.status, { reason: failureReason(result.status), ...(cooldownMs ? { cooldownMs } : {}) });
    }

    if (attempts.length === 0 && buildError) {
      return fail(res, receivedAt, requestedModel, buildError.status, buildError.errorType, buildError.message);
    }
    return fail(res, receivedAt, requestedModel, 502, "upstream_failed",
      "Every capable model failed to serve this request.", attempts);
  }

  return { handle, isMediaRoute };
}
