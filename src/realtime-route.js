/**
 * GET /v1/realtime (WebSocket upgrade) -> a capable OpenAI-compatible target.
 *
 * The gateway is a transparent tunnel: it does not parse WebSocket frames. It only
 *   1. authenticates the client (Authorization / x-api-key header),
 *   2. picks a model that DECLARES `realtime_audio`, in health order,
 *   3. performs the upgrade against the upstream with the TARGET's model id and key,
 *   4. forwards the upstream's 101 to the client and pipes bytes both ways.
 * Because the client's Sec-WebSocket-Key is forwarded unchanged, the upstream's
 * Sec-WebSocket-Accept is valid for the client as-is.
 *
 * Fallback exists only while the handshake is in flight. Once the 101 has been
 * delivered the session belongs to that model and is never moved.
 * Gemini Live speaks a different protocol and Anthropic has none, so neither is a candidate.
 * Browsers cannot set headers on a WebSocket; such clients need a header-capable proxy.
 */
import net from "node:net";
import tls from "node:tls";
import {
  filterTargetsByRequirements,
  noCapableRouteMessage,
  validateRequestedModel,
  requestedModelCapabilityMessage
} from "./model-capabilities.js";
import { isRetryableStatus } from "./router.js";
import { openAiSuffixPath } from "./url-utils.js";

export const REALTIME_PATH = "/v1/realtime";
const HEAD_LIMIT = 16 * 1024;
const FORWARDED = ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "openai-beta", "user-agent", "origin"];

