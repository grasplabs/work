import { createContext, use, useRef, useState } from "react";
import type { ReactNode } from "react";

import { LeaveConfirmDialog } from "./screen-frame.tsx";

// What the shell's panel slot shows (app-panel.tsx), held for the whole
// shell so a page navigating under it leaves it as it is. Its screen
// outlives the page's navigations, so nothing of the page asks before it
// goes: closing the panel, however (its button, a sheet's own close, an
// Escape), and replacing it with another screen ask here instead, once,
// while its screen holds edits that would be lost.

/** What the panel shows: a screen of an App, opened as core checks it. */
export interface OpenedPanel {
  app: string;
  /** The screen's file name, as `ScreensApi.open` takes it. */
  screen: string;
  /** What the panel's chrome calls it: the surface's title, or the App's name. */
  title: string;
  /** The route it opens by, its input as JSON text, and its surface. */
  route?: string;
  input?: string;
  surface?: string;
}

/** How the panel is changed: asked first while its screen holds edits. */
interface PanelActions {
  /**
   * Shows `panel` in place of what the panel shows. Resolves with whether
   * it does: false when the person chose to stay with the edits of the
   * screen it shows (or another change took its place first).
   */
  open: (panel: OpenedPanel) => Promise<boolean>;
  close: () => void;
  /** Closes it without asking: its App is gone for the person. */
  discard: () => void;
  /** Whether its screen holds edits that closing or replacing would lose. */
  guarded: (guarded: boolean) => void;
}

/** A change of the panel waiting on the person's answer. */
interface Pending {
  next: OpenedPanel | null;
  settle: (applied: boolean) => void;
}

/** The shell's panel: what it shows, and how to change it. */
export interface AppPanel extends PanelActions {
  opened: OpenedPanel | null;
}

/** What the panel shows. */
const OpenedContext = createContext<OpenedPanel | null>(null);

/** How the panel is changed; null outside the shell, which has none. */
const ActionsContext = createContext<PanelActions | null>(null);

/**
 * The shell's panel, or null outside the shell (a full-page screen), where
 * no slot stands to open one in.
 */
export const useAppPanel = (): AppPanel | null => {
  const opened = use(OpenedContext);
  const actions = use(ActionsContext);
  return actions === null ? null : { ...actions, opened };
};

/** Holds the shell's panel for everything under it. */
export const AppPanelProvider = ({ children }: { children: ReactNode }) => {
  const [opened, setOpened] = useState<OpenedPanel | null>(null);
  // What waits on the person's answer: the panel's next content, and who
  // asked for it, told whether it came.
  const [pending, setPending] = useState<Pending | null>(null);
  const holdsEdits = useRef(false);
  // The same change, read by the actions made once (`pending` is state).
  const waiting = useRef<Pending | null>(null);
  /** Ends the wait for an answer, telling who asked whether it came. */
  const settle = (applied: boolean): void => {
    waiting.current?.settle(applied);
    waiting.current = null;
    setPending(null);
  };
  // Made once, so the context's value never changes: its functions read
  // the ref and call the setters, which stay the same.
  // oxlint-disable-next-line react/hook-use-state -- made once, never set
  const [actions] = useState<PanelActions>(() => {
    const change = async (next: OpenedPanel | null): Promise<boolean> => {
      if (!holdsEdits.current) {
        setOpened(next);
        return true;
      }
      // One question at a time: a newer change takes the place of one
      // still asked, which then didn't come.
      waiting.current?.settle(false);
      const { promise, resolve } = Promise.withResolvers<boolean>();
      const asked: Pending = { next, settle: resolve };
      waiting.current = asked;
      setPending(asked);
      return await promise;
    };
    return {
      open: change,
      close: () => {
        void change(null);
      },
      discard: () => {
        holdsEdits.current = false;
        waiting.current?.settle(false);
        waiting.current = null;
        setPending(null);
        setOpened(null);
      },
      guarded: (guarded) => {
        holdsEdits.current = guarded;
      },
    };
  });
  return (
    <ActionsContext value={actions}>
      <OpenedContext value={opened}>
        {children}
        <LeaveConfirmDialog
          onLeave={() => {
            holdsEdits.current = false;
            setOpened(pending?.next ?? null);
            settle(true);
          }}
          onStay={() => {
            settle(false);
          }}
          open={pending !== null}
        />
      </OpenedContext>
    </ActionsContext>
  );
};

/**
 * Whether a page's own side panel, `asked` open, shows: not while the
 * shell's panel shows a screen, which stands where it stands.
 */
export const usePageSidePanel = (asked: boolean): boolean => {
  const opened = use(OpenedContext);
  return asked && opened === null;
};
