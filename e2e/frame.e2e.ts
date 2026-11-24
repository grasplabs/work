import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn } from "./people.ts";

// The frame on its own: the sidebar's levels and the way out of them, its
// fold kept across a reload, the way focus goes when it opens from the
// page's bar, and the phone's sheet.

const wide = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };

/**
 * The fold in the sidebar's head: its first button of that name (the rail
 * along its edge says the same, for a pointer).
 */
const foldOf = (page: Page) =>
  page
    .getByRole("complementary", { name: "Sidebar" })
    .getByRole("button", { name: "Show or hide the sidebar" })
    .first();

/** The sidebar, beside the page or in its sheet. */
const sidebarOf = (page: Page) =>
  page
    .getByRole("complementary", { name: "Sidebar" })
    .or(page.getByRole("dialog", { name: "Sidebar" }));

test("Back in Settings' level leads to the last page outside it, and to Chat after a link straight into Settings", async ({
  pageOf,
}) => {
  const { member } = peopleIn("frame");
  const page = await pageOf(member);
  await page.setViewportSize(wide);
  await page.goto("/projects");
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "Person", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const settings = page.getByRole("navigation", { name: "Settings" });
  await settings.getByRole("link", { name: "Security" }).click();
  await expect(page).toHaveURL(/\/settings\/security$/u);
  await sidebarOf(page).getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/projects$/u);
  // The main level again, which has no Projects row (as the reference):
  // Back leads to a page the sidebar lists nowhere all the same.
  const main = page.getByRole("navigation", { name: "Main" });
  await expect(main.getByRole("link", { name: "Chat" })).toBeVisible();
  await expect(main.getByRole("link", { name: "Projects" })).toHaveCount(0);

  // The same page with only its query changed, in the page (as a Brain
  // folder is opened), is the place to go back to.
  await page.goto("/brain?group=one");
  await page.evaluate(() => {
    history.pushState({}, "", "/brain?group=two");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveURL(/\/brain\?group=two$/u);
  await page.getByRole("button", { name: "Person", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings/u);
  await sidebarOf(page).getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/brain\?group=two$/u);

  // Straight into Settings, and the page read again: nothing to go back to
  // but Chat.
  await page.goto("/settings/profile");
  await page.reload();
  await sidebarOf(page).getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/$/u);
});

test("a folded sidebar stays folded across a reload, never drawn open first", async ({
  pageOf,
}) => {
  const { member } = peopleIn("frame");
  const page = await pageOf(member);
  await page.setViewportSize(wide);
  await page.goto("/projects");
  const sidebar = page.locator('aside[data-slot="sidebar"]');
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await foldOf(page).click();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");

  // Every state the sidebar is drawn in while the page loads again, kept
  // on the page's root as it goes.
  await page.addInitScript(() => {
    // The root is there once the page is parsed, not yet as this runs.
    new MutationObserver(() => {
      const root = document.documentElement;
      for (const aside of document.querySelectorAll<HTMLElement>(
        'aside[data-slot="sidebar"]'
      )) {
        root.dataset.sidebarStates = `${root.dataset.sidebarStates ?? ""} ${aside.dataset.state ?? ""}`;
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true })
  ).toBeVisible();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  const seen = await page.locator("html").getAttribute("data-sidebar-states");
  const states = (seen ?? "").split(" ").filter((state) => state !== "");
  expect(states.length).toBeGreaterThan(0);
  expect(new Set(states)).toStrictEqual(new Set(["collapsed"]));
});

test("opened from the page's bar, by its button or the shortcut while it has focus, the sidebar takes the focus to its own fold, its slide cut short or not", async ({
  pageOf,
}) => {
  const { member } = peopleIn("frame");
  const page = await pageOf(member);
  await page.setViewportSize(wide);
  await page.goto("/projects");
  const fold = foldOf(page);
  const reopen = page
    .getByRole("main")
    .getByRole("button", { name: "Show or hide the sidebar" });
  const folded = async () => {
    await fold.click();
    await expect(page.locator('aside[data-slot="sidebar"]')).toHaveAttribute(
      "data-state",
      "collapsed"
    );
    // Well past its slide out, so the sidebar is hidden as the bar opens it.
    await page.waitForTimeout(1000);
  };

  await folded();
  await reopen.focus();
  await page.keyboard.press("Enter");
  await expect(reopen).toHaveCount(0);
  await expect(fold).toBeFocused();

  // The shortcut, while the bar's button has focus: the button goes too.
  await folded();
  await reopen.focus();
  await page.keyboard.press("ControlOrMeta+b");
  await expect(reopen).toHaveCount(0);
  await expect(fold).toBeFocused();

  // Its slide in cut off on the way, though it stays open.
  await folded();
  await reopen.click();
  await page.evaluate(() => {
    const sliding = document.querySelector('[data-slot="sidebar-container"]');
    for (const animation of sliding?.getAnimations() ?? []) {
      animation.cancel();
    }
  });
  await expect(fold).toBeFocused();
});

test("on a phone the sidebar is a sheet, which closes on its button and as the person goes somewhere", async ({
  pageOf,
}) => {
  const { member } = peopleIn("frame");
  const page = await pageOf(member);
  await page.setViewportSize(phone);
  await page.goto("/projects");
  const sheet = page.getByRole("dialog", { name: "Sidebar" });
  const open = page
    .getByRole("main")
    .getByRole("button", { name: "Show or hide the sidebar" });

  await open.click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toBeHidden();

  await open.click();
  await sheet
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Apps" })
    .click();
  await expect(page).toHaveURL(/\/apps$/u);
  await expect(sheet).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Apps", exact: true })
  ).toBeVisible();
});

test("on a phone Back in Settings leads to the last page outside it, though the sheet closed between", async ({
  pageOf,
}) => {
  const { member } = peopleIn("frame");
  const page = await pageOf(member);
  await page.setViewportSize(phone);
  await page.goto("/projects");
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true })
  ).toBeVisible();
  const sheet = page.getByRole("dialog", { name: "Sidebar" });
  const open = page
    .getByRole("main")
    .getByRole("button", { name: "Show or hide the sidebar" });
  await open.click();
  await sheet.getByRole("button", { name: "Person", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings/u);
  await expect(sheet).toBeHidden();

  await open.click();
  await sheet.getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/projects$/u);
});

