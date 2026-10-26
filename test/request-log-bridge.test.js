import test from "node:test";
import assert from "node:assert/strict";
import { RequestLog } from "../src/observability/request-log.js";

test("attempt events carry the client protocol and whether a bridge translated", () => {
  const log = new RequestLog();
  const seq = log.begin({ protocol: "openai-chat", requestedModel: "m" });

  const bridgedId = log.startAttempt(seq, { provider: "a", model: "x", protocol: "anthropic", translated: true });
  const nativeId = log.startAttempt(seq, { provider: "b", model: "y", protocol: "openai-chat", translated: false });

  const bridged = log.attemptEvents.get(bridgedId);
  assert.equal(bridged.clientProtocol, "openai-chat");
  assert.equal(bridged.protocol, "anthropic");
  assert.equal(bridged.bridged, true);
  assert.equal(bridged.bridge, "openai-chat -> anthropic");

  const native = log.attemptEvents.get(nativeId);
  assert.equal(native.bridged, false);
  assert.equal(native.bridge, null);
});

test("bridged is derived from the protocols when the caller does not say", () => {
  const log = new RequestLog();
  const seq = log.begin({ protocol: "gemini" });
  const id = log.startAttempt(seq, { provider: "a", model: "x", protocol: "openai-responses" });
  assert.equal(log.attemptEvents.get(id).bridged, true);
});

test("a recorded request reports the bridge state of its answering attempt", () => {
  const log = new RequestLog();
  const seq = log.begin({ protocol: "openai-responses" });
  const id = log.startAttempt(seq, { provider: "a", model: "x", protocol: "anthropic", translated: true });
  const entry = log.record({
    pendingSeq: seq, protocol: "openai-responses", outcome: "success",
    attempts: [{ attemptId: id, provider: "a", model: "x", protocol: "anthropic", translated: true, ok: true, status: 200 }]
  });
  assert.equal(entry.bridged, true);
  assert.equal(entry.upstreamProtocol, "anthropic");
  assert.equal(entry.attempts[0].bridge, "openai-responses -> anthropic");
});
