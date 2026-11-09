import "../src/styles.css";
import { CSPProvider } from "@base-ui/react/csp-provider";
import type { ComponentType } from "react";
import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";
import type { Locator } from "vite-plus/test/browser";

import { demos } from "../catalog/demos.ts";
import { loadExample } from "../catalog/examples.ts";
import type { ExampleName } from "../catalog/examples.ts";
import { PageHeaderTitle } from "../src/components/page-header.tsx";

// Every component in the UI kit, and every example for agents, rendered as
// the local gallery shows it (apps/web/src/routes/kit_.*), in a real
// Chromium: each has names for its controls, a visible focus from the
// keyboard, no sideways scroll on a phone, overlays that open from the
// keyboard and close with Escape, and a dark theme. The list is the kit's
// demos and examples, which test/catalog.test.ts holds to the components
// directory, so a component added to the kit is checked without touching
// this file. Core's Content Security Policy over the gallery's pages is
// held on the e2e stack (e2e/catalog.e2e.ts).

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    /** Emulates the system's colour scheme (vite.browser.config.ts). */
    colorScheme: (scheme: "light" | "dark") => Promise<void>;
  }
}

const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 800 };

// The theme's `dark` class follows the system's colour scheme, as the
// frontend's apps/web/public/theme.js applies it for someone who chose none.
const darkScheme = matchMedia("(prefers-color-scheme: dark)");
const applyScheme = (): void => {
  document.documentElement.classList.toggle("dark", darkScheme.matches);
};
applyScheme();
darkScheme.addEventListener("change", applyScheme);

const pages: {
  name: string;
  heading: string;
  load: () => Promise<ComponentType>;
}[] = [
  ...Object.entries(demos).map(([name, Demo]) => ({
    name,
    heading: name,
    load: async () => await Promise.resolve(Demo),
  })),
  ...Object.keys(loadExample).map((name) => ({
    name: `example ${name}`,
    heading: name,
    // SAFETY: a key of loadExample.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    load: loadExample[name as ExampleName],
  })),
];

let mounted: Root | undefined;

/** Renders `Content` as the gallery's page does, in the app's providers. */
const render = (heading: string, Content: ComponentType): void => {
  const container = document.createElement("div");
  document.body.append(container);
  mounted = createRoot(container);
  flushSync(() => {
    mounted?.render(
      <StrictMode>
        {/* As the frontend renders: its CSP allows no inline <style>. */}
        <CSPProvider disableStyleElements>
          <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
            <PageHeaderTitle>{heading}</PageHeaderTitle>
            <div data-catalog-content="">
              <Content />
            </div>
          </main>
        </CSPProvider>
      </StrictMode>
    );
  });
};

/**
 * How each demo's overlay opens: from its trigger with a key, on focus (a
 * tooltip), on hover (a preview card) or on right click (a context menu),
 * and what then shows. Each closes with Escape; the ones opened from the
 * keyboard give focus back to their trigger. The command demo is inline,
 * not an overlay, so it isn't here.
 */
interface Overlay {
  trigger: () => Locator;
  open: "Enter" | "ArrowDown" | "focus" | "hover" | "right click";
  opened: () => Locator;
  /** Only there at this width, such as a phone's menu button. */
  viewport?: { width: number; height: number };
}

const openButton = (name: string) => () =>
  page.getByRole("button", { name: `Open ${name}`, exact: true });

