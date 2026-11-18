import * as stylex from "@stylexjs/stylex";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

// A page's own panel, an inspector, seated in App shell's panels, flush
// with the bar, the card's end and its foot, in place of the chat while it
// is open (Ruben's rule: never a grey column inside the page). The page
// draws it through a portal into the shell's slot, so the shell holds only
// whether one is open, never the page's elements: a new render of the page
// never sets the shell's state again.

const styles = stylex.create({
  slot: { height: "100%", minHeight: 0, display: "grid" },
});

interface PagePanelHost {
  /** Where the page's panel goes, once the shell drew its slot. */
  node: HTMLElement | null;
  /** Whether a page's panel is open. */
  setOpen: (open: boolean) => void;
  /** How the shell closes it: the page's own close, while it is open. */
  setClose: (close: { run: () => void } | null) => void;
}

const PagePanelContext = createContext<PagePanelHost>({
  node: null,
  setOpen: () => {
    // No shell: the page draws nothing in it.
  },
  setClose: () => {
    // No shell: nothing to close.
  },
});

/** The shell's side: whether a page's panel is open, its slot, and the close the page gave. */
export const usePagePanelHost = () => {
  const [open, setOpen] = useState(false);
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [close, setClose] = useState<{ run: () => void } | null>(null);
  const host: PagePanelHost = { node, setOpen, setClose };
  return {
    open,
    host,
    slot: <div ref={setNode} {...stylex.props(styles.slot)} />,
    onClose: () => {
      close?.run();
    },
  };
};

export const PagePanelProvider = ({
  host,
  children,
}: {
  host: PagePanelHost;
  children: ReactNode;
}) => <PagePanelContext value={host}>{children}</PagePanelContext>;

/** Draws `children` in the shell's panels while `open`; closed, nothing. */
export const PagePanel = ({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) => {
  const { node, setOpen, setClose } = useContext(PagePanelContext);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    setOpen(open);
    setClose(
      open
        ? {
            run: () => {
              closeRef.current();
            },
          }
        : null
    );
    return () => {
      setOpen(false);
      setClose(null);
    };
  }, [open, setOpen, setClose]);
  return open && node !== null ? createPortal(children, node) : null;
};