/**
 * The colours `colours` (CSS, such as `var(--muted)`) paint on the page's
 * card, each laid over what lies under it as the browser paints it (a
 * translucent colour shows its ground through), as sRGB from 0 to 255,
 * with that ground, the card's.
 */
const paintedOnCard = async (
  page: Page,
  colours: readonly string[]
): Promise<{ ground: number[]; painted: Record<string, number[]> }> =>
  await page.evaluate((names) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) {
      throw new Error("No 2D canvas to read a colour");
    }
    /** `colour` laid over `under`, as sRGB. */
    const laidOver = (colour: string, under: number[]): number[] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = colour;
      context.fillRect(0, 0, 1, 1);
      const [red = 0, green = 0, blue = 0, opacity = 255] =
        context.getImageData(0, 0, 1, 1).data;
      const alpha = opacity / 255;
      return [red, green, blue].map(
        (channel, index) => channel * alpha + (under[index] ?? 0) * (1 - alpha)
      );
    };
    const card = document.querySelector('[data-slot="app-shell-page"]');
    if (card === null) {
      throw new Error("No page card");
    }
    // The card's ground: every fill from the window up to it, in turn.
    const fills: string[] = [];
    for (
      let element: Element | null = card;
      element !== null;
      element = element.parentElement
    ) {
      fills.unshift(getComputedStyle(element).backgroundColor);
    }
    let ground = [255, 255, 255];
    for (const fill of fills) {
      ground = laidOver(fill, ground);
    }
    const painted: Record<string, number[]> = {};
    for (const name of names) {
      const probe = document.createElement("div");
      probe.style.backgroundColor = name;
      card.append(probe);
      painted[name] = laidOver(getComputedStyle(probe).backgroundColor, ground);
      probe.remove();
    }
    return { ground, painted };
  }, colours);

/** The relative luminance of an sRGB colour, as WCAG reckons it. */
const luminance = (colour: number[]): number => {
  const [red = 0, green = 0, blue = 0] = colour.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};

/** The contrast ratio of two sRGB colours, as WCAG reckons it. */
const contrast = (one: number[], other: number[]): number => {
  const [lighter = 0, darker = 0] = [luminance(one), luminance(other)].toSorted(
    (a, b) => b - a
  );
  return (lighter + 0.05) / (darker + 0.05);
};

test("in dark, the kit's muted fill is opaque and stands out from the page's card as much as it did from the kit's own page", async ({
  pageOf,
}) => {
  const { member } = peopleIn("frame");
  const page = await pageOf(member);
  await page.setViewportSize(wide);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/projects");
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true })
  ).toBeVisible();
  const { ground, painted } = await paintedOnCard(page, ["var(--muted)"]);
  // Opaque, as the kit's own: nothing under it shows through, such as the
  // rows under a sticky header row.
  const opacity = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--muted)";
    document.body.append(probe);
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) {
      throw new Error("No 2D canvas to read a colour");
    }
    context.fillStyle = getComputedStyle(probe).backgroundColor;
    probe.remove();
    context.fillRect(0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3];
  });
  expect(opacity).toBe(255);
  // The kit's own dark muted (#1b2a24) on its own dark page (#0d1714),
  // as the app had them before its frame moved onto Damsko.
  expect(contrast([0x1b, 0x2a, 0x24], [0x0d, 0x17, 0x14])).toBeCloseTo(1.22, 2);
  expect(
    contrast(painted["var(--muted)"] ?? [], ground)
  ).toBeGreaterThanOrEqual(1.22);
});

test("a page printed from dark is dark ink on light paper, the kit's colours and Damsko's", async ({
  pageOf,
}) => {
  const { member } = peopleIn("frame");
  const page = await pageOf(member);
  await page.setViewportSize(wide);
  await page.goto("/projects");
  const heading = page.getByRole("heading", { name: "Projects", exact: true });
  await expect(heading).toBeVisible();
  // Dark, chosen in the person menu.
  await page.getByRole("button", { name: "Person", exact: true }).click();
  await page
    .getByRole("menu")
    .getByRole("button", { name: "Dark", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");

  // How each ink stands on white paper: the page's own title, and the
  // kit's and Damsko's, as they are painted now.
  const onPaper = async (): Promise<number[]> => {
    const title = await heading.evaluate(
      (element) => getComputedStyle(element).color
    );
    const { painted } = await paintedOnCard(page, [
      title,
      "var(--foreground)",
      "var(--muted-foreground)",
      "var(--damsko-foreground)",
    ]);
    return Object.values(painted).map((ink) => contrast(ink, [255, 255, 255]));
  };
  // Light ink on screen, which on paper would be all but gone…
  expect(await onPaper()).toHaveLength(4);
  await expect.poll(async () => Math.max(...(await onPaper()))).toBeLessThan(3);
  // …dark ink in print, as on a light page, once what moves has settled.
  await page.emulateMedia({ media: "print" });
  await expect
    .poll(async () => Math.min(...(await onPaper())))
    .toBeGreaterThan(4.5);
});
