import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

const ok = (model) => ({
  status: 200,
  body: { id: "x", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }
});
const down = { status: 500, body: { error: "down" } };
const tried = (mock) => mock.requests.filter((r) => r.method === "POST").map((r) => r.body?.model);

// Auto model: the playground pins a provider and sends NO model.
const autoChat = (router, extra = {}) => router.request("/v1/chat/completions", postJson(
  { messages: [{ role: "user", content: "hello" }] },
  { "x-multi-ai-pin-provider": "groq", ...extra }
));

async function start(handler) {
  const groq = await startMockUpstream(handler);
  const other = await startMockUpstream(() => ok("other"));
  const router = await startRouter({
    GROQ_API_KEYS: "g0", GROQ_MODELS: "m1,m2,m3", GROQ_BASE_URL: `${groq.baseUrl}/v1`,
    MISTRAL_API_KEYS: "s0", MISTRAL_MODELS: "x1", MISTRAL_BASE_URL: `${other.baseUrl}/v1`
  });
  return { router, groq, other, close: async () => { await router.close(); await groq.close(); await other.close(); } };
}

test("auto model: a failing model falls to the provider's next model, never another provider", async () => {
  const env = await start((record) => (record.body?.model === "m3" ? ok("m3") : down));
  try {
    const response = await autoChat(env.router);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(tried(env.groq), ["m1", "m2", "m3"], "walks the provider's models in order");
    assert.deepEqual(tried(env.other), [], "the other provider is never reached");
  } finally { await env.close(); }
});

test("auto model: with every model failing the other provider is still never tried", async () => {
  const env = await start(() => down);
  try {
    const response = await autoChat(env.router);
    assert.ok(response.status >= 500, `got ${response.status}`);
    assert.deepEqual(tried(env.other), []);
  } finally { await env.close(); }
});

test("auto model: the preferred (last successful) model is tried first, then the rest in order", async () => {
  const env = await start((record) => (record.body?.model === "m2" ? down : ok(record.body?.model)));
  try {
    const response = await autoChat(env.router, { "x-multi-ai-pin-prefer-model": "m2" });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(tried(env.groq), ["m2", "m1"], "m2 first; when it fails the next model in order answers");
  } finally { await env.close(); }
});

test("auto model: without a preferred model every request starts from the first model", async () => {
  const env = await start((record) => ok(record.body?.model));
  try {
    await autoChat(env.router);
    await autoChat(env.router);
    assert.deepEqual(tried(env.groq), ["m1", "m1"]);
  } finally { await env.close(); }
});

test("auto model: an unknown preferred model is ignored", async () => {
  const env = await start((record) => ok(record.body?.model));
  try {
    const response = await autoChat(env.router, { "x-multi-ai-pin-prefer-model": "gone" });
    assert.equal(response.status, 200);
    assert.deepEqual(tried(env.groq), ["m1"]);
  } finally { await env.close(); }
});

const rotateChat = (router, after) => autoChat(router, {
  "x-multi-ai-pin-rotate": "1", ...(after ? { "x-multi-ai-pin-rotate-after": after } : {})
});

test("auto model, round-robin: every request starts after the model that answered last, wrapping around", async () => {
  const env = await start((record) => ok(record.body?.model));
  try {
    let after = "";
    for (let i = 0; i < 4; i += 1) {
      const response = await rotateChat(env.router, after);
      assert.equal(response.status, 200);
      after = response.headers.get("x-multi-ai-model");
    }
    assert.deepEqual(tried(env.groq), ["m1", "m2", "m3", "m1"]);
  } finally { await env.close(); }
});

test("auto model, round-robin: a model that just worked is not repeated, even after a fallback", async () => {
  const env = await start((record) => (record.body?.model === "m2" ? down : ok(record.body?.model)));
  try {
    const first = await rotateChat(env.router, "m1");           // m2 fails -> m3 answers
    assert.equal(first.headers.get("x-multi-ai-model"), "m3");
    const second = await rotateChat(env.router, "m3");          // wraps to m1, not m3 again
    assert.equal(second.headers.get("x-multi-ai-model"), "m1");
    assert.deepEqual(tried(env.groq), ["m2", "m3", "m1"]);
    assert.deepEqual(tried(env.other), []);
  } finally { await env.close(); }
});

test("auto model, round-robin: an unknown last model starts from the first", async () => {
  const env = await start((record) => ok(record.body?.model));
  try {
    await rotateChat(env.router, "gone");
    assert.deepEqual(tried(env.groq), ["m1"]);
  } finally { await env.close(); }
});
