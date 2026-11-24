import { useEffect, useRef } from "react";

/**
 * Tells work a component started (a request it waits on before leaving
 * the page, say) that the component has gone since: `gone()`, taken when
 * the work starts, is a signal aborted once the component unmounts, so the
 * work acts on nothing after the person has moved on. Each mount has its
 * own, as StrictMode mounts twice.
 */
export const useGone = (): (() => AbortSignal) => {
  const mounted = useRef<AbortController>(null);
  useEffect(() => {
    const here = new AbortController();
    mounted.current = here;
    return () => {
      here.abort();
    };
  }, []);
  return () => mounted.current?.signal ?? AbortSignal.abort();
};
