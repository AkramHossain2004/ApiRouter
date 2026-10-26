import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

let captured = null;

vi.mock("../../context/HealthContext.jsx", () => ({
  useHealth: () => ({
    health: { targets: [{ provider: "groq", model: "m1", keyIndex: 0, status: "healthy" }] },
    error: null,
    loading: false,
    reload: vi.fn(),
    runManualRefresh: vi.fn(),
    manualBusy: false,
    lastUpdatedAt: Date.now(),
    refreshing: false,
    autoRefresh: true,
    setAutoRefresh: vi.fn()
  })
}));

// Only the props the page hands the table matter here, so the table is replaced
// by a stub that records them.
vi.mock("../../components/ui/DataTable.jsx", () => ({
  DataTable: (props) => {
    captured = props;
    return null;
  }
}));

import HealthMonitor from "../HealthMonitor.jsx";

describe("Health Monitor", () => {
  it("handles a row click without throwing (it used to call an undefined onSelect)", () => {
    renderToStaticMarkup(<HealthMonitor />);
    expect(captured, "the targets table was not rendered").not.toBeNull();
    expect(() => captured.onRowClick({ id: "groq/m1/0" })).not.toThrow();
  });
});
