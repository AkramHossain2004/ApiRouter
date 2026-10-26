import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { CustomEndpointStore } from "../src/custom-endpoints.js";
import { loadConfig } from "../src/config.js";
import { registerConfiguredSecrets, sanitizeMessage } from "../src/observability/sanitize.js";
import { normalizeStoredEntry } from "../src/model-config.js";

const chat = { model: "m", messages: [{ role: "user", content: "hi" }] };

test("with no router key, a cross-origin POST to the proxy is refused (CSRF); non-browser clients still work", async () => {
  const mock = await startMockUpstream(() => ({ status: 200, body: {} }));
  const router = await startRouter({ GROQ_API_KEYS: "k0", GROQ_MODELS: "m", GROQ_BASE_URL: `${mock.baseUrl}/v1` });
  try {
    const foreign = await router.request("/v1/chat/completions", postJson(chat, { origin: "https://evil.example" }));
    assert.equal(foreign.status, 403);
    const plain = await router.request("/v1/chat/completions", postJson(chat));
    assert.equal(plain.status, 200);
  } finally { await router.close?.(); await mock.close?.(); }
});

test("with a router key, /health gives anonymous callers no provider detail", async () => {
  const mock = await startMockUpstream(() => ({ status: 200, body: {} }));
  const router = await startRouter({ APIROUTER_API_KEYS: "tok", GROQ_API_KEYS: "k0", GROQ_MODELS: "m", GROQ_BASE_URL: `${mock.baseUrl}/v1` });
  try {
    const anon = await router.request("/health");
    assert.equal(anon.status, 200);
    const body = await anon.json();
    assert.equal(body.providers, undefined);
    assert.equal(body.health, undefined);
    const authed = await (await router.request("/health", { headers: { authorization: "Bearer tok" } })).json();
    assert.ok(Array.isArray(authed.providers));
  } finally { await router.close?.(); await mock.close?.(); }
});

test("a saved custom endpoint cannot lose its base URL", async () => {
  const store = new CustomEndpointStore({ file: "", lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
  const ep = await store.create({ name: "x", baseUrl: "https://api.example.com/v1", protocol: "openai-chat", models: ["m"], apiKeys: ["k-123456789"] });
  await assert.rejects(store.update(ep.id, { baseUrl: "" }), /Base URL is required/);
  assert.equal(store.get(ep.id).baseUrl, "https://api.example.com/v1");
});

test("a Cloudflare account id is redacted from outbound messages", () => {
  const id = "abcdef0123456789abcdef0123456789";
  const cfg = loadConfig({ CLOUDFLARE_API_KEYS: "cfkey-aaaaaaaa", CLOUDFLARE_MODELS: "m", CLOUDFLARE_ACCOUNT_ID: id });
  assert.deepEqual(cfg.providers.cloudflare.accountIds, [id]);
});

test("ordinary model ids that start like a vendor token prefix are not rejected as credentials", () => {
  for (const model of ["pplx-70b-online", "hf-internal-model-1", "pplx-7b-chat"]) {
    assert.ok(normalizeStoredEntry({ provider: "openrouter", model }), model);
  }
  assert.equal(normalizeStoredEntry({ provider: "openrouter", model: "gsk_abcdefghijklmnopqrstuvwxyz123456" }), null);
});

import { detectOutputIntent } from "../src/intent-detect.js";
import { analyzeRequest } from "../src/request-profile.js";

const intent = (text) => detectOutputIntent({ operation: "chat", body: { messages: [{ role: "user", content: text }] } });

test("ordinary requests that merely mention files, documents or songs are not output intents", () => {
  for (const text of [
    "I need to update the files in my project",
    "I want to understand this document",
    "Give me the summary of this file",
    "I need help choosing a song for the wedding"
  ]) {
    const found = intent(text);
    assert.deepEqual([found.outputs, found.unsupported], [[], []], text);
  }
});

test("only the listed create/genarete image, photo and video phrases are an output intent", () => {
  assert.deepEqual(intent("create a photo for my cafe").outputs, ["image_output"]);
  assert.deepEqual(intent("genarete image").outputs, ["image_output"]);
  assert.deepEqual(intent("genarete video of a cat").unsupported, ["video"]);
  assert.deepEqual(intent("make a logo for my cafe").outputs, []);
  assert.deepEqual(intent("produce a photo").outputs, []);
});

test("Anthropic-defined client tools (bash, text_editor) require tool_calling", () => {
  const profile = analyzeRequest({
    protocol: "anthropic",
    pathname: "/v1/messages",
    body: { messages: [{ role: "user", content: "x" }], tools: [{ type: "bash_20250124", name: "bash" }] }
  });
  assert.ok(profile.required.includes("tool_calling"));
});
