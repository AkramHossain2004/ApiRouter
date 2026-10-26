import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../hooks/useApi.js", () => ({ useApi: vi.fn() }));

import { useApi } from "../../hooks/useApi.js";
import Models from "../Models.jsx";

const text = (markup) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const target = (provider, model, keyIndex, extra = {}) => ({
  id: `${provider}:${model}:key-${keyIndex}`,
  provider,
  model,
  keyIndex,
  protocols: ["openai-chat"],
  status: "healthy",
  ...extra
});

function mockModels(models) {
  useApi.mockReturnValue({
    data: { models },
    error: null,
    loading: false,
    refreshing: false,
    paused: false,
    lastUpdatedAt: Date.now(),
    reload: vi.fn()
  });
}

describe("Models page", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows one row per model with an N keys tag instead of a row per key", () => {
    mockModels([
      target("groq", "llama-3", 0),
      target("groq", "llama-3", 1),
      target("groq", "llama-3", 2),
      target("groq", "mixtral", 0)
    ]);

    const markup = renderToStaticMarkup(<Models />);
    const plain = text(markup);

    // llama-3 appears once in the table, not three times.
    expect(markup.match(/title="llama-3"/g)).toHaveLength(1);
    expect(markup.match(/title="mixtral"/g)).toHaveLength(1);
    expect(plain).toContain("3 keys");
    expect(plain).toContain("1 key");
    expect(plain).toContain("2 of 2 models");
  });

  it("says how many keys are healthy when a model's keys are not all in the same state", () => {
    mockModels([
      target("groq", "llama-3", 0, { status: "failed" }),
      target("groq", "llama-3", 1, { status: "healthy" }),
      target("groq", "llama-3", 2, { status: "failed" })
    ]);

    const plain = text(renderToStaticMarkup(<Models />));
    expect(plain).toContain("3 keys");
    expect(plain).toContain("1/3 healthy");
  });
});
