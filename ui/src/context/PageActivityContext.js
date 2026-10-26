import { createContext, useContext } from "react";

/**
 * Whether the page a component lives in is the one on screen.
 *
 * Pages the operator has already opened stay mounted (hidden) when they move to
 * another page, so a Playground reply keeps streaming and every page comes back
 * exactly as it was left. A hidden page must not keep polling the gateway, so
 * `usePolling` reads this and pauses; it refreshes at once when the page is
 * shown again. Outside any page (the header, the providers) it is always true.
 */
const PageActiveContext = createContext(true);

export const PageActiveProvider = PageActiveContext.Provider;

export function usePageActive() {
  return useContext(PageActiveContext);
}
