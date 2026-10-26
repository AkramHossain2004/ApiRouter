import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

import { PageSlots, rememberRoute } from "../KeepAlivePages.jsx";
import { PageActiveProvider, usePageActive } from "../../../context/PageActivityContext.js";

const A = () => <p>page A</p>;
const B = () => <p>page B</p>;
const NotFound = () => <p>nothing here</p>;
const routeA = { path: "/a", element: A };
const routeB = { path: "/b", element: B };

describe("keeping visited pages alive", () => {
  it("remembers each page once, in the order it was first opened", () => {
    const first = rememberRoute([], routeA);
    expect(first).toEqual([routeA]);
    expect(rememberRoute(first, routeA)).toBe(first);   // same list back: nothing to re-render
    expect(rememberRoute(first, routeB)).toEqual([routeA, routeB]);
    expect(rememberRoute(first, undefined)).toBe(first);   // an unknown address adds nothing
  });

  it("renders every visited page but shows only the current one", () => {
    const html = renderToStaticMarkup(<PageSlots routes={[routeA, routeB]} activePath="/b" />);
    expect(html).toContain("page A");   // still mounted, so its state and any running request survive
    expect(html).toContain("page B");
    const slotA = html.match(/<div[^>]*data-page="\/a"[^>]*>/)[0];
    const slotB = html.match(/<div[^>]*data-page="\/b"[^>]*>/)[0];
    expect(slotA).toContain("hidden");
    expect(slotA).toContain("inert");
    expect(slotB).not.toContain("hidden");
    expect(slotB).not.toContain("inert");
  });

  it("tells each page whether it is the one on screen", () => {
    function Probe() { return <b>{usePageActive() ? "active" : "away"}</b>; }
    const html = renderToStaticMarkup(<PageSlots routes={[{ path: "/a", element: Probe }, { path: "/b", element: Probe }]} activePath="/a" />);
    expect(html.match(/<b>(\w+)<\/b>/g)).toEqual(["<b>active</b>", "<b>away</b>"]);
    // Outside any page (header, providers) it is always on.
    expect(renderToStaticMarkup(<Probe />)).toBe("<b>active</b>");
    expect(renderToStaticMarkup(<PageActiveProvider value={false}><Probe /></PageActiveProvider>)).toBe("<b>away</b>");
  });

  it("shows the not-found page only for an address that is no route", () => {
    expect(renderToStaticMarkup(<PageSlots routes={[routeA]} activePath={null} NotFound={NotFound} />)).toContain("nothing here");
    expect(renderToStaticMarkup(<PageSlots routes={[routeA]} activePath="/a" NotFound={NotFound} />)).not.toContain("nothing here");
  });

  it("adds no box of its own, and hides a page with display: none", () => {
    const css = readFileSync(new URL("../../../styles/layout.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.page-slot\s*\{\s*display:\s*contents;/);
    expect(css).toMatch(/\.page-slot\[hidden\]\s*\{\s*display:\s*none;/);
  });
});
