import { useEffect, useRef, useState } from "react";

import { confirmGate } from "./confirm-gate.ts";
import type { ConfirmGate } from "./confirm-gate.ts";

/**
 * The gate (confirm-gate.ts) of Grasp's own confirmation of `pending`,
 * for every dialog a page can ask for (a link, a decision's answer), so
 * none of them takes a click or key a page timed to land on it.
 */
export const useConfirmGate = (
  pending: object | undefined,
  delayMs: number
): {
  /** Whether the confirm button is enabled. */
  enabled: boolean;
  /** For the confirm button's `onPointerDown` and `onKeyDown`. */
  press: () => void;
  /** Whether a click of the confirm button, with its `detail`, confirms. */
  accepts: (detail: number) => boolean;
} => {
  const [ready, setReady] = useState<object>();
  const gate = useRef<{ pending: object; gate: ConfirmGate } | null>(null);
  useEffect(() => {
    if (pending === undefined) {
      gate.current = null;
      // Nothing to listen for: the dialog is closed.
      return () => {
        gate.current = null;
      };
    }
    const current = confirmGate(performance.now(), delayMs);
    gate.current = { pending, gate: current };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => {
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          setReady(pending);
        },
        Math.max(0, current.enabledFrom() - performance.now())
      );
    };
    // Every press or key anywhere while the button is disabled starts its
    // delay again; captured first, before the button hears its own.
    const input = (): void => {
      const before = current.enabledFrom();
      current.input(performance.now());
      if (current.enabledFrom() !== before) {
        schedule();
      }
    };
    schedule();
    window.addEventListener("pointerdown", input, { capture: true });
    window.addEventListener("keydown", input, { capture: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", input, { capture: true });
      window.removeEventListener("keydown", input, { capture: true });
    };
  }, [pending, delayMs]);
  return {
    enabled: pending !== undefined && ready === pending,
    press: () => {
      gate.current?.gate.press(performance.now());
    },
    accepts: (detail) => {
      const opened = gate.current;
      // A click with no pointer behind it (`detail` 0: a page reader's
      // activate, or a key) counts as a press of its own as it lands, when
      // no press of the button came before it.
      const clickedAt = detail === 0 ? performance.now() : undefined;
      return (
        pending !== undefined &&
        opened?.pending === pending &&
        opened.gate.accepts(clickedAt)
      );
    },
  };
};
