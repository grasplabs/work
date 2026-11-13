import { failureText } from "@grasp-os/shared/errors";
import { useEffect, useRef, useState } from "react";

// One action at a time for what a key names, its reply kept only while
// that key is still what the page shows. The smallest helper the own
// export needs; #2220's `useAsk` (brain/memories-asks.ts) does the same
// for the Memories page, and the two are to be one once both are on main.

/**
 * Runs an action for `key`: `busy` while it runs, and a second run asked
 * while one is under way (two clicks in one tick among them) sends
 * nothing. Its outcome counts only while `key` is still shown: a reply
 * that lands after the page left it, or moved on to another key, is
 * dropped, and `then` isn't called. `failure` says why the last one
 * didn't go through.
 */
export const useKeyedAction = (key: string) => {
  /** The key the page shows now; null once it left. */
  const shown = useRef<string | null>(null);
  /** The key whose action is under way, if any: set before any await. */
  const running = useRef<string | null>(null);
  const [outcome, setOutcome] = useState<{
    key: string;
    busy: boolean;
    failure?: string;
  }>();
  useEffect(() => {
    shown.current = key;
    return () => {
      shown.current = null;
    };
  }, [key]);
  const run = async (
    action: () => Promise<unknown>,
    then: () => void
  ): Promise<void> => {
    if (running.current === key) {
      return;
    }
    running.current = key;
    setOutcome({ key, busy: true });
    let failure: string | undefined;
    try {
      await action();
    } catch (error) {
      failure = failureText(error);
    }
    running.current = null;
    if (shown.current !== key) {
      return;
    }
    setOutcome(
      failure === undefined ? undefined : { key, busy: false, failure }
    );
    then();
  };
  const now = outcome?.key === key ? outcome : undefined;
  return { busy: now?.busy === true, failure: now?.failure, run };
};
