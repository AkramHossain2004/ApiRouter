import { describe, expect, it } from "vitest";
import {
  EMPTY_FORM, MAX_MODELS, formFromEndpoint, formProblem, createBody, updateBody,
  discoverBody, discoverProblem, toggleModel, setManyModels, filterModels
} from "../customEndpointForm.js";
import { splitList } from "../../api/customEndpoints.js";

const filled = (over = {}) => ({
  ...EMPTY_FORM, name: "Gw", baseUrl: "https://gw.example.com/v1", models: "m-a, m-b", keys: "k1\nk2", ...over
});

describe("Custom endpoint form", () => {
  it("a valid form sends a clean body", () => {
    expect(formProblem(filled(), true)).toBeNull();
    expect(createBody(filled())).toMatchObject({
      models: ["m-a", "m-b"], apiKeys: ["k1", "k2"]
    });
  });

  it("requires a name", () => {
    expect(formProblem(filled({ name: "" }), true)).toBe("Enter a name.");
  });

  it("requires a base URL", () => {
    expect(formProblem(filled({ baseUrl: "" }), true)).toBe("Enter a base URL.");
  });

  it("requires at least one model", () => {
    expect(formProblem(filled({ models: "" }), true)).toMatch(/at least one model/i);
  });

  it("requires at least one key for a new endpoint", () => {
    expect(formProblem(filled({ keys: "" }), true)).toMatch(/API key/);
  });

  it("editing keeps saved keys unless new ones are typed", () => {
    const edit = filled({ keys: "" });
    expect(formProblem(edit, false)).toBeNull();
    expect(updateBody(edit)).not.toHaveProperty("addApiKeys");
  });

  it("sends new keys when typed, and Replace swaps them", () => {
    expect(updateBody(filled({ keys: "new" }))).toMatchObject({ addApiKeys: ["new"] });
    expect(updateBody(filled({ keys: "new", replaceKeys: true })))
      .toMatchObject({ apiKeys: ["new"] });
  });

  it("formFromEndpoint fills models and leaves keys empty", () => {
    const form = formFromEndpoint({
      name: "Gw", baseUrl: "https://gw.example.com/v1", protocol: "anthropic", models: ["m"], keyCount: 2
    });
    expect(form).toMatchObject({ models: "m", keys: "" });
    expect(formFromEndpoint({ name: "Old", baseUrl: "https://a.example.com", protocol: "openai-chat", models: ["m"], keyCount: 1 }))
      .toMatchObject({ models: "m", keys: "" });
  });
});

describe("Model picker helpers", () => {
  it("builds the test request from the form, using only the first key", () => {
    expect(discoverBody(filled(), "new")).toEqual({ baseUrl: "https://gw.example.com/v1", protocol: "openai-chat", apiKey: "k1" });
    expect(discoverBody(filled({ keys: "" }), "custom-gw")).toEqual({
      baseUrl: "https://gw.example.com/v1", protocol: "openai-chat", endpointId: "custom-gw"
    });
  });

  it("needs only a base URL to fetch; the key is optional", () => {
    expect(discoverProblem(filled({ baseUrl: " " }))).toMatch(/base URL/);
    expect(discoverProblem(filled({ keys: "" }))).toBeNull();
    expect(discoverBody(filled({ keys: "" }), "new")).not.toHaveProperty("apiKey");
  });

  it("ticking and unticking edits the saved list, one id per line", () => {
    expect(toggleModel("a\nb", "c", true)).toBe("a\nb\nc");
    expect(toggleModel("a\nb", "a", false)).toBe("b");
    expect(toggleModel("a, b", "b", true)).toBe("a\nb");
  });

  it("select-all stops at the limit and clear removes only what is asked", () => {
    const ids = Array.from({ length: 150 }, (_, index) => `m${index}`);
    expect(splitList(setManyModels("", ids, true))).toHaveLength(MAX_MODELS);
    expect(setManyModels("x\nm1\nm2", ["m1"], false)).toBe("x\nm2");
  });

  it("refuses to save more than the gateway allows", () => {
    const many = Array.from({ length: MAX_MODELS + 1 }, (_, index) => `m${index}`).join("\n");
    expect(formProblem(filled({ models: many }), true)).toMatch(/At most 100/);
  });

  it("hides obvious non-text models and searches by name", () => {
    const ids = ["gpt-4o", "text-embedding-3-small", "whisper-1", "dall-e-3", "llama-3.1-70b"];
    expect(filterModels(ids)).toEqual(["gpt-4o", "llama-3.1-70b"]);
    expect(filterModels(ids, { hideNonText: false })).toHaveLength(5);
    expect(filterModels(ids, { query: "LLAMA" })).toEqual(["llama-3.1-70b"]);
  });
});