const overlayList: Record<string, Overlay> = {
  "alert-dialog": {
    trigger: openButton("alert dialog"),
    open: "Enter",
    opened: () => page.getByRole("alertdialog"),
  },
  combobox: {
    trigger: () => page.getByRole("combobox", { name: "Framework" }),
    open: "ArrowDown",
    opened: () => page.getByRole("listbox"),
  },
  "context-menu": {
    trigger: () => page.getByText("Right-click here"),
    open: "right click",
    opened: () => page.getByRole("menu"),
  },
  dialog: {
    trigger: openButton("dialog"),
    open: "Enter",
    opened: () => page.getByRole("dialog"),
  },
  drawer: {
    trigger: openButton("drawer"),
    open: "Enter",
    opened: () => page.getByRole("dialog"),
  },
  "dropdown-menu": {
    trigger: openButton("dropdown menu"),
    open: "Enter",
    opened: () => page.getByRole("menu"),
  },
  "hover-card": {
    trigger: () => page.getByRole("link", { name: "Maya Jansen" }),
    open: "hover",
    opened: () => page.getByText("Account manager for Benelux."),
  },
  menubar: {
    trigger: () => page.getByRole("menuitem", { name: "File" }),
    open: "Enter",
    opened: () => page.getByRole("menu"),
  },
  "navigation-menu": {
    trigger: openButton("navigation menu"),
    open: "Enter",
    opened: () => page.getByRole("link", { name: "Guides" }),
  },
  popover: {
    trigger: openButton("popover"),
    open: "Enter",
    opened: () => page.getByRole("dialog"),
  },
  select: {
    trigger: () => page.getByRole("combobox", { name: "Model" }),
    open: "Enter",
    opened: () => page.getByRole("listbox"),
  },
  sheet: {
    trigger: openButton("sheet"),
    open: "Enter",
    opened: () => page.getByRole("dialog"),
  },
  tooltip: {
    trigger: openButton("tooltip"),
    open: "focus",
    // Base UI gives the popup no role; it describes the trigger.
    opened: () => page.getByText("Add to the library"),
  },
};

/** A button in the page's own content, not in a popup over it. */
const pageButton = (name: string) => () =>
  page.getByRole("main").getByRole("button", { name, exact: true });

/** Every page's overlays: one per component demo, several on an example. */
const overlays: Record<string, readonly Overlay[]> = {
  ...Object.fromEntries(
    Object.entries(overlayList).map(([name, overlay]) => [name, [overlay]])
  ),
  "example dialog": [
    {
      trigger: pageButton("Rename"),
      open: "Enter",
      opened: () => page.getByRole("dialog"),
    },
    {
      trigger: pageButton("Delete"),
      open: "Enter",
      opened: () => page.getByRole("alertdialog"),
    },
  ],
  "example responsive-navigation": [
    {
      trigger: pageButton("Open the menu"),
      open: "Enter",
      opened: () => page.getByRole("dialog"),
      viewport: phone,
    },
  ],
};

/** The roles of controls, each of which needs a name. */
const namedRoles = [
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "img",
] as const;

const expectNamedControls = async (within: Locator): Promise<void> => {
  for (const role of namedRoles) {
    for (const control of within.getByRole(role).all()) {
      // oxlint-disable-next-line no-await-in-loop -- one control at a time keeps a failure readable
      await expect.element(control).toHaveAccessibleName(/\S/u);
    }
  }
};

const controlCount = (main: Locator): number =>
  namedRoles.reduce(
    (count, role) => count + main.getByRole(role).elements().length,
    0
  );

/**
 * Help and error text under a field is read out with its control: each
 * one's id is in some control's aria-describedby.
 */
const expectConnectedHints = (main: Locator): void => {
  const root = main.element();
  const loose = [
    ...root.querySelectorAll(
      '[data-slot="field-description"], [data-slot="field-error"]'
    ),
  ]
    .filter(
      (hint) =>
        hint.id === "" ||
        root.querySelector(`[aria-describedby~="${hint.id}"]`) === null
    )
    .map((hint) => hint.textContent);
  expect(loose).toStrictEqual([]);
};

// Polled: content that sizes itself to the viewport, such as a chart,
// re-lays out a frame after the viewport changes.
const expectNoSidewaysScroll = async (): Promise<void> => {
  await expect
    .poll(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth
    )
    .toBeLessThanOrEqual(0);
};

/**
 * What an element and its nearest ancestors look like, once their
 * transitions are done. Read with focus and again without, it shows whether
 * focus is visible, wherever the component draws its ring.
 */
const lookOf = async (node: Element): Promise<string> => {
  await Promise.all(
    document
      .getAnimations()
      .filter((animation) => animation instanceof CSSTransition)
      .map(async (animation) => await animation.finished.catch(() => null))
  );
  const looks: string[] = [];
  let current: Element | null = node;
  for (let depth = 0; current !== null && depth < 4; depth += 1) {
    const style = getComputedStyle(current);
    looks.push(
      [
        style.outlineStyle,
        style.outlineColor,
        style.boxShadow,
        style.borderColor,
        style.backgroundColor,
      ].join(" ")
    );
    current = current.parentElement;
  }
  return looks.join(" | ");
};

