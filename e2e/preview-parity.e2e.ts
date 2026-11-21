import { expect } from "@playwright/test";
import type { FrameLocator } from "@playwright/test";

import { publishApp } from "../apps/core/test/app-definitions.ts";
import { test } from "./csp.ts";
import { writeDraft } from "./draft-writes.ts";
import { apiOf, peopleIn } from "./people.ts";
import { tallyFiles } from "./tally-app.ts";

// An App's page renders the same in a chat's preview and published, from
// the same files and the same data (none yet). The preview runs on a
// build of its own, instrumented for React Fast Refresh, on React's
// development build, with its modules on the preview's own addresses, and
// what it shows must be what goes live. The differences meant to stay
// don't reach the page's markup: Fast Refresh's hooks, React's
// development build, and the preview's own store instead of the App's
// data. The preview is the App's workspace's (chat-preview.e2e.ts), of a
// draft that adds a file no page imports; the published page is the
// App's own, as people open it.

/** What the tally's page shows once its count answered, with none added. */
const settled = "0 in the App";

/** The markup a frame's page shows once it shows `settled`. */
const settledMarkupOf = async (frame: FrameLocator): Promise<string> => {
  // The first open builds it, which takes a while on a loaded machine.
  await expect(frame.getByRole("status")).toHaveText(settled, {
    timeout: 30_000,
  });
  return await frame.locator("body").evaluate((body) => body.innerHTML);
};

test("renders an App's page the same in a preview and published", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("previewParity");
  const tag = crypto.randomUUID().slice(0, 8);
  const name = `Tally ${tag}`;
  const { core, api } = apiOf(admin);
  let app: string;
  let version: number;
  let chat: string;
  try {
    const created = await api.apps.create({ name });
    app = created.id;
    ({ version } = await publishApp(api, app, tallyFiles("in the App")));
    const thread = await api.chats.create(`Build ${tag}`);
    chat = thread.id;
  } finally {
    core[Symbol.dispose]();
  }

  const page = await pageOf(admin);
  await page.goto(`/apps/${app}/full`);
  const live = await settledMarkupOf(page.frameLocator('iframe[title="App"]'));

  // A draft that renders as the version does: a file no page imports.
  await writeDraft(admin.userId, chat, app, version, {
    "src/components/parity.ts": "export const parity = true;\n",
  });
  await page.goto(`/apps/${app}?chat=${chat}`);
  const preview = page
    .getByRole("region", { name: `${name}, your version` })
    .frameLocator("iframe");

  expect(await settledMarkupOf(preview)).toBe(live);
});
