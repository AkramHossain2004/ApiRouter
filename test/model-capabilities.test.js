import test from "node:test";
import assert from "node:assert/strict";
import {
  ADAPTER_CAPABILITIES,
  CAPABILITY_IDS,
  DEFAULT_CAPABILITIES,
  adapterCapabilities,
  evaluateCandidate,
  filterTargetsByRequirements,
  inferCapabilities,
  noCapableRouteMessage,
  normalizeCapabilities,
  normalizeRequirements,
  requestedModelCapabilityMessage,
  unsupportedCapabilities,
  validateRequestedModel
} from "../src/model-capabilities.js";

const target = (provider, model, protocols = ["openai-chat"]) => ({ provider, model, protocols });

test("the capability schema is stable and ordered", () => {
  assert.equal(CAPABILITY_IDS.length, 20);
  assert.equal(new Set(CAPABILITY_IDS).size, 20);
  assert.deepEqual(normalizeCapabilities(["streaming", "unknown-thing", "text_input", "text_input"]).capabilities, [
    "text_input", "streaming"
  ]);
  assert.deepEqual(normalizeCapabilities(["streaming", "future_capability"]).unknown, ["future_capability"]);
});

test("reasoning can never be a hard requirement", () => {
  assert.deepEqual(normalizeRequirements(["reasoning", "text_input", "reasoning"]), ["text_input"]);
});

test("an undeclared model defaults to text in, text out and streaming: nothing else is inferred from a pool, a name or a protocol", () => {
  const expected = ["text_input", "text_output", "streaming"];

  assert.deepEqual(DEFAULT_CAPABILITIES, expected);
  // The legacy arguments are accepted and ignored: they carry no evidence.
  assert.deepEqual(inferCapabilities(), expected);
  assert.deepEqual(inferCapabilities({ protocols: ["openai-chat"] }), expected);
  assert.deepEqual(inferCapabilities({ pool: "vision", protocols: ["openai-chat"] }), expected,
    "a former vision-pool membership earns no image_input");
  for (const protocol of Object.keys(ADAPTER_CAPABILITIES)) {
    assert.deepEqual(inferCapabilities({ protocols: [protocol] }), expected, `${protocol}: defaults only`);
  }

  // The defaults are a fresh copy each time, so a caller cannot mutate them for everyone.
  inferCapabilities().push("image_input");
  assert.deepEqual(inferCapabilities(), expected);
});

test("adapter compatibility is separate from declaration, and unsupported capabilities are non-executable", () => {
  // The anthropic adapter has no structured-output wire form today.
  assert.ok(!ADAPTER_CAPABILITIES.anthropic.includes("structured_output"));
  // Image input IS executable by every real adapter, so declaring it is enough
  // to make a model an image candidate; declaring it is never done for you.
  for (const protocol of Object.keys(ADAPTER_CAPABILITIES)) {
    assert.ok(ADAPTER_CAPABILITIES[protocol].includes("image_input"), `${protocol} can carry image input`);
    assert.ok(ADAPTER_CAPABILITIES[protocol].includes("streaming"), `${protocol} can carry streaming`);
  }

  // The dedicated media routes: OpenAI-compatible and Responses-only targets share the OpenAI
  // API root, Gemini has a native translation for a subset, Anthropic has nothing.
  const MEDIA = ["embeddings", "reranking", "moderation", "audio_transcription", "audio_translation", "realtime_audio"];
  const GEMINI_MEDIA = ["embeddings", "audio_transcription", "audio_translation"];
  for (const id of MEDIA) {
    for (const protocol of ["openai-chat", "openai-responses"]) {
      assert.ok(ADAPTER_CAPABILITIES[protocol].includes(id), `${protocol} can carry ${id}`);
    }
    assert.ok(!ADAPTER_CAPABILITIES.anthropic.includes(id), `anthropic must not claim ${id}`);
    assert.equal(ADAPTER_CAPABILITIES.gemini.includes(id), GEMINI_MEDIA.includes(id), `gemini ${id}`);
  }

  // Generated image / audio output rides on the chat and Gemini wires only.
  for (const protocol of ["openai-chat", "gemini"]) {
    for (const id of ["image_output", "audio_output"]) {
      assert.ok(ADAPTER_CAPABILITIES[protocol].includes(id), `${protocol} can carry ${id}`);
    }
  }
  for (const protocol of ["openai-responses", "anthropic"]) {
    for (const id of ["image_output", "audio_output"]) {
      assert.ok(!ADAPTER_CAPABILITIES[protocol].includes(id), `${protocol} must not claim ${id}`);
    }
  }

  // computer_use is supported on anthropic only
  assert.ok(ADAPTER_CAPABILITIES.anthropic.includes("computer_use"));
  assert.ok(!ADAPTER_CAPABILITIES["openai-chat"].includes("computer_use"));
  assert.ok(!ADAPTER_CAPABILITIES["openai-responses"].includes("computer_use"));
  assert.ok(!ADAPTER_CAPABILITIES.gemini.includes("computer_use"));

  // file_search is supported on openai-responses only
  assert.ok(ADAPTER_CAPABILITIES["openai-responses"].includes("file_search"));
  assert.ok(!ADAPTER_CAPABILITIES["openai-chat"].includes("file_search"));
  assert.ok(!ADAPTER_CAPABILITIES.anthropic.includes("file_search"));
  assert.ok(!ADAPTER_CAPABILITIES.gemini.includes("file_search"));
});

