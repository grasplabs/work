import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";

// The Brain, end to end: a person opens it from the sidebar on its atlas,
// goes into a part of it there and opens a note, and finds the note on the
// atlas again; and opens a region from the brain's navigation and the
// note in it there. Every deployment's brain has its board in front, with its
// Vision, whatever core holds yet, so that is the way in. What the brain is built from is
// core's test (apps/core/test/brain.test.ts); how it is built, and laid out
// as an atlas, the brain's own (apps/web/src/brain/*.test.ts).

/** How long a page of the brain may take to read the brain. */
const brainRead = { timeout: 15_000 };

test("a person opens the brain on its atlas, goes into a part of it, opens a note there and finds it on the atlas again", async ({
  pageOf,
}) => {
  const { member } = peopleIn("brain");
  const page = await pageOf(member);
  await page.goto("/");

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Brain", exact: true })
    .click();
  await expect(page).toHaveURL(/\/brain$/u);
  const main = page.getByRole("main");
  const board = main.getByRole("button", { name: /^Board/u });
  await expect(board).toBeVisible(brainRead);

  // A region of the brain, up close: its notes as neurons.
  await board.click();
  await expect(page).toHaveURL(/\/brain\?region=frontal$/u);

  // The note opens on its own page, its dots building the page.
  await main.getByRole("button", { name: "Vision page" }).click();
  await expect(page).toHaveURL(/\/brain\/vision$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: "Vision page" })
  ).toBeVisible();

  // And back on the atlas where it sits, in hand.
  await page.getByRole("button", { name: "More for this page" }).click();
  await page.getByRole("menuitem", { name: "View in map" }).click();
  await expect(page).toHaveURL(/\/brain\?note=vision$/u);

  // Escape steps out: from the note to its region, from the region to the whole brain.
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/brain\?region=frontal$/u);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/brain$/u);
});

test("a person opens a region from the brain's navigation, and a note in it", async ({
  pageOf,
}) => {
  const { member } = peopleIn("brain");
  const page = await pageOf(member);
  await page.goto("/brain");

  // The navigation lists the brain's regions: the board first.
  const nav = page.getByRole("tree", { name: "In the brain" });
  await nav.getByRole("link", { name: /^Board/u }).click(brainRead);
  await expect(page).toHaveURL(/\/brain\?region=frontal$/u);

  // The region opens in the navigation too, to the notes it holds.
  await nav.getByRole("link", { name: "Vision page" }).click();
  await expect(page).toHaveURL(/\/brain\/vision$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: "Vision page" })
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" })
  ).toContainText("Board");
});

test("a person goes from page to page of the brain from its navigation, which marks the page they are on", async ({
  pageOf,
}) => {
  const { member } = peopleIn("brain");
  const page = await pageOf(member);
  await page.goto("/brain");

  const pages = page.getByRole("tree", { name: "The Brain's pages" });
  const here = (name: string) => pages.getByRole("link", { name, exact: true });

  // On the brain itself, the brain is where you are.
  await expect(here("Brain")).toHaveAttribute(
    "aria-current",
    "page",
    brainRead
  );

  // On its log, the log is, and the brain no longer.
  await here("Activity").click();
  await expect(page).toHaveURL(/\/brain\/activity$/u);
  await expect(here("Activity")).toHaveAttribute("aria-current", "page");
  await expect(here("Brain")).not.toHaveAttribute("aria-current", "page");

  // And on its sources, they are.
  await here("Sources").click();
  await expect(page).toHaveURL(/\/brain\/sources$/u);
  await expect(here("Sources")).toHaveAttribute("aria-current", "page");
  await expect(here("Activity")).not.toHaveAttribute("aria-current", "page");
});

test("a person opens a part of the brain from the organization's page, and the navigation marks the organization", async ({
  pageOf,
}) => {
  const { member } = peopleIn("brain");
  const page = await pageOf(member);
  await page.goto("/brain/company");

  // The organization's page names each part of the brain, its name a link to the part's page.
  const main = page.getByRole("main");
  await main
    .getByRole("link", { name: "Vision", exact: true })
    .click(brainRead);
  await expect(page).toHaveURL(/\/brain\/sections\/vision$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: "Vision" })
  ).toBeVisible();
  await expect(page.getByText("Note not found")).toHaveCount(0);

  // The part is one of the organization's, so the navigation has the organization current.
  const pages = page.getByRole("tree", { name: "The Brain's pages" });
  await expect(
    pages.getByRole("link", { name: "Organization", exact: true })
  ).toHaveAttribute("aria-current", "page");
});

