import { useEffect, useEffectEvent, useRef, useState } from "react";

// A change someone confirmed that waits a few seconds with Undo before it
// counts: pausing a workflow beside its name, answering what waits on
// them in Runs › Today. One rule for each, so no confirmed change is ever
// lost: Undo takes it back; otherwise it goes when the seconds are over,
// or at once when the page goes first (left, or the card closed), as the
// yes was given. Leaving is not a quiet undo.

/** One second, in milliseconds. */
const secondMs = 1000;

interface Held<T> {
  value: T;
  left: number;
}

/**
 * Holds a confirmed `value` for `seconds` before `go` sends it; `goOnLeave`
 * sends it when the component goes first, with nothing left to show the
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

  useEffect(
    () => () => {
      const kept = leaving.current;
      leaving.current = null;
      if (kept !== null) {
        sendOnLeave.current(kept.value);
      }
    },
    []
  );

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