test("an unknown protocol executes nothing rather than assuming OpenAI", () => {
  assert.equal(adapterCapabilities(["mystery-wire"]).size, 0);
  assert.deepEqual(unsupportedCapabilities(["text_input"], ["mystery-wire"]), ["text_input"]);
  assert.deepEqual(unsupportedCapabilities(["streaming"], ["mystery-wire"]), ["streaming"]);
});

test("eligibility requires enabled, declared and executable", () => {
  assert.deepEqual(
    evaluateCandidate({ required: ["text_input"], declared: ["text_input"], protocols: ["openai-chat"] }),
    { eligible: true, reason: null, missing: [] }
  );

  assert.equal(evaluateCandidate({
    required: ["text_input"], declared: ["text_input"], protocols: ["openai-chat"], enabled: false
  }).reason, "model_config_disabled");

  assert.equal(evaluateCandidate({
    required: ["image_input"], declared: ["text_input"], protocols: ["openai-chat"]
  }).reason, "capability_not_configured");

  // Declared, but no adapter can carry it: skipped instead of sent upstream.
  assert.deepEqual(evaluateCandidate({
    required: ["computer_use"], declared: ["computer_use"], protocols: ["openai-chat"]
  }), { eligible: false, reason: "adapter_unsupported", missing: ["computer_use"] });
  assert.deepEqual(evaluateCandidate({
    required: ["image_output"], declared: ["image_output"], protocols: ["anthropic"]
  }), { eligible: false, reason: "adapter_unsupported", missing: ["image_output"] });
  assert.equal(evaluateCandidate({
    required: ["image_output"], declared: ["image_output"], protocols: ["openai-chat"]
  }).eligible, true);

  // Default inferred streaming is eligible when adapter can execute it
  assert.deepEqual(
    evaluateCandidate({ required: ["streaming"], declared: inferCapabilities(), protocols: ["openai-chat"] }),
    { eligible: true, reason: null, missing: [] }
  );

  // Even with declared streaming, an adapter that cannot stream is never routed
  assert.deepEqual(
    evaluateCandidate({ required: ["streaming"], declared: inferCapabilities(), protocols: ["mystery-wire"] }),
    { eligible: false, reason: "adapter_unsupported", missing: ["streaming"] }
  );

  // Operator explicitly declared model without streaming: capability_not_configured
  assert.deepEqual(
    evaluateCandidate({ required: ["streaming"], declared: ["text_input", "text_output"], protocols: ["openai-chat"] }),
    { eligible: false, reason: "capability_not_configured", missing: ["streaming"] }
  );

  // computer_use is eligible on anthropic, but adapter_unsupported on openai-chat
  assert.deepEqual(
    evaluateCandidate({ required: ["computer_use"], declared: ["computer_use"], protocols: ["anthropic"] }),
    { eligible: true, reason: null, missing: [] }
  );
  assert.deepEqual(
    evaluateCandidate({ required: ["computer_use"], declared: ["computer_use"], protocols: ["openai-chat"] }),
    { eligible: false, reason: "adapter_unsupported", missing: ["computer_use"] }
  );

  // file_search is eligible on openai-responses, but adapter_unsupported on openai-chat
  assert.deepEqual(
    evaluateCandidate({ required: ["file_search"], declared: ["file_search"], protocols: ["openai-responses"] }),
    { eligible: true, reason: null, missing: [] }
  );
  assert.deepEqual(
    evaluateCandidate({ required: ["file_search"], declared: ["file_search"], protocols: ["openai-chat"] }),
    { eligible: false, reason: "adapter_unsupported", missing: ["file_search"] }
  );

  // Capabilities no adapter can carry are adapter_unsupported even if declared.
  assert.deepEqual(
    evaluateCandidate({ required: ["computer_use"], declared: ["computer_use"], protocols: ["openai-chat"] }),
    { eligible: false, reason: "adapter_unsupported", missing: ["computer_use"] }
  );
  // Executable on the OpenAI-compatible and Responses wires; Gemini only for its native subset; never Anthropic.
  for (const id of ["reranking", "audio_transcription", "embeddings", "moderation", "audio_translation", "realtime_audio"]) {
    for (const protocol of ["openai-chat", "openai-responses"]) {
      assert.equal(evaluateCandidate({ required: [id], declared: [id], protocols: [protocol] }).eligible, true, `${id} on ${protocol}`);
    }
    assert.deepEqual(
      evaluateCandidate({ required: [id], declared: [id], protocols: ["anthropic"] }),
      { eligible: false, reason: "adapter_unsupported", missing: [id] }
    );
    assert.equal(
      evaluateCandidate({ required: [id], declared: [id], protocols: ["gemini"] }).eligible,
      ["embeddings", "audio_transcription", "audio_translation"].includes(id), `${id} on gemini`
    );
  }
});

