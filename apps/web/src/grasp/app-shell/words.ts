// App shell's own words for its panels, in English. The product gives them in its languages through
// GraspWords (src/words).

export const appShellWords = {
  /** The name of the handle between the page and the panels. */
  resize: "Resize the panel",
  /** The name of the page's crumbs, for a screen reader. */
  breadcrumb: "Breadcrumb",
  /** The phone's Menu button. */
  menu: "Menu",
  /** The button that closes the phone's menu. */
  closeMenu: "Close the menu",
  /** The button that closes panels lying over the page for want of room. */
  closePanel: "Close the panel",
  /** On a phone, the button that sets the panels aside for the page and brings them back. */
  togglePanel: "Show or hide the panel",
  /** The bar's More button, once its `actionItems` fold into it for want of room. */
  more: "More actions",
};

export type AppShellWords = typeof appShellWords;

export const appShellPanelWords = {
  /** The name of a floating panel's head, which moves it: dragged, or with the arrow keys. */
  move: "Move the panel",
  /** Said of the head while it floats: how to move it from the keys. */
  moveHint:
    "Arrow keys move it, Shift for a longer step, End docks it beside the page, Escape goes back to the page",
  /** The control that lifts the docked panel off into a window over the page. */
  float: "Float over the page",
  /** The control that sets the floating panel back beside the page. */
  dock: "Dock beside the page",
  /** The link to the panel's own page. */
  page: "Open as a page",
  /** The control that takes the panel full screen over the page. */
  expand: "Full screen",
  /** The same control while it is full screen: back to where it was. */
  collapse: "Leave full screen",
  /** The name of the floating window's start edge, which resizes its width. */
  width: "Resize the panel's width",
  /** The name of the floating window's top edge, which resizes its height. */
  height: "Resize the panel's height",
};

export type AppShellPanelWords = typeof appShellPanelWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    appShell: AppShellWords;
    "app-shell-panel": AppShellPanelWords;
  }
}
