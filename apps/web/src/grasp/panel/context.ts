// What a panel's parts share (panel.tsx): whether its head has scrolled away under the bar
// (`folded`), whether anything has scrolled at all (`scrolled`), and the scroller they watch.
import { createContext, use } from "react";
import type { RefObject } from "react";

export interface PanelState {
  /** Something has scrolled under the bar: it shows its hairline. */
  scrolled: boolean;
  /** The views have reached the bar: they stand in it as icons. */
  folded: boolean;
  /** The panel's scroller, which the parts watch. */
  scroller: RefObject<HTMLDivElement | null>;
  /** The panel has views (tabs), so its content is one PanelView per view. */
  hasViews: boolean;
  setScrolled: (scrolled: boolean) => void;
  setFolded: (folded: boolean) => void;
}

export const PanelContext = createContext<PanelState | null>(null);

export const usePanel = (): PanelState => {
  const state = use(PanelContext);
  if (state === null) {
    throw new Error("A panel's parts go inside a Panel.");
  }
  return state;
};
