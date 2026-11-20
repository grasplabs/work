// The ask flow's state: whether the chat is open beside the page, whether it covers the page, and
// where focus goes when it changes. On send the host calls `show()`: the chat opens and focus lands
// in its composer once that field is there; `close()` brings focus back to the bar's field.
//
//   const ask = useAskPanel();
//   <AppShell dock={<AskBar ref={ask.bar} onSend={(text) => { send(text); ask.show(); }} … />} dockShown={!ask.open}
//     panels={<AskPanel ref={ask.panel} onClose={ask.close} … />} panelsOpen={ask.open}
//     covered={ask.open && ask.expanded} … />
"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import type { AskBarHandle } from "./ask-bar";
import type { AskPanelHandle } from "./ask-panel";

/** What useAskPanel takes. */
export interface UseAskPanelOptions {
  /** Whether the chat is open, when you keep it in state. Pair it with `onOpenChange`. */
  open?: boolean;
  /** Whether the chat starts open. */
  defaultOpen?: boolean;
  /** Called with the new open state when `show()` or `close()` changes it. */
  onOpenChange?: (open: boolean) => void;
}

/** What useAskPanel gives back. */
export interface AskPanelState {
  /** The chat is open beside the page (the bar is away). */
  open: boolean;
  /** The chat lies over the whole page: give it to App shell's `covered`. */
  expanded: boolean;
  /** Sets `expanded`, as the head's expand button does. */
  setExpanded: (expanded: boolean) => void;
  /** Opens the chat and puts focus in its composer once that can take it. */
  show: () => void;
  /** Closes the chat (and docks it) and puts focus back in the bar once that can take it. */
  close: () => void;
  /** Give it to the AskBar's `ref`. */
  bar: RefObject<AskBarHandle | null>;
  /** Give it to the AskPanel's `ref`. */
  panel: RefObject<AskPanelHandle | null>;
}

/** The frame a focus waits for, so a new try (or leaving) cancels the one before. */
interface Pending {
  frame: number;
}

/** How many frames a focus waits for its field: about a third of a second at 60 frames a second. */
const TRIES = 20;

// Focus in a part's field once it can take it, without scrolling anything. The part may not be
// there yet (the host swaps the bar for the panel as it renders), so this tries on the next frame
// and again, up to `tries` frames. Out of the hook, so it can call itself.
const focusSoon = (
  pending: Pending,
  target: RefObject<{ focus: () => boolean } | null>,
  tries: number
) => {
  cancelAnimationFrame(pending.frame);
  pending.frame = requestAnimationFrame(() => {
    const took = target.current?.focus() ?? false;
    if (!took && tries > 0) {
      focusSoon(pending, target, tries - 1);
    }
  });
};

/** The ask flow's state: open, expanded, and focus handed between the bar and the panel. */
export const useAskPanel = (options?: UseAskPanelOptions): AskPanelState => {
  const given = options?.open;
  const onOpenChange = options?.onOpenChange;
  const [own, setOwn] = useState(options?.defaultOpen ?? false);
  const [expanded, setExpanded] = useState(false);
  const bar = useRef<AskBarHandle | null>(null);
  const panel = useRef<AskPanelHandle | null>(null);
  const pending = useRef<Pending>({ frame: 0 });
  const open = given ?? own;
  // Leaving the page cancels a focus still waiting for its field.
  useEffect(() => {
    const waiting = pending.current;
    return () => {
      cancelAnimationFrame(waiting.frame);
    };
  }, []);
  const change = (next: boolean) => {
    if (given === undefined) {
      setOwn(next);
    }
    if (next !== open) {
      onOpenChange?.(next);
    }
  };
  const show = () => {
    change(true);
    focusSoon(pending.current, panel, TRIES);
  };
  const close = () => {
    change(false);
    setExpanded(false);
    focusSoon(pending.current, bar, TRIES);
  };
  return { open, expanded, setExpanded, show, close, bar, panel };
};