test("a person opens a line of the brain's activity beside it, sees what the brain kept of it, and goes to its page", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("brainActivity");
  const tag = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const title = `Expense policy ${tag}`;
  const kept = `Expenses above 500 euros need a yes ${tag}.`;
  const { core, api } = apiOf(admin);
  try {
    await api.brain.addRecords([
      {
        type: "source",
        id: `src-${tag}`,
        kind: "document",
        title,
        date: new Date().toISOString().slice(0, 10),
        who: "Controller",
        teamIds: [],
      },
      {
        type: "statement",
        id: `st-${tag}`,
        kind: "rule",
        text: kept,
        sourceId: `src-${tag}`,
        teamIds: [],
        toolIds: [],
      },
    ]);
  } finally {
    core[Symbol.dispose]();
  }

  const page = await pageOf(admin);
  await page.goto("/brain/activity");
  const main = page.getByRole("main");
  await main
    .getByRole("button", { name: new RegExp(title, "u") })
    .click(brainRead);

  // Beside the log: what the brain kept of it.
  const line = main.getByRole("complementary", { name: title });
  await expect(
    line.getByRole("region", { name: "What the brain kept" })
  ).toContainText(kept);

  // Open goes to its own page.
  await line.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/brain/src-${tag}$`, "u"));
  await expect(
    page.getByRole("heading", { level: 1, name: title })
  ).toBeVisible();
});

test("a source's row on the Sources page is laid out by its list's width: on a phone and beside an opened source the name reads whole with where it lives and when under it, on a wider list the name keeps to one line with that at the row's end", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("brainActivity");
  const tag = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const title = `Travel policy ${tag} with a long name that runs past a phone's width and past a row's on a laptop`;
  const { core, api } = apiOf(admin);
  try {
    await api.brain.addRecords([
      {
        type: "source",
        id: `src-${tag}`,
        kind: "document",
        title,
        date: new Date().toISOString().slice(0, 10),
        who: "Controller",
        teamIds: [],
      },
    ]);
  } finally {
    core[Symbol.dispose]();
  }

  const page = await pageOf(admin);
  const main = page.getByRole("main");
  const row = main.getByRole("listitem").filter({ hasText: title });
  // Where the name's words and the detail stand in the row's title.
  const placed = async () =>
    await row.locator('[data-slot="item-title"]').evaluate((box, name) => {
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      const words = document.createRange();
      let holder: Element | null = null;
      for (
        let node = walker.nextNode();
        node !== null;
        node = walker.nextNode()
      ) {
        if (node.textContent === name) {
          words.selectNodeContents(node);
          holder = node.parentElement;
        }
      }
      const text = words.getBoundingClientRect();
      const detail = box
        .querySelector('[data-slot="item-detail"]')
        ?.getBoundingClientRect();
      // The title's line height, in pixels ("20px").
      const line = Number(getComputedStyle(box).lineHeight.replace("px", ""));
      return {
        lines: Math.round(text.height / line),
        cut:
          holder !== null &&
          getComputedStyle(holder).textOverflow === "ellipsis" &&
          holder.scrollWidth > holder.clientWidth,
        textEnd: text.right,
        textBottom: text.bottom,
        titleEnd: box.getBoundingClientRect().right,
        detailTop: detail?.top ?? 0,
        nameEnd: holder?.getBoundingClientRect().right ?? 0,
        detailStart: detail?.left ?? 0,
        detailEnd: detail?.right ?? 0,
      };
    }, title);
  const linesOf = async () => {
    const place = await placed();
    return place.lines;
  };
  // Stacked: every word of the name inside the row's title, none cut off,
  // the detail under the name's last line, not beside it.
  const stacked = async () => {
    const place = await placed();
    expect(place.textBottom).toBeGreaterThan(0);
    expect(place.cut).toBe(false);
    expect(place.textEnd).toBeLessThanOrEqual(place.titleEnd + 0.5);
    expect(place.detailTop).toBeGreaterThanOrEqual(place.textBottom - 0.5);
  };

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/brain/sources");
  await expect(row).toBeVisible(brainRead);
  await stacked();

  // At a laptop's width the list is wide enough for one line: the name on
  // it, cut with an ellipsis, and the detail beside it at the row's end.
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect.poll(linesOf).toBe(1);
  const wide = await placed();
  expect(wide.cut).toBe(true);
  expect(wide.detailTop).toBeLessThan(wide.textBottom);
  expect(wide.detailStart).toBeGreaterThanOrEqual(wide.nameEnd - 0.5);
  expect(wide.detailEnd).toBeLessThanOrEqual(wide.titleEnd + 0.5);

  // At a desktop's width with a source open beside it, the list is as
  // narrow as a phone's, and its rows stack again.
  await page.setViewportSize({ width: 1440, height: 900 });
  await main.getByRole("button", { name: "Upload", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({
    name: `Board pack ${tag}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from("The board pack's text."),
  });
  await dialog.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  // The upload opens beside the list, which narrows.
  await expect.poll(linesOf, brainRead).toBeGreaterThan(1);
  await stacked();
});
