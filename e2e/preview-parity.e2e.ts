import { readFileSync } from "node:fs";
import path from "node:path";

import { readDefinition } from "@grasp-os/runtime/definition";
import { expect } from "@playwright/test";
import type { FrameLocator } from "@playwright/test";

import { filesIn, testBlueprintsDir } from "../apps/core/build-blueprints.ts";
import { appOf, publishApp } from "../apps/core/test/app-definitions.ts";
import type { TestApp } from "../apps/core/test/app-definitions.ts";
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

/** An App to check, the text its first page shows once its reads answered, and any page linked from it to check too. */
interface Parity {
  readonly name: string;
  readonly files: () => TestApp;
  readonly settled: string;
  readonly linked?: { readonly link: string; readonly settled: string };
}

/**
 * Core's tests' own built-in, `hello`: a form on its first page, a data
 * grid on the one it links to, which bring in the kit modules a real App
 * imports.
 */
const helloFiles = (): TestApp => {
  const folder = path.join(testBlueprintsDir, "hello");
  return appOf(
    readDefinition(
      JSON.parse(readFileSync(path.join(folder, "definition.json"), "utf-8"))
    ),
    filesIn(path.join(folder, "files"))
  );
};

const apps: readonly Parity[] = [
  {
    name: "Tally",
    files: () => tallyFiles("in the App"),
    settled: "0 in the App",
  },
  {
    name: "Hello",
    files: helloFiles,
    settled: "No greeting yet",
    linked: { link: "Everyone greeted", settled: "Nothing here yet." },
  },
];

/** The markup a frame's page shows once it shows `settled`. */
const settledMarkupOf = async (
  frame: FrameLocator,
  settled: string
): Promise<string> => {
  // The first open builds it, which takes a while on a loaded machine.
  await expect(frame.getByText(settled, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  return await frame.locator("body").evaluate((body) => body.innerHTML);
};

/** The markup of each page `parity` checks, from its first. */
const markupsOf = async (
  frame: FrameLocator,
  parity: Parity
): Promise<string[]> => {
  const first = await settledMarkupOf(frame, parity.settled);
  if (parity.linked === undefined) {
    return [first];
  }
  await frame.getByRole("link", { name: parity.linked.link }).click();
  return [first, await settledMarkupOf(frame, parity.linked.settled)];
};

for (const parity of apps) {
  test(`renders the ${parity.name} App's pages the same in a preview and published`, async ({
    pageOf,
  }) => {
    const { admin } = peopleIn("previewParity");
    const tag = crypto.randomUUID().slice(0, 8);
    const name = `${parity.name} ${tag}`;
    const { core, api } = apiOf(admin);
    let app: string;
    let version: number;
    let chat: string;
    try {
      const created = await api.apps.create({ name });
      app = created.id;
      ({ version } = await publishApp(api, app, parity.files()));
      const thread = await api.chats.create(`Build ${tag}`);
      chat = thread.id;
    } finally {
      core[Symbol.dispose]();
    }

    const page = await pageOf(admin);
    await page.goto(`/apps/${app}/full`);
    const live = await markupsOf(
      page.frameLocator('iframe[title="App"]'),
      parity
    );

    // A draft that renders as the version does: a file no page imports.
    await writeDraft(admin.userId, chat, app, version, {
      "src/components/parity.ts": "export const parity = true;\n",
    });
    await page.goto(`/apps/${app}?chat=${chat}`);
    const preview = page
      .getByRole("region", { name: `${name}, your version` })
      .frameLocator("iframe");

    expect(await markupsOf(preview, parity)).toStrictEqual(live);
  });
}
