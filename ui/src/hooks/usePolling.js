import { useEffect, useRef, useState } from "react";
import { usePageActive } from "../context/PageActivityContext.js";

/**
 * Interval engine used by `useApi`.
 *
 * Polling, not WebSockets: the gateway has no push channel, and inventing one
 * client-side would be a fiction. Three behaviours make polling cheap enough
 * to run on every page:
 *
 *   visibility  a hidden tab stops polling entirely — background tabs are the
 *               main source of pointless gateway load. So does a page the
 *               operator has moved away from: it stays mounted (see
 *               KeepAlivePages) but is not on screen, and refreshes when shown
 *   focus       returning to the tab refreshes immediately rather than waiting
 *               out the interval
 *   backoff     consecutive failures stretch the interval, so a gateway that
 *               is down is not hammered by every open tab
 */
export function usePolling(task, { intervalMs = null, enabled = true } = {}) {
  const taskRef = useRef(task);
  taskRef.current = task;

  const pageActive = usePageActive();
  const [tabVisible, setVisible] = useState(() =>
    typeof document === "undefined" ? true : !document.hidden
  );
  const visible = tabVisible && pageActive;

  useEffect(() => {
    if (typeof document === "undefined") return undefined;

    const onVisibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Refresh on the hidden -> visible edge, so the first thing an operator sees
  // when they switch back is current data.
  useEffect(() => {
    if (!visible || !enabled) return;
    void taskRef.current?.({ reason: "focus" });
  }, [visible, enabled]);

  useEffect(() => {
    if (!intervalMs || !enabled || !visible) return undefined;

    const timer = setInterval(() => {
      void taskRef.current?.({ reason: "interval" });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [intervalMs, enabled, visible]);

  return { paused: !visible || !enabled };
}
