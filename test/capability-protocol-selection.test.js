import test from "node:test";
import assert from "node:assert/strict";
import { filterTargetsByRequirements, evaluateCandidate, protocolsExecuting } from "../src/model-capabilities.js";
import { analyzeRequest } from "../src/request-profile.js";
import { bridgeProtocol } from "../src/anthropic-bridge.js";
import { codexProtocol } from "../src/codex-bridge.js";

const declared = (caps) => () => ({ enabled: true, capabilities: ["text_input", "text_output", "streaming", ...caps] });

test("a multi-protocol target is narrowed to the protocol that can carry the request", () => {
  const profile = analyzeRequest({
    protocol: "anthropic", pathname: "/v1/messages", stream: true,
    body: { messages: [{ role: "user", content: "hi" }], response_format: { type: "json_schema" } }
  });
  const target = { provider: "x", model: "m", protocols: ["anthropic", "openai-chat"] };
  const { eligible } = filterTargetsByRequirements([target], profile.required, declared(["structured_output"]));
  assert.equal(eligible.length, 1);
  // anthropic is first in preference order but cannot execute structured_output
  assert.equal(bridgeProtocol(eligible[0]), "openai-chat");
});

test("audio input from a Codex client never lands on the Responses protocol", () => {
  const profile = analyzeRequest({
    protocol: "openai-responses", pathname: "/v1/responses", stream: true,
    body: { input: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "x", format: "wav" } }] }] }
  });
  const target = { provider: "y", model: "n", protocols: ["openai-responses", "openai-chat"] };
  const { eligible } = filterTargetsByRequirements([target], profile.required, declared(["audio_input"]));
  assert.equal(codexProtocol(eligible[0]), "openai-chat");
});

test("needs split across protocols are not a route when no single protocol carries them all", () => {
  // structured_output: chat/gemini only. computer_use: anthropic only.
  const verdict = evaluateCandidate({
    required: ["text_input", "text_output", "structured_output", "computer_use"],
    declared: ["text_input", "text_output", "structured_output", "computer_use"],
    protocols: ["anthropic", "openai-chat"]
  });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, "adapter_unsupported");
  assert.deepEqual(protocolsExecuting(["structured_output", "computer_use"], ["anthropic", "openai-chat"]), []);
});

test("a target whose protocols all carry the request is left untouched", () => {
  const target = { provider: "z", model: "k", protocols: ["openai-chat", "gemini"] };
  const { eligible } = filterTargetsByRequirements([target], ["text_input", "text_output"], declared([]));
  assert.equal(eligible[0], target);
});
