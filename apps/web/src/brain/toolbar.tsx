import type { ReactNode } from "react";

// What the transcript's filter takes from the prototype's Landscape toolbar
// (`components/landscape/toolbar.tsx`): the label that slides out, and how
// long the pointer rests before a hover menu opens or closes.

/**
 * The label of a toolbar button. It stays folded away and slides out while the button is hovered,
 * focused from the keyboard or has its menu open, so the toolbar stays a row of icons. It is always
 * in the accessibility tree, so the button keeps its name.
 */
export const ToolbarLabel = ({ children }: { children: ReactNode }) => (
  <span className="-mx-1 max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-200 ease-out group-hover/button:mx-0 group-hover/button:max-w-32 group-hover/button:opacity-100 group-focus-visible/button:mx-0 group-focus-visible/button:max-w-32 group-focus-visible/button:opacity-100 group-aria-expanded/button:mx-0 group-aria-expanded/button:max-w-32 group-aria-expanded/button:opacity-100 group-data-popup-open/button:mx-0 group-data-popup-open/button:max-w-32 group-data-popup-open/button:opacity-100 motion-reduce:transition-none">
    {children}
  </span>
);

/** How long the pointer rests before a toolbar menu opens, and before it closes after leaving, in ms. */
export const hoverDelay = { open: 75, close: 150 };
