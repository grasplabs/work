// What the chat's panels share with the frame round them (app-frame.tsx):
// where they find the shell, the page's card and the page, and the layer
// they stand on over the page (30, #2503's `shell-page-layer`, written
// out in each style: StyleX reads only what a file holds itself).

/** The frame's whole room, the sidebar too: Damsko's SidebarProvider. */
export const SHELL = "[data-slot=sidebar-wrapper]";

/** The page's card: Damsko's SidebarInset. */
export const CARD = "[data-slot=sidebar-inset]";

/** The page in the card, under its bar (app-frame.tsx). */
export const PAGE = "[data-slot=app-shell-page]";

/** The page's own bar (site-header.tsx). */
export const BAR = "[data-slot=site-header]";

/** The button at the card's end that shows or hides the chat (chat-toggle.tsx). */
export const TOGGLE = "[data-slot=chat-toggle]";
