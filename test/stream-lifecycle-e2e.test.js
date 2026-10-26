import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { getFreePort } from "../test-helpers/mock-upstream.js";

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const chunk = (text) => sse({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text } }] });
const usageChunk = sse({ id: "c", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } });

/** An upstream whose stream the test drives by hand. */
async function startStreamingUpstream(onStream) {
  const port = await getFreePort();
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") { res.writeHead(404); return res.end("{}"); }
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      onStream(res);
    });
  });
  await new Promise((resolve) => server.listen(port, "localhost", resolve));
  return { baseUrl: `http://localhost:${port}`, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

const startRouterFor = (upstream) => startRouter({
  GROQ_API_KEYS: "k0", GROQ_MODELS: "m", GROQ_BASE_URL: `${upstream.baseUrl}/v1`
});
const body = { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] };
const lastEntry = async (router) => (await (await router.request("/api/requests?limit=5&attemptLimit=50")).json());
const waitFor = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};

test("a stream that runs to its end is recorded once, at the end, with its tokens", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const upstream = await startStreamingUpstream(async (res) => {
    res.write(chunk("he"));
    await gate;
    res.write(chunk("llo"));
    res.write(usageChunk);
    res.end("data: [DONE]\n\n");
  });
  const router = await startRouterFor(upstream);
  try {
    const pending = router.request("/v1/chat/completions", postJson(body));
    const response = await pending;
    const reader = response.body.getReader();
    await reader.read(); // first bytes arrived: the stream is mid-flight

    const mid = await lastEntry(router);
    assert.equal(mid.entries.filter((e) => e.streamed).length, 0, "a running stream must not be recorded yet");
    const live = (mid.attempts ?? []).filter((a) => a.state === "streaming");
    assert.equal(live.length, 1, "the attempt shows STREAMING while bytes flow");

    release();
    while (!(await reader.read()).done) { /* drain */ }

    const done = await waitFor(async () => {
      const log = await lastEntry(router);
      return log.entries.find((e) => e.outcome === "success" && e.tokens !== null) ? log : null;
    });
    const entry = done.entries[0];
    assert.equal(entry.tokens, 15);
    const attempt = entry.attempts.at(-1);
    assert.equal(attempt.state, "success");
    assert.deepEqual([attempt.inputTokens, attempt.outputTokens, attempt.tokens], [11, 4, 15]);
  } finally { await router.close(); await upstream.close(); }
});

test("a client that closes its own side mid-stream is not recorded as an upstream failure", async () => {
  const upstream = await startStreamingUpstream((res) => {
    res.write(chunk("he"));
    const timer = setInterval(() => res.write(chunk("x")), 50);
    res.on("close", () => clearInterval(timer));
  });
  const router = await startRouterFor(upstream);
  try {
    const controller = new AbortController();
    const response = await router.request("/v1/chat/completions", { ...postJson(body), signal: controller.signal });
    await response.body.getReader().read();
    controller.abort();

    const log = await waitFor(async () => {
      const result = await lastEntry(router);
      return result.entries.length > 0 ? result : null;
    });
    const entry = log.entries[0];
    assert.equal(entry.outcome, "success");
    assert.equal(entry.finishReason, "client_closed");
    assert.equal(entry.attempts.at(-1).state, "success");
  } finally { await router.close(); await upstream.close(); }
});

test("a stream the upstream cuts is recorded as failed, not success", async () => {
  const upstream = await startStreamingUpstream((res) => {
    res.write(chunk("he"));
    setTimeout(() => res.socket.destroy(), 100);
  });
  const router = await startRouterFor(upstream);
  try {
    const response = await router.request("/v1/chat/completions", postJson(body));
    await response.text().catch(() => {});
    const log = await waitFor(async () => {
      const result = await lastEntry(router);
      return result.entries.length > 0 ? result : null;
    });
    const entry = log.entries[0];
    assert.equal(entry.outcome, "failed");
    assert.equal(entry.errorType, "stream_interrupted");
    assert.equal(entry.attempts.at(-1).state, "failed");
  } finally { await router.close(); await upstream.close(); }
});

test("a stream that starts and then goes silent is cut by the idle timeout and recorded as failed", async () => {
  const upstream = await startStreamingUpstream((res) => {
    res.write(chunk("he")); // then nothing: no more bytes, socket stays open
  });
  const router = await startRouter({
    GROQ_API_KEYS: "k0", GROQ_MODELS: "m", GROQ_BASE_URL: `${upstream.baseUrl}/v1`,
    STREAM_IDLE_TIMEOUT_MS: "400"
  });
  try {
    const started = Date.now();
    const response = await router.request("/v1/chat/completions", postJson(body));
    await response.text().catch(() => {});
    assert.ok(Date.now() - started < 4000, "the stalled stream was not cut");
    const log = await waitFor(async () => {
      const result = await lastEntry(router);
      return result.entries.length > 0 ? result : null;
    });
    const entry = log.entries[0];
    assert.equal(entry.outcome, "failed");
    assert.match(entry.errorMessage, /stalled/);
    assert.equal(entry.attempts.at(-1).state, "failed");
  } finally { await router.close(); await upstream.close(); }
});
