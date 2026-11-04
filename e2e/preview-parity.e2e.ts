import { expect } from "@playwright/test";
import type { FrameLocator } from "@playwright/test";

import { test } from "./csp.ts";
import { writeDraft } from "./draft-writes.ts";
import { apiOf, peopleIn } from "./people.ts";

// Every built-in App's page renders the same in a chat's preview and
// published, from the same files and the same data (none yet). The
// preview runs on a build of its own, instrumented for React Fast
// Refresh, on React's development build, with its modules on the
// preview's own addresses, and what it shows must be what goes live. The
// differences meant to stay don't reach the page's markup: Fast Refresh's
// hooks, React's development build, and the preview's own store instead
// of the App's data. The preview is the chat's studio's (chat-preview.e2e
// .ts), of a draft that adds a file no page imports; the published page
// is the App's own, as people open it.

/**
 * How long the release's install may take to list the built-ins: it runs
 * on the first request, in the background.
 */
const installedMs = 30_000;

/** Each built-in App, its page, and the heading the page shows once it runs. */
const pages = [
  { blueprint: "intake", screen: "intake", heading: "Intake" },
  { blueprint: "board-page", screen: "board", heading: "Board page" },
  { blueprint: "workflow-map", screen: "map", heading: "Workflow map" },
] as const;

/** The markup a frame's page shows. */
const markupOf = async (frame: FrameLocator): Promise<string> =>
  await frame.locator("body").evaluate((body) => body.innerHTML);

/** The markup a frame's page shows once it stopped changing: its reads answered. */
const settledMarkupOf = async (frame: FrameLocator): Promise<string> => {
  let last = "";
  await expect
    .poll(
      async () => {
        const now = await markupOf(frame);
        const settled = now === last;
        last = now;
        return settled;
      },
      { intervals: [500], timeout: 20_000 }
    )
    .toBe(true);
  return last;
};

for (const { blueprint, screen, heading } of pages) {
  test(`renders the ${blueprint} page the same in a preview and published`, async ({
    pageOf,
  }) => {
    const { admin } = peopleIn("previewParity");
    const tag = crypto.randomUUID().slice(0, 8);
    const name = `${heading} ${tag}`;
    const { core, api } = apiOf(admin);
    let app: string;
    let chat: string;
    try {
      await expect
        .poll(
          async () => {
            const listed = await api.apps.blueprints.list();
            return listed.some(({ id }) => id === blueprint);
          },
          { timeout: installedMs }
        )
        .toBeTruthy();
      const created = await api.apps.blueprints.create(blueprint, { name });
      app = created.app.id;
      await api.apps.versions.setCurrent(app, 1);
      await api.apps.publish(app);
      const thread = await api.chats.create(`Build ${tag}`);
      chat = thread.id;
    } finally {
      core[Symbol.dispose]();
    }

    const page = await pageOf(admin);
    await page.goto(`/apps/${app}/full?screen=${screen}`);
    const published = page.frameLocator(`iframe[title="${screen} app"]`);
    // The first open builds it, which takes a while on a loaded machine.
    await expect(published.getByRole("heading", { name: heading })).toBeVisible(
      { timeout: 30_000 }
    );
    const live = await settledMarkupOf(published);

    // A draft that renders as the version does: a file no page imports.
    await writeDraft(admin.userId, chat, app, 1, {
      "components/parity.ts": "export const parity = true;\n",
    });
    await page.goto(`/?chat=${chat}`);
    const preview = page
      .getByRole("region", { name: `Preview of ${name}` })
      .frameLocator("iframe");
    await expect(preview.getByRole("heading", { name: heading })).toBeVisible({
      timeout: 30_000,
    });

    expect(await settledMarkupOf(preview)).toBe(live);
  });
}
