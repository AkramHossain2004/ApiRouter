import { useLayoutEffect, useRef, useState } from "react";
import { PageActiveProvider } from "../../context/PageActivityContext.js";

/**
 * Keeps every page the operator has opened mounted, and shows only the current
 * one. Moving to another page and back therefore does not reload or reset the
 * page: a half-written prompt, filters, scroll position and, above all, a chat
 * reply that is still streaming in are all still there. Pages are mounted the
 * first time they are visited, not all at once, so first paint costs the same.
 */

/** The routes visited so far, in the order they were first opened. */
export function rememberRoute(visited, route) {
  if (!route || visited.some((item) => item.path === route.path)) return visited;
  return [...visited, route];
}

/** One slot per visited page; the inactive ones are hidden and inert, not unmounted. */
export function PageSlots({ routes, activePath, NotFound = null }) {
  return (
    <>
      {routes.map((route) => {
        const active = route.path === activePath;
        const Page = route.element;
        return (
          <div key={route.path} className="page-slot" data-page={route.path} hidden={!active} inert={!active}>
            <PageActiveProvider value={active}>
              <Page />
            </PageActiveProvider>
          </div>
        );
      })}
      {NotFound && activePath === null ? <NotFound /> : null}
    </>
  );
}

export function KeepAlivePages({ route, path, NotFound }) {
  const [visited, setVisited] = useState(() => rememberRoute([], route));
  const routes = rememberRoute(visited, route);
  if (routes !== visited) setVisited(routes);   // adjust during render: the new page is in this very pass

  // One scroll position per page. All pages share the `main` scroller, so each
  // page's position is remembered as it is scrolled and put back when it returns.
  const positions = useRef(new Map());
  const currentPath = useRef(path);
  useLayoutEffect(() => {
    const main = document.getElementById("main-content");
    if (!main) return undefined;
    const onScroll = () => positions.current.set(currentPath.current, main.scrollTop);
    main.addEventListener("scroll", onScroll, { passive: true });
    return () => main.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    currentPath.current = path;
    const main = document.getElementById("main-content");
    if (main) main.scrollTop = positions.current.get(path) ?? 0;
  }, [path]);

  return <PageSlots routes={routes} activePath={route ? route.path : null} NotFound={NotFound} />;
}