/** Plain HTTP answer on a raw socket, then close. */
function refuse(socket, status, type, message, extra = {}) {
  const payload = JSON.stringify({ error: { message, type } });
  const reason = { 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 502: "Bad Gateway", 503: "Service Unavailable" }[status] ?? "Error";
  try {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n` +
      Object.entries(extra).map(([k, v]) => `${k}: ${v}\r\n`).join("") + `\r\n${payload}`
    );
  } catch { /* the client is already gone */ }
  socket.destroy();
}

/** Opens the upstream upgrade; resolves `{ status, head, rest, socket }` once the response head is in. */
function handshake(target, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(String(target.baseUrl).replace(/\/+$/, "") + "/" + openAiSuffixPath(String(target.baseUrl).replace(/\/+$/, ""), "realtime")); }
    catch { reject(new Error("invalid base URL")); return; }
    const secure = url.protocol === "https:" || url.protocol === "wss:";
    const port = Number(url.port) || (secure ? 443 : 80);

    const params = new URLSearchParams(request.search);
    params.set("model", target.model);

    const lines = [
      `GET ${url.pathname}?${params} HTTP/1.1`,
      `Host: ${url.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Authorization: Bearer ${target.apiKey}`
    ];
    for (const name of FORWARDED) if (request.headers[name]) lines.push(`${name}: ${request.headers[name]}`);

    const socket = (secure ? tls.connect({ host: url.hostname, port, servername: url.hostname }) : net.connect({ host: url.hostname, port }));
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.removeAllListeners("data"); fn(value); };
    const timer = setTimeout(() => { socket.destroy(); finish(reject, Object.assign(new Error("handshake timed out"), { timedOut: true })); }, timeoutMs);

    socket.once(secure ? "secureConnect" : "connect", () => socket.write(lines.join("\r\n") + "\r\n\r\n"));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buffer.length > HEAD_LIMIT) { socket.destroy(); finish(reject, new Error("upstream response head too large")); }
        return;
      }
      const head = buffer.subarray(0, end + 4);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head.toString("latin1"))?.[1]);
      socket.pause();
      finish(resolve, { status, head, rest: buffer.subarray(end + 4), socket });
    });
    socket.once("error", (error) => { finish(reject, error); });
    socket.once("close", () => { finish(reject, new Error("upstream closed during handshake")); });
  });
}

export function createRealtimeRoute(deps) {
  const { getTargets, modelConfig, health, config, authorized, isPaused, recordRequest } = deps;

  async function handle(req, clientSocket, head) {
    const receivedAt = Date.now();
    clientSocket.on("error", () => {});
    const url = new URL(req.url, "http://localhost");
    const requestedModel = (url.searchParams.get("model") || "").trim();
    const log = (status, outcome, errorType, errorMessage) => {
      try {
        recordRequest({ receivedAt, completedAt: Date.now(), protocol: "openai-chat", requestedModel, httpStatus: status, outcome, errorType, errorMessage, attempts: [] });
      } catch { /* logging never breaks a request */ }
    };
    const deny = (status, type, message, extra) => { log(status, "failed", type, message); refuse(clientSocket, status, type, message, extra); };

    // Not logged: unauthenticated traffic must not evict real entries from the bounded log.
    if (!authorized(req)) return refuse(clientSocket, 401, "authentication_error", "Unauthorized");
    if (isPaused()) return deny(503, "gateway_paused", "Gateway is shut down from the Control Panel. Resume it to accept requests.", { "retry-after": "30" });
    if (!/\bwebsocket\b/i.test(String(req.headers.upgrade || "")) || !req.headers["sec-websocket-key"]) {
      return deny(400, "invalid_request_error", "This endpoint requires a WebSocket upgrade");
    }

    const required = ["realtime_audio"];
    const targets = getTargets();
    const index = modelConfig.index(targets);
    const wired = targets
      .filter((t) => !modelConfig.explicitlyDisabled(t.provider, t.model))
      .filter((t) => (t.protocols ?? []).some((p) => p === "openai-chat" || p === "openai-responses"))
      .map((t) => ({ ...t, protocols: ["openai-chat"] }));
    const { eligible } = filterTargetsByRequirements(wired, required, (t) => index.get(`${t.provider}/${t.model}`));

    const rejection = validateRequestedModel(index, requestedModel, required);
    if (rejection) return deny(400, "model_capability_mismatch", requestedModelCapabilityMessage(rejection));
    if (eligible.length === 0) return deny(503, "no_capable_route", noCapableRouteMessage(required));

    const named = eligible.filter((t) => t.model === requestedModel);
    const usable = (named.length > 0 ? named : eligible).filter((t) => health.isAvailable(t));
    if (usable.length === 0) return deny(503, "no_available_route", "Every capable model is cooling down after recent failures. Try again shortly.", { "retry-after": "30" });

    const request = { search: url.search, headers: req.headers };
    let lastStatus = null;
    for (const target of health.rank(usable)) {
      if (clientSocket.destroyed) return undefined;
      const startedAt = Date.now();
      let upstream;
      try {
        upstream = await handshake(target, request, config.timeoutMs);
      } catch (error) {
        health.markFailure(target, error.timedOut ? 504 : 502, { reason: error.timedOut ? "realtime: handshake timed out" : "realtime: upstream unreachable" });
        lastStatus = error.timedOut ? 504 : 502;
        continue;
      }

      if (upstream.status === 101) {
        health.markSuccess(target, { latencyMs: Date.now() - startedAt, status: 101 });
        log(101, "success");
        const { socket } = upstream;
        const close = () => { socket.destroy(); clientSocket.destroy(); };
        socket.on("error", close);
        clientSocket.on("error", close);
        clientSocket.once("close", close);
        socket.once("close", close);
        clientSocket.write(upstream.head);
        if (upstream.rest.length > 0) clientSocket.write(upstream.rest);
        if (head?.length > 0) socket.write(head);
        socket.pipe(clientSocket);
        clientSocket.pipe(socket);
        socket.resume();
        return undefined;
      }

      upstream.socket.destroy();
      lastStatus = upstream.status;
      if (!isRetryableStatus(upstream.status, config.retryableStatus)) {
        // The request itself is wrong; another model would refuse it too.
        return deny(upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502, "invalid_request_error", `upstream rejected the upgrade (${upstream.status})`);
      }
      health.markFailure(target, upstream.status, { reason: `realtime: upstream answered ${upstream.status}` });
    }
    return deny(502, "upstream_failed", `Every capable model failed the realtime handshake${lastStatus ? ` (last status ${lastStatus})` : ""}.`);
  }

  return { handle };
}
