import { useEffect, useEffectEvent, useRef, useState } from "react";

// A change someone confirmed that waits a few seconds with Undo before it
// counts: pausing a workflow beside its name, answering what waits on
// them in Runs › Today. One rule for each: Undo takes it back; otherwise
// it goes when the seconds are over, or at once when the page goes first,
// as the yes was given. Leaving is not a quiet undo.
//
// How the page goes decides how sure that is. Another page of Grasp, or
// the card closed: sent over the tab's connection, which stays open. A
// reload or a closed tab: `beforeunload` sends it then and has the browser
// ask before leaving, which keeps the page, and its connection, while the
// change goes. A page hidden without that question (a phone's tab
// switcher, a page kept for Back): `pagehide` sends it as far as the
// connection still carries it. Core's RPC is a WebSocket alone, with no
// request a `sendBeacon` or `keepalive` fetch could make in its place.

/** One second, in milliseconds. */
const secondMs = 1000;

interface Held<T> {
  value: T;
  left: number;
}

/**
 * Holds a confirmed `value` for `seconds` before `go` sends it; `goOnLeave`
 * sends it when the page goes first, with nothing left to show the
 * outcome on. `left` counts the seconds while one is held.
 */
export const useGrace = <T>({
  seconds,
  go,
  goOnLeave,
}: {
  seconds: number;
  go: (value: T) => void;
  goOnLeave: (value: T) => void;
}) => {
  const [held, setHeld] = useState<Held<T> | null>(null);
  // What is held, for leaving: the state is gone by then.
  const leaving = useRef<{ value: T } | null>(null);
  const sendOnLeave = useRef(goOnLeave);
  const goNow = useEffectEvent(go);

  useEffect(() => {
    sendOnLeave.current = goOnLeave;
  });

  useEffect(() => {
    // A second at a time; after the last one it goes.
    const timer =
      held === null
        ? undefined
        : setTimeout(() => {
            if (held.left > 1) {
              setHeld({ value: held.value, left: held.left - 1 });
              return;
            }
            leaving.current = null;
            setHeld(null);
            goNow(held.value);
          }, secondMs);
    return () => {
      clearTimeout(timer);
    };
  }, [held]);

  useEffect(() => {
    /** What is held, taken: none is sent twice. */
    const taken = (): { value: T } | null => {
      const kept = leaving.current;
      leaving.current = null;
      return kept;
    };
    // A reload or a closed tab: sent now, as on any page that stays, and
    // the browser asks first, so the page lasts while it goes.
    const asked = (event: BeforeUnloadEvent): void => {
      const kept = taken();
      if (kept === null) {
        return;
      }
      setHeld(null);
      goNow(kept.value);
      event.preventDefault();
    };
    // Hidden with no question asked: sent as the page goes.
    const hidden = (): void => {
      const kept = taken();
      if (kept === null) {
        return;
      }
      setHeld(null);
      sendOnLeave.current(kept.value);
    };
    addEventListener("beforeunload", asked);
    addEventListener("pagehide", hidden);
    return () => {
      removeEventListener("beforeunload", asked);
      removeEventListener("pagehide", hidden);
      // Another page of Grasp, or the card closed.
      const kept = taken();
      if (kept !== null) {
        sendOnLeave.current(kept.value);
      }
    };
  }, []);

  const hold = (value: T): void => {
    leaving.current = { value };
    setHeld({ value, left: seconds });
  };
  const undo = (): void => {
    leaving.current = null;
    setHeld(null);
  };
  return { held, hold, undo };
};
