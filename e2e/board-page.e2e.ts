import { expect } from "@playwright/test";
import type { FrameLocator, Page } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";

// The board page, the built-in App, end to end: an admin creates an App
// from it and one from the workflow map, binds the page's `map` to that
// map, draws workflows in the map, takes a snapshot of them on the page,
// writes its narrative and decision, and prints it: the page alone, on
// one sheet of A4.

const boardPage = "board-page";
const workflowMap = "workflow-map";

/**
 * How long the release's install may take to list the built-in: it runs
 * on the first request, in the background.
 */
const installedMs = 30_000;

/** Workflows drawn: more than each list on the page shows. */
const seeded = 6;

/** A decision long enough to be cut short in print. */
const decision =
  `Automate answering tenders next quarter? ${"It takes most of our hours, and the design saves nine of every ten. ".repeat(6)}`.trim();

/** A sheet of A4 in CSS pixels, as a PDF of it has no margins. */
const a4 = { width: 794, height: 1123 };

/** The pages in a PDF: its page objects, not the page tree (`/Pages`). */
const pageObject = /\/Type\s*\/Page(?![a-z])/gu;

/** The screen of `app`'s route `screen`, once it shows `heading`. */
const openScreen = async (
  page: Page,
  app: string,
  screen: string,
  heading: string
): Promise<FrameLocator> => {
  await page.goto(`/domains/${app}/apps/${screen}/full`);
  const frame = page.frameLocator(`iframe[title="${screen} app"]`);
  // The first open builds the screen, which takes a while on a loaded machine.
  await expect(frame.getByRole("heading", { name: heading })).toBeVisible({
    timeout: 20_000,
  });
  return frame;
};

/** Draws a workflow of one step, `times` a week for 30 minutes, in the map. */
const draw = async (
  map: FrameLocator,
  title: string,
  times: number
): Promise<void> => {
  await map.getByRole("button", { name: "Draw a workflow" }).click();
  await map.getByLabel("Title", { exact: true }).fill(title);
  await map.getByRole("button", { name: "Add a step" }).click();
  await map.getByLabel("Name, step 1").fill("Do it");
  await map.getByLabel("Times a week, step 1").fill(String(times));
  await map.getByLabel("Minutes, step 1").fill("30");
  await map.getByRole("button", { name: "Save" }).click();
  await expect(map.getByText("Version 1")).toBeVisible();
  await map.getByRole("button", { name: "All workflows" }).click();
};

test("an admin takes a snapshot on the board page, writes its narrative and prints it on one page", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("boardPage");
  const run = crypto.randomUUID().slice(0, 8);
  const { core, api } = apiOf(admin);
  let app: string;
  let map: string;
  try {
    await expect
      .poll(
        async () => {
          const listed = await api.apps.blueprints.list();
          return [boardPage, workflowMap].every((builtin) =>
            listed.some(({ id }) => id === builtin)
          );
        },
        { timeout: installedMs }
      )
      .toBeTruthy();
    /** An App of the admin's from the built-in `builtin`, current. */
    const copy = async (builtin: string, name: string): Promise<string> => {
      const created = await api.apps.blueprints.create(builtin, { name });
      await api.apps.versions.setCurrent(created.app.id, 1);
      const { generation } = await api.screenTrust.review(created.app.id);
      await api.screenTrust.classify(created.app.id, "ordinary", generation);
      return created.app.id;
    };
    app = await copy(boardPage, `Board page ${run}`);
    map = await copy(workflowMap, `Workflow map ${run}`);
    // The map it reads, bound as an admin binds it on the engine's
    // Resources tab. Its statistics stay unbound: nothing here runs.
    await api.resourceBindings.approve({
      app,
      alias: "map",
      target: { kind: "app", appId: map },
      reviewed: { version: 1 },
    });
  } finally {
    core[Symbol.dispose]();
  }

  const page = await pageOf(admin);
  const mapScreen = await openScreen(page, map, "map", "Workflow map");
  for (let index = 1; index <= seeded; index += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one drawing at a time
    await draw(
      mapScreen,
      `A workflow with a long name to wrap, number ${index} of run ${run}`,
      index * 10
    );
  }
  const screen = await openScreen(page, app, "board", "Board page");

  await screen.getByRole("combobox", { name: "Maturity" }).click();
  await screen.getByRole("option", { name: "Maturity 2 of 5" }).click();
  await screen.getByRole("button", { name: "Take a snapshot" }).click();
  const board = screen.getByRole("article", { name: "Board page" });
  await expect(board.getByText("Maturity 2 of 5")).toBeVisible();
  await expect(
    board.getByRole("table", { name: "Where the hours go" }).getByRole("row")
  ).toHaveCount(6);

  await screen.getByLabel("Edit the decision needed").fill(decision);
  await screen
    .getByLabel("Edit the narrative")
    .fill(
      Array.from(
        { length: 30 },
        (_, line) =>
          `Line ${line + 1}: where we stand, what changed and what comes next.`
      ).join("\n")
    );
  await screen.getByRole("button", { name: "Save" }).click();
  await expect(board.getByText(decision)).toBeVisible();

  // Printed on A4 (at 96 pixels an inch, without margins): the page alone,
  // without the controls or the App's chrome. The screen's frame fills the
  // sheet and clips what doesn't fit, so the page must fit in the frame,
  // and the sheet be the only one.
  await page.setViewportSize(a4);
  await page.emulateMedia({ media: "print" });
  await expect(board).toBeVisible();
  await expect(
    screen.getByRole("button", { name: "Take a snapshot" })
  ).toBeHidden();
  await expect(screen.getByLabel("Edit the narrative")).toBeHidden();
  await expect(page.getByText("Domain app")).toBeHidden();
  const frame = page
    .frames()
    .find((each) => each.url().includes("/screen-frame"));
  const fit = await frame?.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    room: window.innerHeight,
  }));
  expect(fit?.room).toBe(a4.height);
  expect(fit?.height).toBeLessThanOrEqual(a4.height);
  const pdf = await page.pdf({ format: "A4", printBackground: true });
  expect(pdf.toString("latin1").match(pageObject)).toHaveLength(1);

  // Paper is light: printed from the dark theme, the screen's colours are
  // the light theme's.
  const colours = async () =>
    await frame?.evaluate(() => ({
      dark: document.documentElement.classList.contains("dark"),
      background: getComputedStyle(document.body).backgroundColor,
      text: getComputedStyle(document.body).color,
    }));
  const light = await colours();
  await page.emulateMedia({ media: "print", colorScheme: "dark" });
  await expect
    .poll(async () => {
      const now = await colours();
      return now?.dark;
    })
    .toBeTruthy();
  expect(await colours()).toStrictEqual({ ...light, dark: true });
});