test("a request with no requirements leaves every candidate eligible", () => {
  assert.equal(evaluateCandidate({ required: [], declared: [], protocols: [] }).eligible, true);
});

test("filtering keeps eligible targets and de-duplicates exclusions per model", () => {
  const targets = [
    target("groq", "text", ["openai-chat"]),
    { ...target("groq", "text", ["openai-chat"]), keyIndex: 1 },
    target("gemini", "flash", ["gemini"]),
    target("anthropic", "claude", ["anthropic"])
  ];
  const index = new Map([
    ["groq/text", { enabled: true, capabilities: ["text_input", "text_output"] }],
    ["gemini/flash", { enabled: true, capabilities: ["text_input", "text_output", "audio_input"] }],
    ["anthropic/claude", { enabled: true, capabilities: ["text_input", "text_output"] }]
  ]);

  const result = filterTargetsByRequirements(targets, ["audio_input"], (item) => index.get(`${item.provider}/${item.model}`));
  assert.deepEqual(result.eligible.map((item) => item.provider), ["gemini"]);
  // groq appears twice in the target list (two keys) but is excluded once.
  assert.equal(result.exclusions.length, 2);
  const groq = result.exclusions.find((item) => item.provider === "groq");
  assert.equal(groq.reason, "capability_not_configured");
  assert.deepEqual(groq.missing, ["audio_input"]);
});

test("a saved model never mutates the target list", () => {
  const targets = [target("groq", "text")];
  const before = JSON.stringify(targets);
  filterTargetsByRequirements(targets, [], () => ({ enabled: false, capabilities: [] }));
  assert.equal(JSON.stringify(targets), before);
});

test("an explicitly requested known model is rejected only when none of its providers can serve", () => {
  const index = new Map([
    ["groq/text", {
      provider: "groq", model: "text", capabilities: ["text_input", "text_output"],
      protocols: ["openai-chat"], enabled: true, configuredInEnvironment: true
    }],
    ["groq/audio", {
      provider: "groq", model: "audio", capabilities: ["text_input", "text_output", "audio_input"],
      protocols: ["openai-chat"], enabled: true, configuredInEnvironment: true
    }],
    // Switched off, but capable: that is a routing decision, not a mismatch.
    ["groq/off", {
      provider: "groq", model: "off", capabilities: ["text_input", "text_output"],
      protocols: ["openai-chat"], enabled: false, configuredInEnvironment: true
    }]
  ]);

  assert.equal(validateRequestedModel(index, "text", ["audio_input"])?.model, "text");
  assert.equal(validateRequestedModel(index, "audio", ["audio_input"]), null);
  assert.equal(validateRequestedModel(index, "off", ["text_input"]), null, "disabled is reported as models_disabled, not a capability mismatch");
  assert.equal(validateRequestedModel(index, "never-heard-of", ["audio_input"]), null, "unknown ids keep working");
  assert.equal(validateRequestedModel(index, "text", []), null);

  const rejection = validateRequestedModel(index, "text", ["audio_input"]);
  assert.match(requestedModelCapabilityMessage(rejection), /Audio input/);
});

test("the no-route message names the capabilities, in the operator's vocabulary", () => {
  assert.match(noCapableRouteMessage(["image_input", "text_input"], "vision"), /Text input, Image input/);
  assert.match(noCapableRouteMessage(["image_input"], "vision"), /Model Configurator/);
});
