import { Button } from "@grasp-os/ui/components/button";
import { useLingui } from "@lingui/react/macro";
import { ChevronUpIcon } from "lucide-react";
import { useEffect, useLayoutEffect } from "react";
import type { RefObject } from "react";

import {
  dockDrawer,
  dockDrawerWidth,
  setDockDrawerWidth,
  settledDrawerWidth,
  useDockDrawerWidth,
  widestDockDrawer,
} from "./dock-mode.ts";

// The chat dock's frame (chat-dock.tsx): how wide it is, and the ways into
// the conversation behind its folded box.

/**
 * How wide the frame or the drawer is, as a variable the dock's class
 * reads (no inline style): the frame always as the drawer is at first, the
 * drawer as its edge was dragged. A window made narrower takes the drawer
 * in with it. Returns what the edge sets the width with while it is
 * dragged.
 */
export const useDockWidth = (
  dock: RefObject<HTMLElement | null>,
  drawer: boolean
): ((width: number) => void) => {
  const drawerWidth = useDockDrawerWidth();
  // Again whenever the dock changes between the frame and the drawer: a
  // drag shows a width of its own (the returned setter) that the frame
  // mustn't keep, even when the kept width is the same as before.
  useLayoutEffect(() => {
    const width = drawer ? drawerWidth : dockDrawer.normal;
    dock.current?.style.setProperty("--dock-width", `${width}px`);
  }, [dock, drawer, drawerWidth]);
  // The room the pages that make room for the drawer leave it (dockDrawerRoom).
  useLayoutEffect(() => {
    document.documentElement.style.setProperty(
      "--dock-room",
      `${drawerWidth + dockDrawer.inset}px`
    );
  }, [drawerWidth]);
  useEffect(() => {
    const fit = (): void => {
      setDockDrawerWidth(
        settledDrawerWidth(dockDrawerWidth(), widestDockDrawer(innerWidth))
      );
    };
    fit();
    addEventListener("resize", fit);
    return () => {
      removeEventListener("resize", fit);
    };
  }, []);
  return (next) => {
    dock.current?.style.setProperty("--dock-width", `${next}px`);
  };
};

/**
 * A click into the folded box (`dock`), with a conversation behind it
 * (`unfolds`), opens the chat on it (`onOpen`, the same as OpenChat's, so
 * an App's chat is found either way), even with the cursor already in the
 * box. Tabbing into the box is to type in it; the keyboard's way in is
 * OpenChat.
 */
export const useUnfoldOnPointer = (
  dock: RefObject<HTMLElement | null>,
  unfolds: boolean,
  onOpen: () => void
): void => {
  useEffect(() => {
    const element = dock.current;
    const unfold = (event: Event): void => {
      if (event.target instanceof HTMLTextAreaElement) {
        onOpen();
      }
    };
    if (unfolds) {
      element?.addEventListener("pointerdown", unfold);
    }
    return () => {
      element?.removeEventListener("pointerdown", unfold);
    };
  }, [dock, unfolds, onOpen]);
};

/**
 * The way in to the conversation behind the folded box, for the keyboard
 * as for the pointer: a button beside the box's own, and a line, read out
 * with the box, that says the conversation is there.
 */
export const OpenChat = ({
  controls,
  hint,
  onOpen,
}: {
  /** The id of the dock it opens. */
  controls: string;
  /** The id its line takes, which describes the box. */
  hint: string;
  onOpen: () => void;
}) => {
  const { t } = useLingui();
  return (
    <>
      <span className="sr-only" id={hint}>
        {t`There is a conversation here. Open the chat to see it.`}
      </span>
      <Button
        aria-controls={controls}
        aria-expanded={false}
        aria-label={t`Open the chat`}
        onClick={onOpen}
        size="icon-xs"
        title={t`Open the chat`}
        type="button"
        variant="ghost"
      >
        <ChevronUpIcon />
      </Button>
    </>
  );
};
