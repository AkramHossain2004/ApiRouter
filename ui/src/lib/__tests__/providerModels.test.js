import { describe, expect, it } from "vitest";
import { MAX_PROVIDER_MODELS, diffModels, modelsProblem, describeDiff } from "../providerModels.js";

describe("provider model list helpers", () => {
  it("reports what saving would add and remove", () => {
    expect(diffModels(["a", "b"], ["b", "c", "d"])).toEqual({ added: ["c", "d"], removed: ["a"] });
    expect(diffModels(["a"], ["a"])).toEqual({ added: [], removed: [] });
  });

  it("describes the change, or nothing when there is none", () => {
    expect(describeDiff({ added: ["c", "d"], removed: ["a"] })).toBe("+2 added, −1 removed");
    expect(describeDiff({ added: [], removed: ["a"] })).toBe("−1 removed");
    expect(describeDiff({ added: [], removed: [] })).toBeNull();
  });

  it("refuses an empty or oversized list", () => {
    expect(modelsProblem([])).toMatch(/at least one model/i);
    expect(modelsProblem(Array.from({ length: MAX_PROVIDER_MODELS + 1 }, (_, i) => `m${i}`))).toMatch(/At most/);
    expect(modelsProblem(["a"])).toBeNull();
  });
});
