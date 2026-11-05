import { useEffect } from "react";
import { useRevalidator } from "react-router";

/** Re-runs the page's loader on an interval, only while the tab is visible and nothing is in flight. */
export function useAutoRefresh(ms = 5000) {
  const { revalidate, state } = useRevalidator();
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible" && state === "idle") revalidate();
    };
    const t = setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [ms, revalidate, state]);
}
