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
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByRole("link", {
      name: "Projects",
    })
  ).toHaveAttribute("aria-current", "page");

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

test("opened from the page's bar, the sidebar takes the focus to its own fold", async ({
  pageOf,
}) => {
  const { member } = peopleIn("frame");
  const page = await pageOf(member);
  await page.setViewportSize(wide);
  await page.goto("/projects");
  const fold = foldOf(page);
  await fold.click();
  await expect(page.locator('aside[data-slot="sidebar"]')).toHaveAttribute(
    "data-state",
    "collapsed"
  );
  // Well past its slide out, so the sidebar is hidden as the bar opens it.
  await page.waitForTimeout(1000);
  const reopen = page
    .getByRole("main")
    .getByRole("button", { name: "Show or hide the sidebar" });
  await reopen.focus();
  await page.keyboard.press("Enter");
  await expect(reopen).toHaveCount(0);
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
