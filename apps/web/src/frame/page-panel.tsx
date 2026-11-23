import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@grasp-os/ui/components/resizable";
import { Sheet, SheetContent } from "@grasp-os/ui/components/sheet";
import { SidePanelPlacementProvider } from "@grasp-os/ui/components/side-panel";
import { useSidebar } from "@grasp-os/ui/components/sidebar";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createContext, use, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

// A page's own side panel (the Inbox's inspector, a note's details in the
// Brain, an integration's facts), which the frame seats as Damsko's
// app-shell-01 seats its panel: beside the page, resizable by its handle,
// on a wide window; a sheet from the end on a narrow one. The page keeps
// its panel's state and draws its own button to show it:
//
//   const [open, setOpen] = useState(true);
//   <PagePanel label={t`Details`} open={open} onOpenChange={setOpen}>
//     <SidePanel aria-label={t`Details`}>…</SidePanel>
//   </PagePanel>
//
// The page draws nothing in its own column for it.

/** What a page asks of the frame for its panel. */
interface Claim {
  label: string;
  open: boolean | undefined;
  change: (open: boolean) => void;
}

/** The frame's seat: where the panel is drawn, and how a page claims it. */
interface Seat {
  host: HTMLElement | null;
  claim: (claim?: Claim) => void;
}

const SeatContext = createContext<Seat | undefined>(undefined);

// The panel's first width, its least and its most: Resizable takes lengths, so these restate the
// side-panel-width token (420px) and a floor a panel's sections still read at, as app-shell-01.
const PANEL_WIDTH = "420px";
const PANEL_MIN = "320px";
const PANEL_MAX = "50%";

const styles = stylex.create({
  // The page's room under the banner: the group of the page and its panel.
  body: { flexGrow: 1, minHeight: 0 },
  panel: { height: "100%", minHeight: 0 },
  // The whole of the place the frame gives, so the panel lays itself out in it.
  host: { display: "grid", height: "100%", minHeight: 0 },
});

/**
 * The page's column (`children`) and its side panel, when a page in it
 * claims one. One group always, the page its first panel, so the panel
 * coming and going never draws the page anew: it keeps its scroll place
 * and what was typed in it.
 */
export const PageWithPanel = ({ children }: { children: ReactNode }) => {
  const { t } = useLingui();
  const { isMobile } = useSidebar();
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [claim, setClaim] = useState<Claim>();
  const [own, setOwn] = useState<boolean>();
  // Unset by the page, open beside a wide page and closed on a narrow
  // window, where it would cover the page.
  const open = claim !== undefined && (claim.open ?? own ?? !isMobile);
  const setOpen = (next: boolean) => {
    setOwn(next);
    claim?.change(next);
  };
  const seat = <div ref={setHost} {...stylex.props(styles.host)} />;
  return (
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
    <SeatContext value={{ host, claim: setClaim }}>
      <div {...stylex.props(styles.body)}>
        <ResizablePanelGroup>
          <ResizablePanel>{children}</ResizablePanel>
          {open && !isMobile ? (
            <>
              <ResizableHandle aria-label={t`Resize the panel`} />
              <ResizablePanel
                defaultSize={PANEL_WIDTH}
                maxSize={PANEL_MAX}
                minSize={PANEL_MIN}
              >
                <div
                  data-slot="app-shell-panel"
                  {...stylex.props(styles.panel)}
                >
                  <SidePanelPlacementProvider value="beside">
                    {seat}
                  </SidePanelPlacementProvider>
                </div>
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      </div>
      {claim !== undefined && isMobile ? (
        <Sheet onOpenChange={setOpen} open={open}>
          <SheetContent aria-label={claim.label}>
            <SidePanelPlacementProvider value="sheet">
              {seat}
            </SidePanelPlacementProvider>
          </SheetContent>
        </Sheet>
      ) : null}
    </SeatContext>
  );
};

/**
 * The page's side panel, seated by the frame. `open` is the page's own
 * state; left out, the frame shows it beside a wide page and keeps it
 * closed on a phone. `onOpenChange` hears the frame close it (the sheet
 * closed) and open it.
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
  const seat = use(SeatContext);
  const claim = seat?.claim;
  // The page's latest handler, so the claim stays one object as the page redraws.
  const heard = useRef(onOpenChange);
  useEffect(() => {
    heard.current = onOpenChange;
  }, [onOpenChange]);
  useEffect(() => {
    claim?.({
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
  if (seat === undefined || seat.host === null) {
    return null;
  }
  return createPortal(children, seat.host);
};
