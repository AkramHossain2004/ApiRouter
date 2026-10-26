import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../../styles/components.css", import.meta.url), "utf8");

/**
 * Regression: on phones the card header's text piled on top of itself. Its grid-template-areas named 3 cells in the
 * first row and 4 in the others, which makes the browser drop the whole declaration. Every row must have the same
 * number of cells, and as many as there are columns.
 */
describe("Live Logs card header on narrow screens", () => {
  const media = css.slice(css.indexOf("@media (max-width: 760px)"));
  const block = media.slice(media.indexOf(".livelog__card-head {"), media.indexOf("}", media.indexOf(".livelog__card-head {")));

  it("names the same number of grid cells in every row, matching the columns", () => {
    const rows = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1].trim().split(/\s+/).length);
    const columns = block.match(/grid-template-columns:\s*([^;]+);/)[1].replace(/minmax\([^)]*\)/g, "x").trim().split(/\s+/).length;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(new Set(rows).size).toBe(1);
    expect(rows[0]).toBe(columns);
  });
});
