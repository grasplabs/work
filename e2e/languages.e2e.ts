import { expect } from "@playwright/test";
import type { Locator } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn } from "./people.ts";

// The product speaks the browser's language until the person picks one,
// and keeps their pick in this browser. Every catalog having every message
// is a unit test (apps/web/src/locales/locales.test.ts).

test("follows the browser's language, then the one the person picks", async ({
  pageOf,
}) => {
  const { member } = peopleIn("languages");
  const page = await pageOf(member, { locale: "de-DE" });

  await page.goto("/projects");
  const nav = page.getByRole("navigation", { name: "Hauptmenü" });
  await expect(nav.getByRole("link", { name: "Gehirn" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "de");

  // The language is in Settings › Profile, which the person menu's
  // Settings opens.
  await page.getByRole("button", { name: "Person", exact: true }).click();
  await page.getByRole("menuitem", { name: "Einstellungen" }).click();
  await expect(page).toHaveURL(/\/settings\/profile$/u);
  await page.getByRole("combobox", { name: "Sprache" }).click();
  await page.getByRole("option", { name: "Nederlands" }).click();
  await expect(page.getByRole("heading", { name: "Profiel" })).toBeVisible();

  // Kept for this browser, over its own language.
  await page.goto("/projects");
  await expect(
    page.getByRole("navigation", { name: "Hoofdmenu" }).getByRole("link", {
      name: "Brein",
    })
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Projecten", exact: true })
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");

  // And back, in the same place.
  await page.getByRole("button", { name: "Person", exact: true }).click();
  await page.getByRole("menuitem", { name: "Instellingen" }).click();
  await expect(page).toHaveURL(/\/settings\/profile$/u);
  await page.getByRole("combobox", { name: "Taal" }).click();
  await page.getByRole("option", { name: "English" }).click();
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

/** Presses `option` where it stands, once it is seen whole in a window 390px across. */
const chosen = async (option: Locator): Promise<void> => {
  await expect(option).toBeVisible();
  const box = await option.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  await option.click();
};

test("on a phone the person menu holds the themes and the organizations, each within the window", async ({
  pageOf,
}) => {
  const { member } = peopleIn("languages");
  const page = await pageOf(member, {
    viewport: { width: 390, height: 844 },
  });
  await page.goto("/projects");
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true })
  ).toBeVisible({ timeout: 20_000 });
  const menu = page.getByRole("menu");
  /** The person menu, from the sidebar's sheet. */
  const opened = async () => {
    if (await menu.isVisible()) {
      return;
    }
    const sheet = page.getByRole("dialog", { name: "Sidebar" });
    if (!(await sheet.isVisible())) {
      await page
        .getByRole("main")
        .getByRole("button", { name: "Show or hide the sidebar" })
        .click();
    }
    await sheet.getByRole("button", { name: "Person", exact: true }).click();
  };

  // The themes on Appearance's own row, the organizations in a submenu,
  // none of them off the window's edge.
  await opened();
  await chosen(menu.getByRole("menuitemradio", { name: "Dark" }));
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await opened();
  await expect(
    menu.getByRole("menuitemradio", { name: "Dark" })
  ).toHaveAttribute("aria-checked", "true");
  await page
    .getByRole("menuitem", { name: "Switch organization", exact: true })
    .click();
  // The organization the person is in, chosen.
  const organization = page.getByRole("menuitemradio").last();
  await expect(organization).toHaveAttribute("aria-checked", "true");
  await chosen(organization);
});

test("on a phone the person menu opens at its top, however soon the person is pressed after the sheet opens", async ({
  pageOf,
}) => {
  const { member } = peopleIn("languages");
  const page = await pageOf(member, {
    viewport: { width: 390, height: 844 },
  });
  await page.goto("/projects");
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true })
  ).toBeVisible({ timeout: 20_000 });
  const sheet = page.getByRole("dialog", { name: "Sidebar" });
  const menu = page.getByRole("menu");
  // Every scroll in the menu, counted on the root from each opening on.
  const root = page.locator("html");
  await page.evaluate(() => {
    document.addEventListener(
      "scroll",
      (event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('[role="menu"]') !== null
        ) {
          const { dataset } = document.documentElement;
          dataset.menuScrolls = String(Number(dataset.menuScrolls ?? 0) + 1);
        }
      },
      { capture: true }
    );
  });
  /** The next frame, painted. */
  const painted = async (): Promise<void> => {
    await page.evaluate(async () => {
      const { promise, resolve } = Promise.withResolvers<boolean>();
      requestAnimationFrame(() => {
        resolve(true);
      });
      await promise;
    });
  };
  // Twenty times, one after another.
  for (let time = 1; time <= 20; time += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one opening at a time
    await root.evaluate((element) => {
      element.dataset.menuScrolls = "0";
    });
    // oxlint-disable-next-line no-await-in-loop -- as above
    await page
      .getByRole("main")
      .getByRole("button", { name: "Show or hide the sidebar" })
      .click();
    // The person, pressed as soon as they are whole in the window, while
    // the sheet still slides in.
    let box = null;
    while (box === null || box.x < 0) {
      // oxlint-disable-next-line no-await-in-loop -- frame by frame
      await painted();
      // oxlint-disable-next-line no-await-in-loop -- as above
      box = await sheet
        .getByRole("button", { name: "Person", exact: true })
        .boundingBox({ timeout: 1000 })
        .catch(() => null);
    }
    // oxlint-disable-next-line no-await-in-loop -- as above
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    // oxlint-disable-next-line no-await-in-loop -- as above
    await expect(menu).toBeVisible();
    // Once the sheet has come to rest, and what it does then is done,
    // nothing in the menu has scrolled: the person's name stands whole.
    // oxlint-disable-next-line no-await-in-loop -- as above
    await sheet.evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .map(async (each) => await each.finished.catch(() => null))
      );
    });
    for (let frame = 0; frame < 3; frame += 1) {
      // oxlint-disable-next-line no-await-in-loop -- frame by frame
      await painted();
    }
    // oxlint-disable-next-line no-await-in-loop -- as above
    const scrolled = await menu.evaluate((element) => ({
      events: Number(document.documentElement.dataset.menuScrolls),
      tops: [element, ...element.querySelectorAll("*")]
        .map((each) => each.scrollTop)
        .filter((top) => top !== 0),
    }));
    expect(scrolled, `opening ${time}`).toEqual({ events: 0, tops: [] });
    // oxlint-disable-next-line no-await-in-loop -- as above
    await page.keyboard.press("Escape");
    // oxlint-disable-next-line no-await-in-loop -- as above
    await expect(menu).toBeHidden();
    // oxlint-disable-next-line no-await-in-loop -- as above
    await page.keyboard.press("Escape");
    // oxlint-disable-next-line no-await-in-loop -- as above
    await expect(sheet).toBeHidden();
  }
});

test("signing in speaks the browser's language", async ({ newContext }) => {
  const context = await newContext({ locale: "fr-FR" });
  const page = await context.newPage();
  await page.goto("/sign-in");
  await expect(
    page.getByRole("heading", { level: 1, name: "Se connecter" })
  ).toBeVisible();
});
