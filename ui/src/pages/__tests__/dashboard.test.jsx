import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../hooks/useApi.js", () => ({ useApi: vi.fn() }));
vi.mock("../../context/HealthContext.jsx", () => ({ useHealth: vi.fn() }));
vi.mock("../../context/ConnectionContext.jsx", () => ({ useConnection: () => ({ generation: 0 }) }));

import { useApi } from "../../hooks/useApi.js";
import { useHealth } from "../../context/HealthContext.jsx";
import { getProviders } from "../../api/providers.js";
import { getGateway } from "../../api/gateway.js";
import { getOneProvider } from "../../api/oneProvider.js";
import { getFallback } from "../../api/fallback.js";
import Dashboard from "../Dashboard.jsx";

const text = (markup) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

function setupApiMocks(overrides = {}) {
  const defaultProviders = {
    data: {
      summary: { knownProviders: 3, configuredProviders: 3, disabledProviders: 0 },
      providers: [{ id: "groq" }, { id: "openai" }, { id: "anthropic" }]
    },
    error: null,
    loading: false,
    reload: vi.fn()
  };

  const defaultAnalytics = {
    data: {
      summary: {
        total: 150,
        successful: 140,
        failed: 10,
        successRate: 0.933,
        failureRate: 0.067,
        avgLatencyMs: 350,
        p95LatencyMs: 820,
        requestsWithFallback: 15,
        tokens: 12000,
        tokenReportingRequests: 100
      },
      series: [{ total: 50 }, { total: 100 }],
      breakdowns: {
        provider: [{ key: "groq", count: 90, share: 0.6 }, { key: "openai", count: 60, share: 0.4 }],
        model: [{ key: "llama-3", count: 90, share: 0.6 }]
      },
      recentFailures: [
        { seq: 1, receivedAt: new Date().toISOString(), provider: "groq", model: "llama-3", category: "upstream_5xx" }
      ],
      recentFallbacks: [
        {
          seq: 2,
          receivedAt: new Date().toISOString(),
          finalProvider: "openai",
          finalModel: "gpt-4o",
          attempts: [{ ok: false, status: 503 }, { ok: true, status: 200 }],
          fallbackCount: 1,
          outcome: "success"
        }
      ]
    },
    error: null,
    loading: false,
    reload: vi.fn()
  };

  const defaultRecent = {
    data: {
      entries: [
        {
          seq: 10,
          receivedAt: new Date().toISOString(),
          finalProvider: "groq",
          finalModel: "llama-3",
          httpStatus: 200,
          outcome: "success",
          latencyMs: 180
        }
      ]
    },
    error: null,
    loading: false,
    reload: vi.fn()
  };

  const idle = { data: null, error: null, loading: false, reload: vi.fn() };
  useApi.mockImplementation((fn) => {
    if (fn === getProviders) {
      return overrides.providers ?? defaultProviders;
    }
    if (fn === getGateway) return overrides.gateway ?? idle;
    if (fn === getOneProvider) return overrides.oneProvider ?? idle;
    if (fn === getFallback) return overrides.fallback ?? idle;
    const fnStr = fn.toString();
    if (fnStr.includes("getAnalytics")) {
      return overrides.analytics ?? defaultAnalytics;
    }
    if (fnStr.includes("getRequests")) {
      return overrides.recent ?? defaultRecent;
    }
    return { data: null, error: null, loading: false, reload: vi.fn() };
  });
}

function setupHealthMock(overrides = {}) {
  useHealth.mockReturnValue({
    health: overrides.health !== undefined ? overrides.health : { ok: true },
    summary: overrides.summary !== undefined ? overrides.summary : null,
    ranked: overrides.ranked !== undefined ? overrides.ranked : [],
    error: overrides.error !== undefined ? overrides.error : null,
    loading: overrides.loading !== undefined ? overrides.loading : false,
    reload: vi.fn(),
    lastUpdatedAt: Date.now(),
    refreshing: false
  });
}

