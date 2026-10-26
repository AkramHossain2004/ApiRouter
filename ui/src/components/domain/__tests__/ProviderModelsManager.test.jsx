import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ToastProvider } from "../../../context/ToastContext.jsx";
import { ProviderModelsManager } from "../ProviderModelsManager.jsx";
import { ProviderDrawer } from "../ProviderDrawer.jsx";

const record = {
  id: "groq", configured: true, protocols: ["openai-chat"], models: ["m1", "m2"], modelCount: 2,
  keyCount: 1, targetCount: 2, envPrefix: "GROQ", baseUrl: "https://api.groq.com/openai/v1", missing: [],
  clientHeaderNames: [], custom: false, label: null, targets: [],
  health: { status: "healthy", successRate: 1, successes: 1, failures: 0, latencyMs: 100, lastUpdatedAt: Date.now() },
  modelsEditable: true, modelsSource: "env", envModels: ["m1", "m2"]
};

const manager = (overrides = {}) => renderToStaticMarkup(
  <ToastProvider><ProviderModelsManager record={{ ...record, ...overrides }} /></ToastProvider>
);

describe("ProviderModelsManager", () => {
  it("offers Fetch & edit and says the list comes from .env", () => {
    const markup = manager();
    expect(markup).toContain("Fetch &amp; edit models");
    expect(markup).toContain("GROQ_MODELS");
    expect(markup).not.toContain("Reset to .env list");
  });

  it("offers a reset once a list was chosen on the page", () => {
    const markup = manager({ modelsSource: "panel", models: ["m1"], envModels: ["m1", "m2"] });
    expect(markup).toContain("Reset to .env list");
    expect(markup).toContain("chosen here");
  });

  it("is only shown by the drawer for providers whose list can be edited", () => {
    const drawer = (value) => renderToStaticMarkup(
      <ToastProvider><ProviderDrawer open id="groq" onClose={() => {}} record={{ ...record, modelsEditable: value }} /></ToastProvider>
    );
    expect(drawer(true)).toContain("Fetch &amp; edit models");
    expect(drawer(false)).not.toContain("Fetch &amp; edit models");
  });
});
