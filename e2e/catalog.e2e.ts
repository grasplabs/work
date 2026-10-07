import { expect, test } from "@playwright/test";
import type { ElementHandle, Locator, Page } from "@playwright/test";

import {
  examples,
  graspComponents,
  shadcnComponents,
} from "../packages/ui/catalog/inventory.ts";
import { recordCspViolations } from "./csp.ts";

// Every component in the UI kit, and every example for agents, on its own
// page of the local gallery (apps/web/src/routes/kit_.*): each has names for
// its controls, a visible focus from the keyboard, no sideways scroll on a
// phone, overlays that open from the keyboard and close with Escape, and a
// dark theme. The list comes from the kit's inventory, so a component added
// to the kit is checked without touching this file.

// A trace of every failing page, kept as the run's artifact.
test.use({ trace: "retain-on-failure" });

const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 800 };

const supportedShadcn = Object.entries(shadcnComponents).flatMap(
  ([name, entry]) => (entry.status === "supported" ? [name] : [])
);
const pages = [
  ...[...supportedShadcn, ...Object.keys(graspComponents)].map((name) => ({
    name,
    heading: name,
    path: `/kit/components/${name}`,
  })),
  ...Object.keys(examples).map((name) => ({
    name: `example ${name}`,
    heading: name,
    path: `/kit/examples/${name}`,
  })),
];

/**
 * How each demo's overlay opens: from its trigger with a key, on focus (a
 * tooltip), on hover (a preview card) or on right click (a context menu),
 * and what then shows. Each closes with Escape; the ones opened from the
 * keyboard give focus back to their trigger. The command demo is inline,
 * not an overlay, so it isn't here.
 */
interface Overlay {
  trigger: (page: Page) => Locator;
  open: "Enter" | "ArrowDown" | "focus" | "hover" | "right click";
  opened: (page: Page) => Locator;
}

const openButton = (name: string) => (page: Page) =>
  page.getByRole("button", { name: `Open ${name}`, exact: true });

const overlays: Record<string, Overlay> = {
  "alert-dialog": {
    trigger: openButton("alert dialog"),
    open: "Enter",
    opened: (page) => page.getByRole("alertdialog"),
  },
  combobox: {
    trigger: (page) => page.getByRole("combobox", { name: "Framework" }),
    open: "ArrowDown",
    opened: (page) => page.getByRole("listbox"),
  },
  "context-menu": {
    trigger: (page) => page.getByText("Right-click here"),
    open: "right click",
    opened: (page) => page.getByRole("menu"),
  },
  dialog: {
    trigger: openButton("dialog"),
    open: "Enter",
    opened: (page) => page.getByRole("dialog"),
  },
  drawer: {
    trigger: openButton("drawer"),
    open: "Enter",
    opened: (page) => page.getByRole("dialog"),
  },
  "dropdown-menu": {
    trigger: openButton("dropdown menu"),
    open: "Enter",
    opened: (page) => page.getByRole("menu"),
  },
  "hover-card": {
    trigger: (page) => page.getByRole("link", { name: "Maya Jansen" }),
    open: "hover",
    opened: (page) => page.getByText("Account manager for Benelux."),
  },
  menubar: {
    trigger: (page) => page.getByRole("menuitem", { name: "File" }),
    open: "Enter",
    opened: (page) => page.getByRole("menu"),
  },
  "navigation-menu": {
    trigger: openButton("navigation menu"),
    open: "Enter",
    opened: (page) => page.getByRole("link", { name: "Guides" }),
  },
  popover: {
    trigger: openButton("popover"),
    open: "Enter",
    opened: (page) => page.getByRole("dialog"),
  },
  select: {
    trigger: (page) => page.getByRole("combobox", { name: "Model" }),
    open: "Enter",
    opened: (page) => page.getByRole("listbox"),
  },
  sheet: {
    trigger: openButton("sheet"),
    open: "Enter",
    opened: (page) => page.getByRole("dialog"),
  },
  tooltip: {
    trigger: openButton("tooltip"),
    open: "focus",
    // Base UI gives the popup no role; it describes the trigger.
    opened: (page) => page.getByText("Add to the library"),
  },
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

const expectNamedControls = async (main: Locator): Promise<void> => {
  for (const role of namedRoles) {
    // oxlint-disable-next-line no-await-in-loop -- one role at a time keeps a failure readable
    for (const control of await main.getByRole(role).all()) {
      // oxlint-disable-next-line no-await-in-loop -- as above
      await expect(control).toHaveAccessibleName(/\S/u);
    }
  }
};

// Polled: content that sizes itself to the viewport, such as a chart,
// re-lays out a frame after the viewport changes.
const expectNoSidewaysScroll = async (page: Page): Promise<void> => {
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth
        )
    )
    .toBeLessThanOrEqual(0);
};

/**
 * What an element and its nearest ancestors look like, once their
 * transitions are done. Read with focus and again without, it shows whether
 * focus is visible, wherever the component draws its ring.
 */
const lookOf = async (element: ElementHandle): Promise<string> =>
  await element.evaluate(async (node) => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map(async (animation) => await animation.finished.catch(() => null))
    );
    const looks: string[] = [];
    let current: Element | null = node instanceof Element ? node : null;
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
  });

