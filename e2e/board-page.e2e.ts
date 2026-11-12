import { expect } from "@playwright/test";
import type { FrameLocator, Page } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";

// The workflow map's board page, end to end: an admin creates an App from
// the built-in workflow map, draws workflows in the map, takes a snapshot
// of them on its board page, writes its narrative and decision, and
// prints it: the page alone, on one sheet of A4.

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

/** `app`, full page, once its first page shows `heading`. */
const openPage = async (
  page: Page,
  app: string,
  path: string,
  heading: string
): Promise<FrameLocator> => {
  await page.goto(`/apps/${app}/full${path === "/" ? "" : path}`);
  const frame = page.frameLocator('iframe[title="App"]');
  // The first open builds the page, which takes a while on a loaded machine.
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
  try {
    await expect
      .poll(
        async () => {
          const listed = await api.apps.blueprints.list();
          return listed.some(({ id }) => id === workflowMap);
        },
        { timeout: installedMs }
      )
      .toBeTruthy();
    /** An App of the admin's from the built-in `builtin`, live. */
    const copy = async (builtin: string, name: string): Promise<string> => {
      const created = await api.apps.blueprints.create(builtin, { name });
      // Live, for the people it is shared with (until then, its
      // builders' alone).
      await api.apps.versions.publish(created.app.id, 1);
      return created.app.id;
    };
    // Its statistics stay unbound: nothing here runs.
    app = await copy(workflowMap, `Workflow map ${run}`);
  } finally {
    core[Symbol.dispose]();
  }

  const page = await pageOf(admin);
  const mapPage = await openPage(page, app, "/", "Workflow map");
  for (let index = 1; index <= seeded; index += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one drawing at a time
    await draw(
      mapPage,
      `A workflow with a long name to wrap, number ${index} of run ${run}`,
      index * 10
    );
  }
  const appPage = await openPage(page, app, "/board", "Board page");

  await appPage.getByRole("combobox", { name: "Maturity" }).click();
  await appPage.getByRole("option", { name: "Maturity 2 of 5" }).click();
  await appPage.getByRole("button", { name: "Take a snapshot" }).click();
  const board = appPage.getByRole("article", { name: "Board page" });
  await expect(board.getByText("Maturity 2 of 5")).toBeVisible();
  await expect(
    board.getByRole("table", { name: "Where the hours go" }).getByRole("row")
  ).toHaveCount(6);

  await appPage
    .getByRole("textbox", { name: "Decision needed" })
    .fill(decision);
  await appPage
    .getByRole("textbox", { name: "Narrative", exact: true })
    .fill(
      Array.from(
        { length: 30 },
        (_, line) =>
          `Line ${line + 1}: where we stand, what changed and what comes next.`
      ).join("\n")
    );
  await appPage.getByRole("button", { name: "Save" }).click();
  await expect(board.getByText(decision)).toBeVisible();

  // Printed on A4 (at 96 pixels an inch, without margins): the page alone,
  // without the controls or the App's chrome. The page's frame fills the
  // sheet and clips what doesn't fit, so the page must fit in the frame,
  // and the sheet be the only one.
  await page.setViewportSize(a4);
  await page.emulateMedia({ media: "print" });
  await expect(board).toBeVisible();
  await expect(
    appPage.getByRole("button", { name: "Take a snapshot" })
  ).toBeHidden();
  await expect(
    appPage.getByRole("textbox", { name: "Narrative", exact: true })
  ).toBeHidden();
  await expect(page.getByText("App page")).toBeHidden();
  const frame = page
    .frames()
    .find((each) => each.url().includes("/page-frame"));
  const fit = await frame?.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    room: window.innerHeight,
  }));
  expect(fit?.room).toBe(a4.height);
  expect(fit?.height).toBeLessThanOrEqual(a4.height);
  const pdf = await page.pdf({ format: "A4", printBackground: true });
  expect(pdf.toString("latin1").match(pageObject)).toHaveLength(1);

  // Paper is light: printed from the dark theme, the page's colours are
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
