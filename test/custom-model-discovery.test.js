import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import {
  buildModelsRequest, parseModelsResponse, createModelDiscovery, resolveDiscoveryInput
} from "../src/custom-model-discovery.js";
import { CustomEndpointStore } from "../src/custom-endpoints.js";
import { startRouter } from "../test-helpers/router-harness.js";

const KEY = "sk-test-SECRET-1234567890";

async function startUpstream(handler) {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push({ url: req.url, headers: req.headers }); handler(req, res, seen.length); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: server.address().port, seen, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

test("builds the right list-models request for each API style", () => {
  const openai = buildModelsRequest({ protocol: "openai-chat", baseUrl: "https://api.example.com", apiKey: KEY });
  assert.equal(openai.url.href, "https://api.example.com/v1/models");
  assert.equal(openai.headers.authorization, `Bearer ${KEY}`);

  const openaiV1 = buildModelsRequest({ protocol: "openai-responses", baseUrl: "https://api.example.com/v1", apiKey: KEY });
  assert.equal(openaiV1.url.href, "https://api.example.com/v1/models");

  const anthropic = buildModelsRequest({ protocol: "anthropic", baseUrl: "https://gw.example.com", apiKey: KEY });
  assert.equal(anthropic.url.pathname, "/v1/models");
  assert.equal(anthropic.headers["x-api-key"], KEY);
  assert.equal(anthropic.headers["anthropic-version"], "2023-06-01");

  const gemini = buildModelsRequest({ protocol: "gemini", baseUrl: "https://g.example.com/v1beta", apiKey: KEY });
  assert.equal(gemini.url.pathname, "/v1beta/models");
  assert.equal(gemini.headers["x-goog-api-key"], KEY);
  assert.equal(gemini.url.search.includes(KEY), false, "the key never goes in the URL");

  const keyless = buildModelsRequest({ protocol: "openai-chat", baseUrl: "http://localhost:11434/v1", apiKey: "" });
  assert.equal(keyless.headers.authorization, undefined);
});

test("parses the shapes providers answer with", () => {
  assert.deepEqual(parseModelsResponse("openai-chat", { data: [{ id: "a" }, { id: "b" }, { id: "" }, {}] }).ids, ["a", "b"]);
  assert.deepEqual(parseModelsResponse("openai-chat", { models: [{ name: "m1" }, "m2"] }).ids, ["m1", "m2"]);
  assert.deepEqual(parseModelsResponse("openai-chat", ["x", "y"]).ids, ["x", "y"]);
  assert.deepEqual(parseModelsResponse("openai-chat", { data: [{ id: "has space" }] }).ids, []);

  const anth = parseModelsResponse("anthropic", { data: [{ id: "claude-x" }], has_more: true, last_id: "claude-x" });
  assert.deepEqual(anth.ids, ["claude-x"]);
  assert.equal(anth.next, "claude-x");

  const gem = parseModelsResponse("gemini", {
    models: [
      { name: "models/gemini-pro", supportedGenerationMethods: ["generateContent"] },
      { name: "models/embed-1", supportedGenerationMethods: ["embedContent"] }
    ],
    nextPageToken: "t2"
  });
  assert.deepEqual(gem.ids, ["gemini-pro"]);
  assert.equal(gem.next, "t2");
});

test("discovers, de-duplicates and sorts models from a live endpoint", async () => {
  const upstream = await startUpstream((_req, res) => json(res, 200, { data: [{ id: "zeta" }, { id: "alpha" }, { id: "zeta" }] }));
  try {
    const discover = createModelDiscovery({ allowPrivateHosts: true });
    const result = await discover({ protocol: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: KEY });
    assert.deepEqual(result.models, ["alpha", "zeta"]);
    assert.equal(result.count, 2);
    assert.equal(upstream.seen[0].url, "/v1/models");
    assert.equal(upstream.seen[0].headers.authorization, `Bearer ${KEY}`);
  } finally { await upstream.close(); }
});

test("follows anthropic pagination", async () => {
  const upstream = await startUpstream((req, res, n) => {
    if (n === 1) return json(res, 200, { data: [{ id: "m1" }], has_more: true, last_id: "m1" });
    return json(res, 200, { data: [{ id: "m2" }], has_more: false });
  });
  try {
    const discover = createModelDiscovery({ allowPrivateHosts: true });
    const result = await discover({ protocol: "anthropic", baseUrl: `http://127.0.0.1:${upstream.port}`, apiKey: KEY });
    assert.deepEqual(result.models, ["m1", "m2"]);
    assert.match(upstream.seen[1].url, /after_id=m1/);
  } finally { await upstream.close(); }
});

test("explains a rejected key, a missing list and an empty list, never echoing the key", async () => {
  const discover = createModelDiscovery({ allowPrivateHosts: true });
  const cases = [
    [401, { error: { message: `bad key ${KEY}` } }, /rejected the API key/],
    [404, { error: "nope" }, /no model list/],
    [500, { error: { message: "boom" } }, /HTTP 500/],
    [200, { data: [] }, /returned no models/]
  ];
  for (const [status, body, pattern] of cases) {
    const upstream = await startUpstream((_req, res) => json(res, status, body));
    try {
      await assert.rejects(
        discover({ protocol: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}`, apiKey: KEY }),
        (error) => { assert.match(error.message, pattern); assert.equal(error.message.includes(KEY), false); return true; }
      );
    } finally { await upstream.close(); }
  }
});

test("a provider that lists models without a key works; one that needs a key says so", async () => {
  const open = await startUpstream((_req, res) => json(res, 200, { data: [{ id: "free-model" }] }));
  const locked = await startUpstream((_req, res) => json(res, 401, { error: { message: "missing key" } }));
  try {
    const discover = createModelDiscovery({ allowPrivateHosts: true });
    const result = await discover({ protocol: "openai-chat", baseUrl: `http://127.0.0.1:${open.port}/v1`, apiKey: "" });
    assert.deepEqual(result.models, ["free-model"]);
    assert.equal(open.seen[0].headers.authorization, undefined, "no key means no auth header");
    await assert.rejects(
      discover({ protocol: "openai-chat", baseUrl: `http://127.0.0.1:${locked.port}/v1`, apiKey: "" }),
      /needs an API key/
    );
  } finally { await open.close(); await locked.close(); }
});

test("does not follow redirects and refuses private hosts by default", async () => {
  const upstream = await startUpstream((_req, res) => { res.writeHead(302, { location: "http://169.254.169.254/" }); res.end(); });
  try {
    const discover = createModelDiscovery({ allowPrivateHosts: true });
    await assert.rejects(discover({ protocol: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}`, apiKey: "" }), /redirect/);
    const strict = createModelDiscovery({ allowPrivateHosts: false });
    await assert.rejects(strict({ protocol: "openai-chat", baseUrl: "http://localhost:" + upstream.port, apiKey: "" }), /private or reserved/);
  } finally { await upstream.close(); }
});

test("resolveDiscoveryInput uses the saved endpoint's key only for its own host", async () => {
  const store = new CustomEndpointStore({ allowPrivateHosts: true });
  await store.create({ name: "Mine", baseUrl: "https://api.example.com/v1", protocol: "openai-chat", models: ["m"], apiKeys: ["saved-key"] });
  const id = store.list()[0].id;

  const same = resolveDiscoveryInput({ endpointId: id }, { store });
  assert.deepEqual(same, { protocol: "openai-chat", baseUrl: "https://api.example.com/v1", apiKey: "saved-key" });

  const other = resolveDiscoveryInput({ endpointId: id, baseUrl: "https://evil.example.org/v1" }, { store });
  assert.equal(other.apiKey, "", "a saved key must not be sent to a different host");

  const typed = resolveDiscoveryInput({ baseUrl: "https://x.example.com", apiKey: " typed " });
  assert.equal(typed.apiKey, "typed");

  assert.throws(() => resolveDiscoveryInput({ endpointId: "custom-nope" }, { store }), (e) => e.status === 404);
  assert.throws(() => resolveDiscoveryInput({ baseUrl: "ftp://x" }), (e) => e.status === 400);
  assert.throws(() => resolveDiscoveryInput({ baseUrl: "https://x.example.com", protocol: "nope" }), (e) => e.status === 400);
  assert.throws(() => resolveDiscoveryInput(null), (e) => e.status === 400);
});

test("POST /api/custom-endpoints/discover: lists models, explains failures, never leaks the key, saves only the chosen ones", async () => {
  const upstream = await startUpstream((req, res) => {
    if (req.headers.authorization !== `Bearer ${KEY}`) return json(res, 401, { error: { message: "invalid key" } });
    return json(res, 200, { data: [{ id: "chat-big" }, { id: "chat-small" }, { id: "text-embedding-x" }] });
  });
  const router = await startRouter({ PLAYGROUND_ALLOW_PRIVATE_HOSTS: "1" });
  const post = (path, body) => router.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const baseUrl = `http://127.0.0.1:${upstream.port}/v1`;
  try {
    const ok = await post("/api/custom-endpoints/discover", { baseUrl, protocol: "openai-chat", apiKey: KEY });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).models, ["chat-big", "chat-small", "text-embedding-x"]);

    const rejected = await post("/api/custom-endpoints/discover", { baseUrl, apiKey: "wrong-key-123456" });
    assert.equal(rejected.status, 502);
    const failure = await rejected.json();
    assert.equal(failure.error.type, "upstream_auth");
    assert.match(failure.error.message, /rejected the API key/);

    assert.equal((await post("/api/custom-endpoints/discover", { baseUrl: "ftp://x", apiKey: "k" })).status, 400);
    assert.equal((await router.request("/api/custom-endpoints/discover")).status, 405);

    // The operator ticks two of the three and saves: only those two are stored.
    const saved = await post("/api/custom-endpoints", { name: "Picked", baseUrl, protocol: "openai-chat", models: ["chat-big", "chat-small"], apiKeys: [KEY] });
    assert.equal(saved.status, 201);
    const id = (await saved.json()).endpoint.id;

    // Re-fetching from the saved endpoint uses its stored key, which is never shown.
    const again = await post("/api/custom-endpoints/discover", { endpointId: id });
    assert.equal(again.status, 200);
    const listed = await (await router.request("/api/custom-endpoints")).json();
    assert.deepEqual(listed.endpoints[0].models, ["chat-big", "chat-small"]);
    assert.equal(JSON.stringify(listed).includes(KEY), false);
  } finally {
    await router.close();
    await upstream.close();
  }
});