describe("Dashboard regression tests", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupApiMocks();
  });

  it("renders without throwing when the health summary is null", () => {
    setupHealthMock({
      health: null,
      summary: null,
      error: new Error("Unauthorized (401)"),
      loading: false
    });

    let markup = "";
    expect(() => {
      markup = renderToStaticMarkup(<Dashboard />);
    }).not.toThrow();

    const plain = text(markup);
    expect(plain).toContain("Dashboard");
    expect(plain).toContain("System Health");
    expect(plain).toContain("Targets");
    expect(plain).toContain("n/a");
  });

  it("displays n/a when health summary is null", () => {
    setupHealthMock({ summary: null });
    const markup = renderToStaticMarkup(<Dashboard />);
    const plain = text(markup);

    expect(plain).toContain("Targets");
    expect(markup).toContain('<span class="tiny dim mono">n/a</span>');
    expect(markup).not.toContain("% healthy</span>");
  });

  it("displays n/a when healthPercent is null", () => {
    setupHealthMock({
      summary: {
        total: 4,
        healthy: 2,
        cooldown: 1,
        failed: 1,
        unknown: 0,
        healthPercent: null
      }
    });
    const markup = renderToStaticMarkup(<Dashboard />);
    const plain = text(markup);

    expect(plain).toContain("Targets");
    expect(markup).toContain('<span class="tiny dim mono">n/a</span>');
    expect(markup).not.toContain("% healthy</span>");
  });

  it("displays n/a when healthPercent is undefined", () => {
    setupHealthMock({
      summary: {
        total: 4,
        healthy: 2,
        cooldown: 1,
        failed: 1,
        unknown: 0
      }
    });
    const markup = renderToStaticMarkup(<Dashboard />);
    const plain = text(markup);

    expect(plain).toContain("Targets");
    expect(markup).toContain('<span class="tiny dim mono">n/a</span>');
    expect(markup).not.toContain("% healthy</span>");
  });

  it("formats a valid numeric health percentage correctly", () => {
    setupHealthMock({
      summary: {
        total: 10,
        healthy: 8,
        cooldown: 1,
        failed: 1,
        unknown: 0,
        healthPercent: 0.8
      }
    });
    const markup = renderToStaticMarkup(<Dashboard />);
    const plain = text(markup);

    expect(plain).toContain("Targets");
    expect(plain).toContain("80.0% healthy");
  });

  it("formats 100% health percentage correctly", () => {
    setupHealthMock({
      summary: {
        total: 5,
        healthy: 5,
        cooldown: 0,
        failed: 0,
        unknown: 0,
        healthPercent: 1.0
      }
    });
    const markup = renderToStaticMarkup(<Dashboard />);
    const plain = text(markup);

    expect(plain).toContain("100.0% healthy");
  });

  it("formats 0% health percentage correctly without showing n/a", () => {
    setupHealthMock({
      summary: {
        total: 5,
        healthy: 0,
        cooldown: 2,
        failed: 3,
        unknown: 0,
        healthPercent: 0
      }
    });
    const markup = renderToStaticMarkup(<Dashboard />);
    const plain = text(markup);

    expect(plain).toContain("0.0% healthy");
  });

  it("missing health data does not prevent unrelated Dashboard sections from rendering", () => {
    setupHealthMock({
      health: null,
      summary: null,
      ranked: null,
      error: new Error("Network error fetching health"),
      loading: false
    });

    const markup = renderToStaticMarkup(<Dashboard />);
    const plain = text(markup);

    // Header and error alert
    expect(plain).toContain("Dashboard");
    expect(plain).toContain("Live gateway health, traffic and routing activity");
    expect(plain).toContain("Network error fetching health");

    // Metrics cards
    expect(plain).toContain("Total Providers");
    expect(plain).toContain("3");
    expect(plain).toContain("Total Targets");
    expect(plain).toContain("Total Requests");
    expect(plain).toContain("150");
    expect(plain).toContain("Average Latency");
    expect(plain).toContain("350 ms");
    expect(plain).toContain("Success Rate");
    expect(plain).toContain("93.3%");
    expect(plain).toContain("Failed Requests");
    expect(plain).toContain("10");

    // Panels
    expect(plain).toContain("Next in line");
    expect(plain).toContain("Fallback Rate");
    expect(plain).toContain("10.0%");
    expect(plain).toContain("Tokens (24h)");
    expect(plain).toContain("Top providers");
    expect(plain).toContain("Top models");
    expect(plain).toContain("Requests (24h)");
    expect(plain).toContain("Recent requests");
    expect(plain).toContain("Recent failures");
    expect(plain).toContain("Current fallback activity");

    // Recent requests data rendered
    expect(plain).toContain("llama-3");
    expect(plain).toContain("180 ms");

    // Recent failures data rendered
    expect(plain).toContain("upstream_5xx");

    // Fallback data rendered
    expect(plain).toContain("gpt-4o");
  });

  it("preserves routing functionality and links across Dashboard", () => {
    setupHealthMock({
      summary: null
    });

    const markup = renderToStaticMarkup(<Dashboard />);

    expect(markup).toContain('href="/playground"');
    expect(markup).toContain('href="/requests"');
    expect(markup).toContain('href="/analytics"');
    expect(markup).toContain('href="/fallback"');
    expect(markup).toContain('href="/configuration"');
  });

  it("renders loading skeleton only when health is loading and healthData is absent", () => {
    setupHealthMock({
      health: null,
      summary: null,
      loading: true
    });

    const markup = renderToStaticMarkup(<Dashboard />);
    expect(markup).toContain("skeleton");
    expect(markup).not.toContain("Global statistics");
  });

  it("shows the status strip: gateway, routing mode and health", () => {
    setupApiMocks({
      gateway: { data: { paused: false, state: "running" }, error: null, loading: false, reload: vi.fn() },
      oneProvider: {
        data: { active: true, provider: "groq", models: ["a", "b"] }, error: null, loading: false, reload: vi.fn()
      }
    });
    setupHealthMock({ summary: { total: 10, available: 9, healthy: 8, cooldown: 1, failed: 0, unknown: 1, healthPercent: 0.8 } });

    const markup = renderToStaticMarkup(<Dashboard />);
    const plain = text(markup);

    expect(plain).toContain("Running");
    expect(plain).toContain("One Provider");
    expect(plain).toContain("2 models");
    expect(plain).toContain("80.0% healthy");
    expect(plain).toContain("9 of 10 targets routable");
    expect(markup).toContain('href="/one-provider-fallback"');
    expect(markup).toContain('href="/health-monitor"');
    expect(markup).not.toContain("The gateway is shut down");
  });

  it("shows the manual chain without a cooling-down banner when targets are cooling down", () => {
    setupApiMocks({
      fallback: {
        data: { mode: "manual", chain: [{ provider: "groq", model: "a" }, { provider: "groq", model: "b" }, { provider: "x", model: "c" }] },
        error: null, loading: false, reload: vi.fn()
      }
    });
    setupHealthMock({ summary: { total: 10, available: 8, healthy: 8, cooldown: 1, failed: 1, unknown: 0, healthPercent: 0.8 } });

    const plain = text(renderToStaticMarkup(<Dashboard />));
    expect(plain).toContain("Manual chain");
    expect(plain).toContain("3 models in your order");
    expect(plain).not.toContain("2 of 10 targets");
    expect(plain).not.toContain("cooling down");
  });

  it("warns loudly when the gateway is shut down", () => {
    setupApiMocks({
      gateway: { data: { paused: true, state: "paused" }, error: null, loading: false, reload: vi.fn() }
    });
    setupHealthMock({ summary: null });

    const markup = renderToStaticMarkup(<Dashboard />);
    expect(text(markup)).toContain("The gateway is shut down");
    expect(text(markup)).toContain("Paused");
    expect(markup).toContain('role="alert"');
  });

  it("renders the activity lists as tappable rows, not wide tables", () => {
    setupHealthMock({ summary: null });
    const markup = renderToStaticMarkup(<Dashboard />);
    expect(markup).toContain("dash-feed");
    expect(markup).not.toContain("table-wrap");
    expect(markup).not.toContain("table--compact");
    expect(markup).toContain("viewBox");
  });

  it("is laid out to fit one screen: panes for three phone tabs, no page-long sections", () => {
    setupHealthMock({ summary: null });
    const markup = renderToStaticMarkup(<Dashboard />);
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('data-tab="overview"');
    expect(markup.match(/role="tab"/g)).toHaveLength(3);
    expect(markup).toContain('data-pane="overview"');
    expect(markup).toContain('data-pane="traffic"');
    expect(markup).toContain('data-pane="activity"');
    expect(markup).not.toContain("How routing works");
  });
});