/** Whether `node` takes text, which shows its focus with the caret, ring or not. */
const takesText = (node: Element): boolean =>
  node instanceof HTMLTextAreaElement ||
  (node instanceof HTMLInputElement &&
    ![
      "button",
      "checkbox",
      "color",
      "file",
      "radio",
      "range",
      "reset",
      "submit",
    ].includes(node.type)) ||
  (node instanceof HTMLElement && node.isContentEditable);

const expectVisibleKeyboardFocus = async (main: Locator): Promise<void> => {
  const root = main.element();
  const focusable = root.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])'
  ).length;
  await userEvent.keyboard("{Tab}");
  const focused = document.activeElement;
  const inside = focused !== null && root.contains(focused);
  // Nothing to focus, nothing focused; something to focus, focus lands in it.
  expect(inside).toBe(focusable > 0);
  if (!inside || takesText(focused)) {
    return;
  }
  const withFocus = await lookOf(focused);
  if (focused instanceof HTMLElement || focused instanceof SVGElement) {
    focused.blur();
  }
  await expect(lookOf(focused)).resolves.not.toBe(withFocus);
};

/** Waits until `locator` shows nothing: gone, or there but not visible. */
const expectHidden = async (locator: Locator): Promise<void> => {
  await expect
    .poll(() => locator.query()?.checkVisibility() ?? false)
    .toBe(false);
};

const openOverlay = async (
  trigger: Locator,
  open: Overlay["open"]
): Promise<void> => {
  if (open === "hover") {
    await userEvent.hover(trigger);
  } else if (open === "right click") {
    await userEvent.click(trigger, { button: "right" });
  } else {
    const element = trigger.element();
    if (element instanceof HTMLElement) {
      element.focus();
    }
    if (open === "focus") {
      // Focus from the keyboard, which is what opens a tooltip: away and back.
      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
      await userEvent.keyboard("{Tab}");
    } else {
      await userEvent.keyboard(`{${open}}`);
    }
  }
};

const expectOverlayOpensAndCloses = async (overlay: Overlay): Promise<void> => {
  if (overlay.viewport !== undefined) {
    await page.viewport(overlay.viewport.width, overlay.viewport.height);
  }
  const trigger = overlay.trigger();
  await openOverlay(trigger, overlay.open);
  const opened = overlay.opened();
  await expect.element(opened).toBeVisible();
  await expectNamedControls(opened);
  await userEvent.keyboard("{Escape}");
  await expectHidden(opened);
  // Opened from the keyboard, focus goes back where it was.
  if (overlay.open !== "hover" && overlay.open !== "right click") {
    await expect.element(trigger).toHaveFocus();
  }
  if (overlay.viewport !== undefined) {
    await page.viewport(desktop.width, desktop.height);
  }
};

/** Focuses `locator`'s element, as a person's Tab would reach it. */
const focus = (locator: Locator): void => {
  const element = locator.element();
  if (element instanceof HTMLElement) {
    element.focus();
  }
};

/**
 * Once an item is picked up from the keyboard, the arrows move it: dnd-kit
 * listens for them a task after the pick-up, which a person never beats
 * but a test's next key can.
 */
const pickedUp = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  requestAnimationFrame(() => {
    setTimeout(() => {
      resolve(true);
    }, 0);
  });
  await promise;
};

/** A line said to screen readers, as the page shows it. */
const said = (text: string): Locator => page.getByText(text, { exact: true });

