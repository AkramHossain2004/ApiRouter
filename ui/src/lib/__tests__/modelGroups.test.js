import { describe, expect, it } from "vitest";
import {
  filterModelGroups, groupTargetsByModel, normalizeModelPayload, normalizeTarget
} from "../targets.js";

const key = (provider, model, keyIndex, extra = {}) =>
  normalizeTarget({ provider, model, keyIndex, status: "healthy", protocols: ["openai-chat"], ...extra });

describe("groupTargetsByModel", () => {
  it("folds the keys of one model into a single row with a key count", () => {
    const rows = [
      key("groq", "llama", 0),
      key("groq", "llama", 1),
      key("groq", "llama", 2),
      key("groq", "other", 0),
      key("openai", "llama", 0)
    ];
    const groups = groupTargetsByModel(rows);

    expect(groups).toHaveLength(3);
    const llama = groups.find((g) => g.provider === "groq" && g.model === "llama");
    expect(llama.keyCount).toBe(3);
    expect(llama.keys.map((k) => k.keyIndex)).toEqual([0, 1, 2]);
    // The same model name under another provider is a different model.
    expect(groups.find((g) => g.provider === "openai").keyCount).toBe(1);
  });

  it("is usable when any key is: status is the best of its keys, with the split kept", () => {
    const [group] = groupTargetsByModel([
      key("p", "m", 0, { status: "failed" }),
      key("p", "m", 1, { status: "healthy" }),
      key("p", "m", 2, { status: "cooldown", cooldownUntil: Date.now() + 60_000 })
    ]);
    expect(group.status).toBe("healthy");
    expect(group.statusCounts).toEqual({ healthy: 1, cooldown: 1, failed: 1, unknown: 0 });
    expect(group.routableKeys).toBe(2);
  });

  it("reports failed only when every key failed", () => {
    const [group] = groupTargetsByModel([
      key("p", "m", 0, { status: "failed" }),
      key("p", "m", 1, { status: "failed" })
    ]);
    expect(group.status).toBe("failed");
    expect(group.routableKeys).toBe(2);
  });

  it("aggregates latency, failures and success rate across keys", () => {
    const [group] = groupTargetsByModel([
      key("p", "m", 0, { latencyMs: 100, failures: 2, requests: 10, requestFailures: 1, updatedAt: "2026-01-01T00:00:00Z" }),
      key("p", "m", 1, { latencyMs: 300, failures: 3, requests: 30, requestFailures: 9, updatedAt: "2026-02-01T00:00:00Z" }),
      key("p", "m", 2, { latencyMs: null })
    ]);
    expect(group.latencyMs).toBe(200);
    expect(group.failures).toBe(5);
    // 40 requests, 10 failed: recomputed from totals, not an average of rates.
    expect(group.successRate).toBeCloseTo(0.75);
    expect(group.updatedAt).toBe("2026-02-01T00:00:00Z");
  });

  it("leaves success rate unknown when no request was seen", () => {
    const [group] = groupTargetsByModel([key("p", "m", 0)]);
    expect(group.successRate).toBeNull();
    expect(group.latencyMs).toBeNull();
  });

  it("survives an empty or missing input", () => {
    expect(groupTargetsByModel([])).toEqual([]);
    expect(groupTargetsByModel()).toEqual([]);
    expect(groupTargetsByModel(null)).toEqual([]);
  });

  it("keeps the model switch state and the provider-off flag from the backend", () => {
    const rows = normalizeModelPayload({
      models: [
        { provider: "p", model: "m", keyIndex: 0, disabled: true, providerDisabled: true },
        { provider: "p", model: "m", keyIndex: 1, disabled: true, providerDisabled: true }
      ]
    }).rows;
    const [group] = groupTargetsByModel(rows);
    expect(group.disabled).toBe(true);
    expect(group.providerDisabled).toBe(true);
  });
});

describe("filterModelGroups", () => {
  const groups = groupTargetsByModel([
    key("groq", "llama", 0, { status: "failed" }),
    key("groq", "llama", 1, { status: "healthy" }),
    key("openai", "gpt", 0, { status: "healthy", protocols: ["openai-responses"] })
  ]);

  it("keeps a model when any of its keys has the requested health", () => {
    const failed = filterModelGroups(groups, { status: "failed" });
    expect(failed.map((g) => g.model)).toEqual(["llama"]);
    expect(failed[0].keyCount).toBe(2);
  });

  it("filters by provider, protocol and search on the model", () => {
    expect(filterModelGroups(groups, { provider: "openai" }).map((g) => g.model)).toEqual(["gpt"]);
    expect(filterModelGroups(groups, { protocol: "openai-responses" }).map((g) => g.model)).toEqual(["gpt"]);
    expect(filterModelGroups(groups, { search: "lla" }).map((g) => g.model)).toEqual(["llama"]);
    expect(filterModelGroups(groups, {})).toHaveLength(2);
  });
});
