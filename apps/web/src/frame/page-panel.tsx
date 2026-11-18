import * as stylex from "@stylexjs/stylex";
import { createContext, use, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import type { AppShellProps } from "../grasp/app-shell/index.ts";

// A page's own side panel (the Inbox's inspector, a note's details in the
// Brain, an integration's facts), handed to App shell, which seats it: flush
// with the bar, the card's end and the card's foot, the chat's bar centred on
// the page's column beside it, a sheet on a phone, and giving way when the
// chat docks. The page keeps its panel's state and draws its own button:
//
//   const [open, setOpen] = useState(true);
//   <PagePanel label={t`Details`} open={open} onOpenChange={setOpen}>
//     <NoteDetails />
//   </PagePanel>
//
// The page draws nothing in its own column for it, and needs no
// `page: "whole"` (frame/page-fill.ts) for the panel's sake.

/** What a page asks of the shell for its panel. */
interface Claim {
  label: string;
  open: boolean | undefined;
  change: (open: boolean) => void;
}

interface PagePanelFrame {
  /** Where the shell seats the panel: the page draws into it. */
  host: HTMLElement | null;
  claim: (claim?: Claim) => void;
}

const PagePanelContext = createContext<PagePanelFrame | undefined>(undefined);

const styles = stylex.create({
  // The whole of the place the shell gives, so the panel lays itself out in it.
  host: { display: "grid", minHeight: "100%" },
});

/** The frame's side of it: what App shell takes, and what the pages under it reach. */
export const usePagePanelSlot = (): {
  frame: PagePanelFrame;
  shell: Partial<AppShellProps>;
} => {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [claim, setClaim] = useState<Claim>();
  return {
    frame: { host, claim: setClaim },
    shell:
      claim === undefined
        ? {}
        : {
            pagePanel: <div ref={setHost} {...stylex.props(styles.host)} />,
            pagePanelLabel: claim.label,
            onPagePanelOpenChange: claim.change,
            ...(claim.open === undefined ? {} : { pagePanelOpen: claim.open }),
          },
  };
};

/** The frame's slot, given to the pages under it. */
export const PagePanelProvider = PagePanelContext;

/**
 * The page's side panel, seated by the shell. `open` is the page's own
 * state; left out, the shell shows it beside a wide page and keeps it closed
 * on a phone. `onOpenChange` hears the shell close it (the chat docked, the
 * sheet closed) and open it (the sheet opened).
 */
export const PagePanel = ({
  label,
  open,
  onOpenChange,
  children,
}: {
  label: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) => {
  const frame = use(PagePanelContext);
  const claim = frame?.claim;
  // The page's latest handler, so the claim stays one object as the page redraws.
  const heard = useRef(onOpenChange);
  useEffect(() => {
    heard.current = onOpenChange;
  }, [onOpenChange]);
  useEffect(() => {
    if (claim === undefined) {
      return;
    }
    claim({
      label,
      open,
      change: (next) => {
        heard.current?.(next);
      },
    });
  }, [claim, label, open]);
  // Given back as the page leaves, and only then: not between two claims.
  useEffect(
    () => () => {
      claim?.();
    },
    [claim]
  );
  if (frame === undefined || frame.host === null) {
    return null;
  }
  return createPortal(children, frame.host);
};
