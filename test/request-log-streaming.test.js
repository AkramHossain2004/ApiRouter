import test from "node:test";
import assert from "node:assert/strict";
import { RequestLog } from "../src/observability/request-log.js";

const mkLog = () => {
  const log = new RequestLog();
  const seq = log.begin({ protocol: "openai", requestedModel: "m", receivedAt: Date.now() });
  const attemptId = log.startAttempt(seq, { provider: "p", model: "m", keyIndex: 0 }, "openai");
  return { log, seq, attemptId };
};

test("a streamed attempt is STREAMING until the stream ends, then SUCCESS with its tokens", () => {
  const { log, attemptId } = mkLog();
  const streaming = log.finishAttempt(attemptId, { ok: true, status: 200, streaming: true });
  assert.equal(streaming.state, "streaming");
  assert.equal(streaming.completedAt, null);
  // usage cannot be attached before the stream ends
  log.recordAttemptUsage(attemptId, { inputTokens: 1, outputTokens: 1 });
  assert.equal(log.attemptEvents.get(attemptId).inputTokens, null);

  const done = log.completeAttempt(attemptId, { ok: true, inputTokens: 10, outputTokens: 5, tokens: 15 });
  assert.equal(done.state, "success");
  assert.deepEqual([done.inputTokens, done.outputTokens, done.tokens], [10, 5, 15]);
  // final: nothing rewrites it
  assert.equal(log.completeAttempt(attemptId, { ok: false }).state, "success");
});

test("a cut stream settles FAILED, and a non-stream answer never passes through STREAMING", () => {
  const a = mkLog();
  a.log.finishAttempt(a.attemptId, { ok: true, status: 200, streaming: true });
  assert.equal(a.log.completeAttempt(a.attemptId, { ok: false }).state, "failed");

  const b = mkLog();
  assert.equal(b.log.finishAttempt(b.attemptId, { ok: true, status: 200 }).state, "success");
  assert.equal(b.log.completeAttempt(b.attemptId, { ok: true }).state, "success");
});

test("recording a request settles a stream that never reported its end", () => {
  const { log, seq, attemptId } = mkLog();
  log.finishAttempt(attemptId, { ok: true, status: 200, streaming: true });
  log.record({ pendingSeq: seq, attempts: [{ attemptId, ok: true, status: 200 }], outcome: "success" });
  assert.equal(log.attemptEvents.get(attemptId).state, "failed");
});

test("a streamed attempt records when streaming began and how long the stream ran", () => {
  const { log, attemptId } = mkLog();
  const streaming = log.finishAttempt(attemptId, { ok: true, status: 200, streaming: true, completedAt: 10_000 });
  assert.equal(streaming.streamStartedAt, 10_000);
  assert.equal(streaming.streamMs, undefined);   // still running: no final time yet

  const done = log.completeAttempt(attemptId, { ok: true, completedAt: 22_340 });
  assert.equal(done.streamStartedAt, 10_000);
  assert.equal(done.streamMs, 12_340);

  // a non-stream answer never gets stream timing
  const plain = mkLog();
  const settled = plain.log.finishAttempt(plain.attemptId, { ok: true, status: 200 });
  assert.equal(settled.streamStartedAt, undefined);
  assert.equal(settled.streamMs, undefined);
});
