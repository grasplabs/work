/**
 * The overlays on the gallery's pages (apps/web, `/kit/…`), by page: how
 * each opens and what then shows. The kit's component tests open every one
 * and close it with Escape (test/kit.browser.test.tsx).
 */

/** An element found by its role and accessible name, or by its text. */
export type Target =
  | {
      role: "alertdialog" | "button" | "combobox" | "dialog" | "link";
      name?: string;
      exact?: boolean;
      /** Only inside the page's own content, not in a popup over it. */
      inMain?: boolean;
    }
  | { role: "listbox" | "menu" | "menuitem"; name?: string }
  | { text: string };

/**
 * How an overlay opens: from its trigger with a key, on focus from the
 * keyboard (a tooltip), on hover (a preview card) or on right click (a
 * context menu). Each closes with Escape; the ones opened from the
 * keyboard give focus back to their trigger.
 */
export interface Overlay {
  trigger: Target;
  open: "Enter" | "ArrowDown" | "focus" | "hover" | "right click";
  opened: Target;
  /** Only there at this width, such as a phone's menu button. */
  viewport?: { width: number; height: number };
}

/** A phone's viewport, where the gallery is first checked. */
export const phone = { width: 390, height: 844 };

/** A desktop's viewport. */
export const desktop = { width: 1280, height: 800 };

const openButton = (name: string): Target => ({
  role: "button",
  name: `Open ${name}`,
  exact: true,
});

/** The kit's components whose demo is an overlay, by name. */
const components: Record<string, Overlay> = {
  "alert-dialog": {
    trigger: openButton("alert dialog"),
    open: "Enter",
    opened: { role: "alertdialog" },
  },
  combobox: {
    trigger: { role: "combobox", name: "Framework" },
    open: "ArrowDown",
    opened: { role: "listbox" },
  },
  "context-menu": {
    trigger: { text: "Right-click here" },
    open: "right click",
    opened: { role: "menu" },
  },
  dialog: {
    trigger: openButton("dialog"),
    open: "Enter",
    opened: { role: "dialog" },
  },
  drawer: {
    trigger: openButton("drawer"),
    open: "Enter",
    opened: { role: "dialog" },
  },
  "dropdown-menu": {
    trigger: openButton("dropdown menu"),
    open: "Enter",
    opened: { role: "menu" },
  },
  "hover-card": {
    trigger: { role: "link", name: "Maya Jansen" },
    open: "hover",
    opened: { text: "Account manager for Benelux." },
  },
  menubar: {
    trigger: { role: "menuitem", name: "File" },
    open: "Enter",
    opened: { role: "menu" },
  },
  "navigation-menu": {
    trigger: openButton("navigation menu"),
    open: "Enter",
    opened: { role: "link", name: "Guides" },
  },
  popover: {
    trigger: openButton("popover"),
    open: "Enter",
    opened: { role: "dialog" },
  },
  select: {
    trigger: { role: "combobox", name: "Model" },
    open: "Enter",
    opened: { role: "listbox" },
  },
  sheet: {
    trigger: openButton("sheet"),
    open: "Enter",
    opened: { role: "dialog" },
  },
  tooltip: {
    trigger: openButton("tooltip"),
    open: "focus",
    // Base UI gives the popup no role; it describes the trigger.
    opened: { text: "Add to the library" },
  },
};

/** The overlays of the kit's examples, by name: several on a page. */
const examples: Record<string, readonly Overlay[]> = {
  dialog: [
    {
      trigger: { role: "button", name: "Rename", exact: true, inMain: true },
      open: "Enter",
      opened: { role: "dialog" },
    },
    {
      trigger: { role: "button", name: "Delete", exact: true, inMain: true },
      open: "Enter",
      opened: { role: "alertdialog" },
    },
  ],
  "responsive-navigation": [
    {
      trigger: {
        role: "button",
        name: "Open the menu",
        exact: true,
        inMain: true,
      },
      open: "Enter",
      opened: { role: "dialog" },
      viewport: phone,
    },
  ],
};

/** The components and examples the overlays above belong to, by name. */
export const overlayNames = {
  components: Object.keys(components),
  examples: Object.keys(examples),
};

/** A component's overlays (`/kit/components/<name>`). */
export const componentOverlays = (name: string): readonly Overlay[] => {
  const overlay = components[name];
  return overlay === undefined ? [] : [overlay];
};

/** An example's overlays (`/kit/examples/<name>`). */
export const exampleOverlays = (name: string): readonly Overlay[] =>
  examples[name] ?? [];
