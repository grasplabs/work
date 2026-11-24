import { Sheet, SheetContent } from "@grasp-os/ui/components/sheet";
import { SidePanelPlacementProvider } from "@grasp-os/ui/components/side-panel";
import type { SidePanelPlacement } from "@grasp-os/ui/components/side-panel";
import { colors, size } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import {
  createContext,
  use,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";

// A page's own side panel (the Inbox's inspector, a note's details in the
// Brain, an integration's facts), which the frame seats as the reference's
// App shell does (#2503's grasp/app-shell `pagePanel`): beside the page in
// the same card, 420px wide, flush with the card's end and foot from the
// top of the page's bar, a hairline at its start, on the card's ground,
// where the page keeps room beside it; a sheet from the end where it would
// not: where the card less the panel leaves the page's column under its
// least (`pageMinWidth`; more for a page such as a table that must stay
// whole). The page keeps its panel's state and draws its own button to
// show it:
//
//   const [open, setOpen] = useState(true);
//   <PagePanel label={t`Details`} open={open} onOpenChange={setOpen}>
//     <SidePanel aria-label={t`Details`}>…</SidePanel>
//   </PagePanel>
//
// The page draws nothing in its own column for it.

/** What a page asks of the frame for its panel. */
interface Claim {
  /** The page claiming it, so the next page's claim starts afresh. */
  page: string;
  label: string;
  open: boolean | undefined;
  /** The least the page's own column needs beside the panel, in pixels. */
  pageMinWidth: number;
  change: (open: boolean) => void;
}

/** The frame's seat: where the panel is drawn, how it stands there, and how a page claims it. */
interface Seat {
  host: HTMLElement | null;
  placement: SidePanelPlacement;
  claim: (claim?: Claim) => void;
}

const SeatContext = createContext<Seat | undefined>(undefined);

// The panel's width, the reference's inspector's (#2503's `--grasp-inspector-width`).
const PANEL_FIRST = 420;
/**
 * The least a page's column keeps beside the panel, in pixels, unless the
 * page asks for more. The reference (#2503) seats its panel beside the
 * page from a window of 892px; under 1024px this frame's card is the whole
 * window (the sidebar a sheet), so 892 less the panel's first width puts
 * the switch at the same window.
 */
export const PAGE_MIN_WIDTH = 892 - PANEL_FIRST;

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

/** Whether the panel goes in a sheet: beside it, on a card of `width`, the page would have less than `pageMinWidth`. */
const isNarrow = (width: number, pageMinWidth: number): boolean =>
  width - PANEL_FIRST < pageMinWidth;

/** What the sheet last saw of the page's claim. */
interface Seen {
  page: string | undefined;
  open: boolean;
  narrow: boolean;
  asked: boolean;
}

/**
 * Whether the sheet is open: only once the page asks it open on a narrow
 * card (its `open` turns true there), as the reference's is. A page's first
 * `open`, on a phone's first look or as it comes, and a panel open beside
 * the page when the card narrows, never cover the page with a sheet.
 */
const useAskedOpen = (
  page: string | undefined,
  open: boolean,
  narrow: boolean
): boolean => {
  const [seen, setSeen] = useState<Seen>({
    page,
    open,
    narrow,
    asked: false,
  });
  if (seen.page !== page || seen.open !== open || seen.narrow !== narrow) {
    setSeen({
      page,
      open,
      narrow,
      asked: seen.page === page && open && narrow && !seen.open && seen.narrow,
    });
  }
  return seen.asked && open && narrow;
};

const styles = stylex.create({
  // The page's room under the banner: the page's column, then its panel.
  body: { display: "flex", flexGrow: 1, minHeight: 0 },
  page: { display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0 },
  // In the page's card, at its end, flush with its end and foot: a hairline
  // at its start, on the card's ground.
  panel: {
    flexShrink: 0,
    boxSizing: "border-box",
    width: `${PANEL_FIRST}px`,
    maxWidth: "100%",
    minHeight: 0,
    borderInlineStartWidth: size.hairline,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: {
      default: colors.sidebarBorder,
      "@media (forced-colors: active)": "CanvasText",
    },
    backgroundColor: colors.sidebarCard,
  },
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
  const body = useRef<HTMLDivElement>(null);
  const width = useWidth(body);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [claim, setClaim] = useState<Claim>();
  // What the person last chose, kept from page to page.
  const [own, setOwn] = useState<boolean>();
  const narrow = claim !== undefined && isNarrow(width, claim.pageMinWidth);
  // Unset by the page, open beside a page with room, and never a sheet on
  // its own: it would cover the page.
  const open = claim !== undefined && (claim.open ?? own ?? true);
  const sheetOpen = useAskedOpen(claim?.page, open, narrow);
  const setOpen = (next: boolean) => {
    setOwn(next);
    claim?.change(next);
  };
  const seat = <div ref={setHost} {...stylex.props(styles.host)} />;
  return (
    <SeatContext
      // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
      value={{ host, placement: narrow ? "sheet" : "beside", claim: setClaim }}
    >
      <div ref={body} {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.page)}>{children}</div>
        {open && !narrow ? (
          <div data-slot="app-shell-page-panel" {...stylex.props(styles.panel)}>
            {seat}
          </div>
        ) : null}
      </div>
      {narrow ? (
        <Sheet onOpenChange={setOpen} open={sheetOpen}>
          <SheetContent aria-label={claim.label}>{seat}</SheetContent>
        </Sheet>
      ) : null}
    </SeatContext>
  );
};

/**
 * The page's side panel, seated by the frame. `open` is the page's own
 * state: it shows the panel beside a page with room at once, and in a
 * sheet only when it turns true there (the page's own button), so a page
 * opening with its panel open does not cover itself on a phone. Left out,
 * the frame shows it beside a page with room, keeps it closed where it
 * would be a sheet, and keeps what the person chose for the next page.
 * `onOpenChange` hears the frame close it (the sheet closed). `pageMinWidth`
 * is the least the page's own column needs beside the panel, in pixels
 * (`PAGE_MIN_WIDTH` unless the page needs more): on a card narrower than
 * that and the panel, the panel is a sheet.
 */
export const PagePanel = ({
  label,
  open,
  onOpenChange,
  pageMinWidth = PAGE_MIN_WIDTH,
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
  const page = useId();
  // The page's latest handler, so the claim stays one object as the page redraws.
  const heard = useRef(onOpenChange);
  useEffect(() => {
    heard.current = onOpenChange;
  }, [onOpenChange]);
  useEffect(() => {
    claim?.({
      page,
      label,
      open,
      pageMinWidth,
      change: (next) => {
        heard.current?.(next);
      },
    });
  }, [claim, page, label, open, pageMinWidth]);
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
  // Drawn where the frame seats it, and told how it stands there: a
  // portal's context is the page's, not the seat's.
  return createPortal(
    <SidePanelPlacementProvider value={seat.placement}>
      {children}
    </SidePanelPlacementProvider>,
    seat.host
  );
};
