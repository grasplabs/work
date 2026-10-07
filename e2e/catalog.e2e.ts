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
 * The overlays the demos open from a trigger named "Open <component>", the
 * key that opens each, and the role of what opens.
 */
interface Overlay {
  key: string;
  role: "dialog" | "alertdialog" | "menu" | "listbox";
}

const overlays: Record<string, Overlay> = {
  "alert-dialog": { key: "Enter", role: "alertdialog" },
  dialog: { key: "Enter", role: "dialog" },
  drawer: { key: "Enter", role: "dialog" },
  "dropdown-menu": { key: "Enter", role: "menu" },
  popover: { key: "Enter", role: "dialog" },
  sheet: { key: "Enter", role: "dialog" },
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

const expectOverlayFromKeyboard = async (
  page: Page,
  name: string,
  overlay: Overlay
): Promise<void> => {
  const trigger = page.getByRole("button", {
    name: `Open ${name.replaceAll("-", " ")}`,
  });
  await trigger.focus();
  await page.keyboard.press(overlay.key);
  const opened = page.getByRole(overlay.role);
  await expect(opened).toBeVisible();
  await expectNamedControls(opened);
  await page.keyboard.press("Escape");
  await expect(opened).toBeHidden();
  await expect(trigger).toBeFocused();
};

/**
 * What the app's policy (style-src 'self') may block on a page, and only
 * there. input-otp adds an empty `<style>` element and fills it through
 * CSSOM; the policy blocks the element, and the kit's stylesheet carries
 * its rules instead (styles.css). Screens allow inline styles, so there it
 * works as upstream.
 */
const knownViolations: Record<string, RegExp> = {
  "input-otp":
    /^style-src-elem blocked inline at |'sha256-47DEQpj8HBSa\+\/TImW\+5JCeuQeRkm5NMpJWZG3hSuFU='/u,
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
      await expectOverlayFromKeyboard(page, name, overlay);
    }

    const light = await bodyBackground(page);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(async () => await bodyBackground(page)).not.toBe(light);
    await expectNamedControls(main);
    await page.setViewportSize(phone);
    await expectNoSidewaysScroll(page);

    const known = knownViolations[name];
    expect(
      violations.filter((violation) => known?.test(violation) !== true)
    ).toStrictEqual([]);
  });
}