const expectVisibleKeyboardFocus = async (
  page: Page,
  main: Locator
): Promise<void> => {
  const focusable = await main.evaluate(
    (root) =>
      root.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])'
      ).length
  );
  await page.keyboard.press("Tab");
  const inside = await main.evaluate((root) =>
    root.contains(document.activeElement)
  );
  // Nothing to focus, nothing focused; something to focus, focus lands in it.
  expect(inside).toBe(focusable > 0);
  const focused = await page.evaluateHandle(() => document.activeElement);
  const element = focused.asElement();
  if (!inside || element === null) {
    return;
  }
  // A text field shows its focus with the caret, ring or not.
  const takesText = await element.evaluate(
    (node) =>
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
      (node instanceof HTMLElement && node.isContentEditable)
  );
  if (takesText) {
    return;
  }
  const withFocus = await lookOf(element);
  await element.evaluate((node) => {
    if (node instanceof HTMLElement || node instanceof SVGElement) {
      node.blur();
    }
  });
  expect(await lookOf(element)).not.toBe(withFocus);
};

const openOverlay = async (
  page: Page,
  trigger: Locator,
  open: Overlay["open"]
): Promise<void> => {
  if (open === "hover") {
    await trigger.hover();
  } else if (open === "right click") {
    await trigger.click({ button: "right" });
  } else {
    await trigger.focus();
    if (open === "focus") {
      // Focus from the keyboard, which is what opens a tooltip: away and back.
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
    } else {
      await page.keyboard.press(open);
    }
  }
};

const expectOverlayOpensAndCloses = async (
  page: Page,
  overlay: Overlay
): Promise<void> => {
  const trigger = overlay.trigger(page);
  await openOverlay(page, trigger, overlay.open);
  const opened = overlay.opened(page);
  await expect(opened).toBeVisible();
  await expectNamedControls(opened);
  await page.keyboard.press("Escape");
  await expect(opened).toBeHidden();
  // Opened from the keyboard, focus goes back where it was.
  if (overlay.open !== "hover" && overlay.open !== "right click") {
    await expect(trigger).toBeFocused();
  }
};

/**
 * What the app's policy (style-src 'self') may block on a page, and only
 * there. input-otp adds an empty `<style>` element and fills it through
 * CSSOM; the policy blocks the element, and the kit's stylesheet carries
 * its rules instead (styles.css). Screens allow inline styles, so there it
 * works as upstream.
 */
const knownViolations: Record<string, readonly RegExp[]> = {
  // Exactly the one empty element: the event for it, and the console's
  // report with the hash of the empty string.
  "input-otp": [
    /^style-src-elem blocked inline at http:\/\/localhost:\d+\/assets\/[\w.-]+\.js:\d+:\d+$/u,
    /^Applying inline style violates the following Content Security Policy directive 'style-src 'self''\. Either the 'unsafe-inline' keyword, a hash \('sha256-47DEQpj8HBSa\+\/TImW\+5JCeuQeRkm5NMpJWZG3hSuFU='\), or a nonce \('nonce-\.\.\.'\) is required to enable inline execution\. The action has been blocked\.$/u,
  ],
};

/** The violations left once each known one is matched once, in order. */
const unexpectedViolations = (
  violations: readonly string[],
  known: readonly RegExp[]
): string[] => {
  const left = [...known];
  return violations.filter((violation) => {
    const at = left.findIndex((pattern) => pattern.test(violation));
    if (at === -1) {
      return true;
    }
    left.splice(at, 1);
    return false;
  });
};

/** Keyboard behaviour particular to a component, checked on its page. */
const keyboardChecks: Record<string, (page: Page) => Promise<void>> = {
  // A vertical group moves with the up and down arrows, which only works
  // when the orientation reaches Base UI, not just the styles.
  "toggle-group": async (page) => {
    const alignment = page.getByRole("group", { name: "Alignment" });
    await alignment.getByRole("button", { name: "Left" }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(
      alignment.getByRole("button", { name: "Center" })
    ).toBeFocused();
  },
  // A single value is one thumb.
  slider: async (page) => {
    await expect(page.getByRole("main").getByRole("slider")).toHaveCount(1);
  },
};

const bodyBackground = async (page: Page): Promise<string> =>
  await page
    .locator("body")
    .evaluate((body) => getComputedStyle(body).backgroundColor);

for (const { name, heading, path } of pages) {
  test(`${name} is accessible in light and dark, on a phone and a desktop`, async ({
    page,
  }) => {
    const violations = await recordCspViolations(page);
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize(phone);
    await page.goto(path);
    const main = page.getByRole("main");
    await expect(
      main.getByRole("heading", { level: 1, name: heading, exact: true })
    ).toBeVisible();
    await expectNoSidewaysScroll(page);
    await expectNamedControls(main);

    await page.setViewportSize(desktop);
    await expectNoSidewaysScroll(page);
    await expectVisibleKeyboardFocus(page, main);
    const overlay = overlays[name];
    if (overlay !== undefined) {
      await expectOverlayOpensAndCloses(page, overlay);
    }
    await keyboardChecks[name]?.(page);

    const light = await bodyBackground(page);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(async () => await bodyBackground(page)).not.toBe(light);
    await expectNamedControls(main);
    await page.setViewportSize(phone);
    await expectNoSidewaysScroll(page);

    expect(
      unexpectedViolations(violations, knownViolations[name] ?? [])
    ).toStrictEqual([]);
  });
}