/** Keyboard behaviour particular to a component, checked on its page. */
const keyboardChecks: Record<string, () => Promise<void>> = {
  // An item moves from the keyboard, each step said to screen readers:
  // Space picks it up, an arrow moves it, Space puts it down; Escape puts
  // it back.
  "sortable-list": async () => {
    const options = page.getByRole("list", { name: "Options" });
    const second = options.getByRole("listitem").nth(1);
    focus(options.getByRole("button", { name: "Move Done" }));
    await userEvent.keyboard(" ");
    await expect.element(said("Done is now at place 3.")).toBeInTheDocument();
    await pickedUp();
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(said("Done is now at place 2.")).toBeInTheDocument();
    await userEvent.keyboard(" ");
    await expect.element(said("Put Done down at place 2.")).toBeInTheDocument();
    await expect
      .element(second.getByRole("textbox"))
      .toHaveAccessibleName("Done");

    focus(options.getByRole("button", { name: "Move Open" }));
    await userEvent.keyboard(" ");
    await expect.element(said("Open is now at place 1.")).toBeInTheDocument();
    await pickedUp();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(said("Open is now at place 2.")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(said("Put Open back where it was."))
      .toBeInTheDocument();
    await expect
      .element(second.getByRole("textbox"))
      .toHaveAccessibleName("Done");
  },
  // A vertical group moves with the up and down arrows, which only works
  // when the orientation reaches Base UI, not just the styles.
  "toggle-group": async () => {
    const alignment = page.getByRole("group", { name: "Alignment" });
    focus(alignment.getByRole("button", { name: "Left" }));
    await userEvent.keyboard("{ArrowDown}");
    await expect
      .element(alignment.getByRole("button", { name: "Center" }))
      .toHaveFocus();
  },
  // Arrow keys in a field inside a slide move the cursor, not the slide;
  // a vertical carousel moves with ArrowDown.
  carousel: async () => {
    const note = page.getByRole("textbox", { name: "First slide note" });
    focus(note);
    await userEvent.keyboard("{End}");
    await userEvent.keyboard("{ArrowLeft}");
    const input = note.element();
    expect(input instanceof HTMLInputElement && input.selectionStart).toBe(3);
    await expect
      .element(page.getByRole("button", { name: "Previous slide" }))
      .toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: "Next slide" }))
      .toBeEnabled();

    focus(page.getByRole("button", { name: "Next card" }));
    await userEvent.keyboard("{ArrowDown}");
    await expect
      .element(page.getByRole("button", { name: "Previous card" }))
      .toBeEnabled();
  },
  // A single value is one thumb.
  slider: async () => {
    await expect
      .poll(() => page.getByRole("main").getByRole("slider").elements().length)
      .toBe(1);
  },
};

const bodyBackground = (): string =>
  getComputedStyle(document.body).backgroundColor;

describe("the UI kit", () => {
  afterEach(async () => {
    mounted?.unmount();
    mounted = undefined;
    document.body.replaceChildren();
    await commands.colorScheme("light");
  });

  it.each(pages.map((shown) => [shown.name, shown] as const))(
    "%s is accessible in light and dark, on a phone and a desktop",
    async (name, { heading, load }) => {
      await commands.colorScheme("light");
      await page.viewport(phone.width, phone.height);
      render(heading, await load());
      const main = page.getByRole("main");
      await expect
        .element(
          main.getByRole("heading", { level: 1, name: heading, exact: true })
        )
        .toBeVisible();
      // The demo or example itself, which on an example page loads after
      // the heading: every check below reads it.
      await expect
        .poll(
          () =>
            main
              .element()
              .querySelector("[data-catalog-content]")
              ?.checkVisibility() ?? false
        )
        .toBe(true);
      // An example composes controls; a component's demo may show none.
      expect(
        controlCount(main) > 0 || !name.startsWith("example ")
      ).toBeTruthy();
      await expectNoSidewaysScroll();
      await expectNamedControls(main);
      expectConnectedHints(main);

      await page.viewport(desktop.width, desktop.height);
      await expectNoSidewaysScroll();
      await expectVisibleKeyboardFocus(main);
      for (const overlay of overlays[name] ?? []) {
        // oxlint-disable-next-line no-await-in-loop -- one overlay open at a time
        await expectOverlayOpensAndCloses(overlay);
      }
      await keyboardChecks[name]?.();

      const light = bodyBackground();
      await commands.colorScheme("dark");
      await expect.poll(bodyBackground).not.toBe(light);
      await expectNamedControls(main);
      await page.viewport(phone.width, phone.height);
      await expectNoSidewaysScroll();
    }
  );
});
