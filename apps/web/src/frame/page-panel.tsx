import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@grasp-os/ui/components/resizable";
import { Sheet, SheetContent } from "@grasp-os/ui/components/sheet";
import { SidePanelPlacementProvider } from "@grasp-os/ui/components/side-panel";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";

// A page's own side panel (the Inbox's inspector, a note's details in the
// Brain, an integration's facts), which the frame seats as Damsko's
// app-shell-01 seats its panel: beside the page, resizable by its handle,
// on a wide card; a sheet from the end on a narrow one. The card is
// narrow, as the reference's (#2503) is, under a phone's width (40rem), or
// where the page's content would have less than it needs beside the
// panel (`pageMinWidth`, such as a table that must stay whole). The page
// keeps its panel's state and draws its own button to show it:
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
  /** The least the page's own column needs beside the panel, in pixels. */
  pageMinWidth: number;
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
const PANEL_FIRST = 420;
const PANEL_MIN = "320px";
const PANEL_MAX = "50%";
// Under this card width, in rem, the panel is a sheet whatever the page
// needs: a phone's, as the reference's shell has it.
const SHEET_BELOW_REM = 40;

/** What an effect with nothing to undo returns. */
const holdNothing = () => {
  // Nothing was started.
};

/** How wide the card's room is, followed as the window and the sidebar change it. */
const useWidth = (element: RefObject<HTMLElement | null>): number => {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const at = element.current;
    if (at === null) {
      return holdNothing;
    }
    const read = () => {
      setWidth(at.getBoundingClientRect().width);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(at);
    return () => {
      observer.disconnect();
    };
  }, [element]);
  return width;
};

/** Whether the panel goes in a sheet: a card of `width` too narrow for it beside the page. */
const isNarrow = (width: number, pageMinWidth: number): boolean => {
  // The root's font size reads "16px": the unit off, it is a number.
  const rem =
    Number(
      getComputedStyle(document.documentElement).fontSize.replace("px", "")
    ) || 16;
  return width < SHEET_BELOW_REM * rem || width - PANEL_FIRST < pageMinWidth;
};

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
  const body = useRef<HTMLDivElement>(null);
  const width = useWidth(body);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [claim, setClaim] = useState<Claim>();
  // What the person last chose, kept from page to page.
  const [own, setOwn] = useState<boolean>();
  const narrow = claim !== undefined && isNarrow(width, claim.pageMinWidth);
  // Unset by the page, open beside a wide page and closed on a narrow
  // card, where it would cover the page.
  const open = claim !== undefined && (claim.open ?? own ?? !narrow);
  const setOpen = (next: boolean) => {
    setOwn(next);
    claim?.change(next);
  };
  const seat = <div ref={setHost} {...stylex.props(styles.host)} />;
  return (
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
    <SeatContext value={{ host, claim: setClaim }}>
      <div ref={body} {...stylex.props(styles.body)}>
        <ResizablePanelGroup>
          <ResizablePanel>{children}</ResizablePanel>
          {open && !narrow ? (
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
      {narrow ? (
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
 * closed on a narrow card, and keeps what the person chose for the next
 * page. `onOpenChange` hears the frame close it (the sheet closed) and
 * open it. `pageMinWidth` is the least the page's own content needs beside
 * the panel, in pixels: on a card narrower than that and the panel, the
 * panel is a sheet.
 */
export const PagePanel = ({
  label,
  open,
  onOpenChange,
  pageMinWidth = 0,
  children,
}: {
  label: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  pageMinWidth?: number;
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
      pageMinWidth,
      change: (next) => {
        heard.current?.(next);
      },
    });
  }, [claim, label, open, pageMinWidth]);
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
