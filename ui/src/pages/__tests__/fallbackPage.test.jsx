import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../hooks/useApi.js", () => ({ useApi: vi.fn() }));
vi.mock("../../context/HealthContext.jsx", () => ({ useHealth: vi.fn() }));
vi.mock("../../context/ToastContext.jsx", () => ({ useToast: () => ({ success() {}, error() {} }) }));
vi.mock("../../components/domain/FallbackChain.jsx", () => ({
  FallbackChain: () => null,
  FallbackTraceAnimation: () => null
}));

import { useApi } from "../../hooks/useApi.js";
import { useHealth } from "../../context/HealthContext.jsx";
import Fallback from "../Fallback.jsx";

const idle = { data: null, error: null, loading: false, reload() {} };

describe("Fallback page: Reset remembered", () => {
  beforeEach(() => {
    useApi.mockReset();
    useHealth.mockReset();
    useApi.mockImplementation(() => idle);
  });

  it("is offered once in the page header, next to Refresh", () => {
    useHealth.mockReturnValue({ targets: [{ id: "a:m:key-0", provider: "a", model: "m", protocols: ["openai-chat"] }] });
    const markup = renderToStaticMarkup(<Fallback />);
    expect(markup.match(/Reset remembered/g)).toHaveLength(1);
    expect(markup.indexOf("Reset remembered")).toBeLessThan(markup.indexOf("Refresh"));
    expect(markup.indexOf("Reset remembered")).toBeLessThan(markup.indexOf("Planned order"));
  });

  it("is not shown when there are no configured targets", () => {
    useHealth.mockReturnValue({ targets: [] });
    expect(renderToStaticMarkup(<Fallback />)).not.toContain("Reset remembered");
  });
});
