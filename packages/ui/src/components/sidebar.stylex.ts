// Sidebar's markers. StyleX resolves a marker only when it is imported straight from a .stylex.ts
// file, so they live here, beside sidebar.tsx.
import * as stylex from "@stylexjs/stylex";

/**
 * The sidebar itself, marked so its parts follow its state (`data-state`, `data-collapsible`) from
 * its attributes alone: the head script (`sidebarStateScript`) sets them before React wakes.
 */
export const sidebarMarker = stylex.defineMarker();

/** A menu item, marked so its action shows while the pointer or focus is anywhere on the item. */
export const sidebarMenuItemMarker = stylex.defineMarker();

/**
 * The row the sidebar and the page stand in (SidebarProvider's), marked so a part in the page
 * follows the sidebar's state from its attributes alone, before React wakes: a fold in the page's
 * bar that shows only while the sidebar is folded away.
 */
export const sidebarWrapperMarker = stylex.defineMarker();
