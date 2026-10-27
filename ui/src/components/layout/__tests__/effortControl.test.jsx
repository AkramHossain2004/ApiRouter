import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

let system;
vi.mock("../../../context/SystemStatusContext.jsx", () => ({ useSystemStatus: () => ({ system, reload: async () => {} }) }));
vi.mock("../../../api/effort.js", () => ({ setEffort: async () => ({ ok: true }) }));

const { EffortControl } = await import("../EffortControl.jsx");

const levels = [
  { id: "low", label: "Low", summary: "Fast work", description: "l" },
  { id: "medium", label: "Medium", summary: "Balanced", description: "m" },
  { id: "high", label: "High", summary: "Deep analysis", description: "h" },
  { id: "xhigh", label: "Extra High / Max", summary: "Maximum effort", description: "x" }
];

describe("EffortControl", () => {
  it("renders nothing when the backend has no effort info", () => {
    system = { effort: null };
    expect(renderToStaticMarkup(<EffortControl />)).toBe("");
  });

  it("lists the four levels with the saved one selected", () => {
    system = { effort: { effort: "medium", default: "medium", levels } };
    const html = renderToStaticMarkup(<EffortControl />);
    expect([...html.matchAll(/<option value="(\w+)"/g)].map((m) => m[1])).toEqual(["low", "medium", "high", "xhigh"]);
    expect(html).toMatch(/<option value="medium"[^>]*selected/);
    expect(html).toContain("Extra High / Max");
    expect(html).toContain('aria-label="Model effort"');
  });

  it("selects the level the backend reports", () => {
    system = { effort: { effort: "xhigh", default: "medium", levels } };
    expect(renderToStaticMarkup(<EffortControl />)).toMatch(/<option value="xhigh"[^>]*selected/);
  });
});
