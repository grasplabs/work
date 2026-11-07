import { expect } from "@playwright/test";
import type { FrameLocator, Locator, Page } from "@playwright/test";

import { test } from "./csp.ts";
import { writeDraft } from "./draft-writes.ts";
import { modelScripts } from "./model-scripts.ts";
import { apiOf, peopleIn } from "./people.ts";
import { tallyFiles } from "./tally-app.ts";

// A chat builds an App in a studio: the chat alone until its agent writes
// a draft, then the chat on the left and the draft's preview on the
// right, under the App's own top row with the way to the App. The preview
// is the draft's page, an App of spec 8's layout: its queries, live
// queries and mutations run on the draft's sealed release, on a store of
// the preview's own, so it reads none of the App's data and changes none
// (the threat model on GRA-662). The local stack reaches no model,
// so the draft is written straight into the chat's Workspace object, as
// the agent's `env.build.write` leaves it, through the local dev server's
// own tools (as connections-seed.ts writes into connect's database). The
// agent's side of it, and what the preview reports back to it, are core's
// tests (apps/core/test/preview-repairs.test.ts).

/**
 * The App's own tally page, released and current, once it shows its
 * count. Its first open builds it, which on a loaded machine takes longer
 * than the default 5 seconds.
 */
/**
 * Asks `text` in `chat` once its last turn has ended: a turn goes on past
 * its answer while its drafts are checked (core's agent-builds.ts,
 * `turnCheck`), and the chat takes no question meanwhile.
 */
const askOnceIdle = async (chat: Locator, text: string): Promise<void> => {
  await expect(
    chat.getByRole("button", { name: "Send", exact: true })
  ).toBeVisible({ timeout: 30_000 });
  const ask = chat.getByRole("textbox", { name: "Ask for a change" });
  await ask.fill(text);
  await ask.press("Enter");
};

const openTally = async (page: Page, app: string): Promise<FrameLocator> => {
  await page.goto(`/apps/${app}/full`);
  const appPage = page.frameLocator('iframe[title="App"]');
  await expect(appPage.getByRole("status")).toContainText("in the App", {
    timeout: 20_000,
  });
  return appPage;
};

test("a chat builds an App in a studio, the chat on the left and a preview that changes none of the App's data on the right", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("chatPreview");
  const { core, api } = apiOf(builder);
  const tag = crypto.randomUUID().slice(0, 8);
  const name = `Tally ${tag}`;
  try {
    const app = await api.apps.create({ name });
    const { version } = await api.apps.files.commit(
      app.id,
      tallyFiles("in the App"),
      "A tally"
    );
    await api.apps.versions.setCurrent(app.id, version);
    // Published, for the people it is shared with (a draft is its
    // builders' alone).
    await api.apps.publish(app.id);
    const chat = await api.chats.create(`Build ${tag}`);
    const page = await pageOf(builder);

    // The App has data of its own: one added through its own page.
    const own = await openTally(page, app.id);
    await own.getByRole("button", { name: "Add one" }).click();
    await expect(own.getByRole("status")).toHaveText("1 in the App");

    // Nothing built yet: the chat alone, the chats' sidebar open beside it.
    // While `failDrafts` holds, reading the chat's drafts goes to an API
    // this stack has switched off (improvement signals), which core
    // refuses: as a read that fails.
    let failDrafts = false;
    await page.routeWebSocket("**/rpc", (socket) => {
      const toCore = socket.connectToServer();
      socket.onMessage((message) => {
        const text = String(message);
        toCore.send(
          failDrafts
            ? text.replaceAll('["chats","drafts"]', '["signals","list"]')
            : text
        );
      });
    });
    await page.goto(`/?chat=${chat.id}`);
    const thread = page.getByRole("region", {
      name: `Build ${tag}`,
      exact: true,
    });
    const studio = page.getByRole("region", { name, exact: true });
    await expect(thread).toBeVisible();
    await expect(studio).toHaveCount(0);

    // Its agent writes a draft: the App stands on the right, and the chat
    // moves to its left.
    await writeDraft(builder.userId, chat.id, app.id, version, {
      "server/tally.ts": tallyFiles("in the preview")["server/tally.ts"] ?? "",
    });
    // A read of it that fails says so beside the chat, and is tried again
    // from there.
    failDrafts = true;
    await page.reload();
    await expect(
      thread.getByText("The Apps this chat builds didn't load.")
    ).toBeVisible();
    await expect(studio).toHaveCount(0);
    failDrafts = false;
    await thread.getByRole("button", { name: "Try again" }).click();
    // Named by its top row's heading: the App's name.
    await expect(studio).toBeVisible();
    await expect(
      thread.getByText("The Apps this chat builds didn't load.")
    ).toHaveCount(0);
    await expect(studio).toContainText("Version 1 of 1");
    const chatBox = await thread.boundingBox();
    const appBox = await studio.boundingBox();
    expect(chatBox).not.toBeNull();
    expect(appBox).not.toBeNull();
    expect((chatBox?.x ?? 0) + (chatBox?.width ?? 0)).toBeLessThanOrEqual(
      (appBox?.x ?? 0) + 1
    );

    const preview = studio.getByRole("region", { name: `Preview of ${name}` });
    await expect(preview).toContainText(
      "Preview: changes nothing, reads no real data"
    );
    // Its own store: none of the App's tally, then only what it added,
    // its live query following each mutation.
    const frame = preview.frameLocator("iframe");
    await expect(frame.getByRole("status")).toHaveText("0 in the preview", {
      timeout: 20_000,
    });
    await frame.getByRole("button", { name: "Add one" }).click();
    await expect(frame.getByRole("status")).toHaveText("1 in the preview");
    await frame.getByRole("button", { name: "Add one" }).click();
    await expect(frame.getByRole("status")).toHaveText("2 in the preview");

    // A phone: the chat and the App take turns, the App first. The
    // preview keeps what it shows through the turns: it isn't loaded anew.
    await page.setViewportSize({ width: 390, height: 844 });
    const showChat = page.getByRole("button", { name: "Chat", exact: true });
    const showApp = page.getByRole("button", { name: "App", exact: true });
    await expect(showApp).toHaveAttribute("aria-pressed", "true");
    await expect(studio).toBeVisible();
    await expect(thread).toBeHidden();
    await frame.getByRole("button", { name: "Add one" }).click();
    await expect(frame.getByRole("status")).toHaveText("3 in the preview");
    await showChat.click();
    await expect(showChat).toHaveAttribute("aria-pressed", "true");
    await expect(thread).toBeVisible();
    await expect(studio).toBeHidden();
    await showApp.click();
    await expect(studio).toBeVisible();
    await expect(frame.getByRole("status")).toHaveText("3 in the preview");

    // Wider than lg the two stand side by side again, with no turns to
    // take; narrower again, the App is where it was. The preview stays.
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(showApp).toHaveCount(0);
    await expect(thread).toBeVisible();
    await expect(studio).toBeVisible();
    await expect(frame.getByRole("status")).toHaveText("3 in the preview");
    await page.setViewportSize({ width: 900, height: 900 });
    await expect(showApp).toHaveAttribute("aria-pressed", "true");
    await expect(thread).toBeHidden();
    await expect(frame.getByRole("status")).toHaveText("3 in the preview");
    await page.setViewportSize({ width: 1280, height: 720 });

    // The App's workspace is a link away.
    await studio
      .getByRole("link", { name: "Open in the App's workspace" })
      .click();
    // It carries this chat on, with the draft it builds.
    await expect(page).toHaveURL(
      new RegExp(`/apps/${app.id}/edit\\?chat=${chat.id}$`, "u")
    );
    // There, the draft this chat builds is the preview, not the live App.
    await expect(
      page.getByText("Unpublished changes", { exact: true })
    ).toBeVisible();
    // It stays this chat's as the person moves between the views.
    const views = page.getByRole("navigation", { name: "Workspace views" });
    await views.getByRole("link", { name: "Code" }).click();
    await views.getByRole("link", { name: "Preview" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/apps/${app.id}/edit\\?chat=${chat.id}$`, "u")
    );
    await expect(
      page.getByText("Unpublished changes", { exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 1, name, exact: true })
    ).toBeVisible();

    // The App's own data is as it was: none of the preview's three.
    const after = await openTally(page, app.id);
    await expect(after.getByRole("status")).toHaveText("1 in the App");
  } finally {
    core[Symbol.dispose]();
  }
});

/**
 * Where `added` stands from `removed` on the page: `under` it in the same
 * column, `beside` it on the same row to its right, or `apart` while
 * either has no box. Measured fresh on each call: the diff draws its lines
 * plainly and then highlighted, in a shadow root, replacing each line's
 * node, so a box taken once can belong to a node already gone.
 */
const placeOf = async (removed: Locator, added: Locator): Promise<string> => {
  const [old, now] = [await removed.boundingBox(), await added.boundingBox()];
  if (old === null || now === null) {
    return "apart";
  }
  if (now.y > old.y && Math.abs(now.x - old.x) < old.width / 2) {
    return "under";
  }
  if (now.y === old.y && now.x > old.x + old.width / 2) {
    return "beside";
  }
  return "apart";
};

test("a version up for review shows its changes in the workspace's Code view, one column or side by side", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("chatPreview");
  const { core, api } = apiOf(builder);
  try {
    const app = await api.apps.create({
      name: `Tally ${crypto.randomUUID().slice(0, 8)}`,
    });
    const { version } = await api.apps.files.commit(
      app.id,
      tallyFiles("in the App"),
      "A tally"
    );
    await api.apps.versions.setCurrent(app.id, version);
    const next = await api.apps.files.commit(
      app.id,
      tallyFiles("in the next version"),
      "The next tally"
    );
    await api.apps.versions.propose(app.id, next.version);
    const page = await pageOf(builder);
    await page.goto(`/apps/${app.id}/edit`);
    await page
      .getByRole("navigation", { name: "Workspace views" })
      .getByRole("link", { name: "Code" })
      .click();
    await page.getByRole("button", { name: "Changes" }).click();

    // One file changed, one line out and one in.
    const changes = page.getByRole("region", { name: "Changes" });
    const changed = changes.getByRole("region", { name: "server/tally.ts" });
    await expect(changes.getByRole("region")).toHaveCount(1);
    await expect(changed).toContainText("-1+1");
    const removed = changed.getByText(/in the App`;$/u);
    const added = changed.getByText(/in the next version`;$/u);
    // Unified, the new line stands under the old; split, beside it.
    await expect.poll(async () => await placeOf(removed, added)).toBe("under");
    await page.getByRole("button", { name: "Split" }).click();
    await expect.poll(async () => await placeOf(removed, added)).toBe("beside");
  } finally {
    core[Symbol.dispose]();
  }
});

test("an App's own chat writes its page and server code, and its workspace previews it, taking each write in place, and saying a problem is being fixed while the server code doesn't build", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("chatPreview");
  const { core, api } = apiOf(builder);
  const name = `Tally ${crypto.randomUUID().slice(0, 8)}`;
  try {
    const app = await api.apps.create({ name });
    const page = await pageOf(builder);
    await page.goto(`/apps/${app.id}/edit`);
    await expect(page.getByText("Nothing built yet")).toBeVisible();

    // A version committed elsewhere, from another tab: the App shows.
    await api.apps.files.commit(app.id, tallyFiles("in the App"), "A tally");
    const committed = page
      .getByRole("region", { name: `Preview of ${name}` })
      .frameLocator("iframe");
    await expect(committed.getByRole("status")).toHaveText("0 in the App", {
      timeout: 30_000,
    });

    const { opener } = modelScripts.buildsTally;
    const chat = page.getByRole("region", { name: "Chat" });
    const ask = chat.getByRole("textbox", { name: "Ask for a change" });
    await askOnceIdle(chat, opener);
    await expect(chat.getByText("The tally is in the preview.")).toBeVisible({
      timeout: 30_000,
    });

    // The page the agent wrote runs in the preview, on a store of its own.
    const preview = page.getByRole("region", { name: `Preview of ${name}` });
    await expect(
      page.getByText("Unpublished changes", { exact: true })
    ).toBeVisible();
    const frame = preview.frameLocator("iframe");
    await expect(frame.getByRole("status")).toHaveText("0 in the preview", {
      timeout: 30_000,
    });
    await frame.getByRole("button", { name: "Add one" }).click();
    await expect(frame.getByRole("status")).toHaveText("1 in the preview");

    // The agent writes the page again: the frame it has open takes the
    // write in place, its document never loaded again, and its store
    // keeps what was added.
    const pageFrame = page
      .frames()
      .find((each) => each.url().includes("/page-frame"));
    expect(pageFrame).toBeDefined();
    await pageFrame?.evaluate(() => {
      Reflect.set(globalThis, "stillThisDocument", true);
    });
    await expect(
      chat.getByRole("button", { name: "Send", exact: true })
    ).toBeVisible({ timeout: 30_000 });
    await ask.fill("Rename the button.");
    const asked = Date.now();
    await ask.press("Enter");
    await expect(chat.getByText("Renaming the button.")).toBeVisible({
      timeout: 30_000,
    });
    const written = Date.now();
    await expect(
      frame.getByRole("button", { name: "Add another" })
    ).toBeVisible({ timeout: 10_000 });
    const shown = Date.now();
    console.info(
      `preview took the write ${shown - written} ms after the chat showed it (${shown - asked} ms after asking)`
    );
    const sameDocument: unknown = await pageFrame?.evaluate((): unknown =>
      Reflect.get(globalThis, "stillThisDocument")
    );
    expect({
      count: await frame.getByRole("status").textContent(),
      sameDocument,
    }).toStrictEqual({ count: "1 in the preview", sameDocument: true });

    // The agent writes its server code alone: the frame takes it in
    // place, its live count read again on the new code, on the preview's
    // store, kept while the schema is the same.
    await askOnceIdle(chat, "Count anew.");
    await expect(chat.getByText("It counts anew.")).toBeVisible({
      timeout: 30_000,
    });
    await expect(frame.getByRole("status")).toHaveText("1 counted anew", {
      timeout: 10_000,
    });
    await frame.getByRole("button", { name: "Add another" }).click();
    await expect(frame.getByRole("status")).toHaveText("2 counted anew");

    // Server code that doesn't build, with a write of the page, whose
    // references it can't have then: the frame keeps the page it shows,
    // and says the problem is being fixed.
    await askOnceIdle(chat, "Take more.");
    await expect(chat.getByText("It takes more.")).toBeVisible({
      timeout: 30_000,
    });
    await expect(preview.getByText("Fixing a problem…")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      frame.getByRole("button", { name: "Add another" })
    ).toBeVisible();

    // Once it builds, the frame takes it as any write.
    await askOnceIdle(chat, "Fix the count.");
    await expect(chat.getByText("The count is fixed.")).toBeVisible({
      timeout: 30_000,
    });
    await expect(frame.getByRole("status")).toHaveText("2 fixed", {
      timeout: 10_000,
    });
    await expect(frame.getByRole("button", { name: "Add more" })).toBeVisible();
    await expect(preview.getByText("Fixing a problem…")).toHaveCount(0);
    const stillSameDocument: unknown = await pageFrame?.evaluate((): unknown =>
      Reflect.get(globalThis, "stillThisDocument")
    );
    expect(stillSameDocument).toBe(true);

    // The Code view shows the draft the preview does, before anything is
    // published: the App's project as the agent wrote it, its last write
    // too.
    await page
      .getByRole("navigation", { name: "Workspace views" })
      .getByRole("link", { name: "Code" })
      .click();
    // Its tree: folders first, each open, then the files, each by name.
    const files = page.getByRole("navigation", { name: "Files" });
    await expect(files.getByRole("button")).toHaveText([
      "server",
      "schema.ts",
      "tally.ts",
      "src",
      "routes",
      "index.tsx",
      "definition.json",
      "grasp.config.ts",
    ]);
    await files.getByRole("button", { name: "index.tsx" }).click();
    const code = page.getByRole("region", {
      name: "Code of src/routes/index.tsx",
    });
    await expect(code).toContainText("Add more");
    await expect(
      page.getByRole("navigation", { name: "Open file" })
    ).toHaveText(/src.*routes.*index\.tsx/u);
  } finally {
    core[Symbol.dispose]();
  }
});

test("an App's workspace previews the App before its chat changes anything, then each change its chat makes", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("chatPreview");
  const { core, api } = apiOf(builder);
  const name = `Tally ${crypto.randomUUID().slice(0, 8)}`;
  try {
    const app = await api.apps.create({ name });
    await api.apps.files.commit(app.id, tallyFiles("in the App"), "A tally");
    const page = await pageOf(builder);
    await page.goto(`/apps/${app.id}/edit`);

    // No change asked for yet: the App's latest version, on a store of the
    // preview's own.
    const preview = page.getByRole("region", { name: `Preview of ${name}` });
    const frame = preview.frameLocator("iframe");
    await expect(frame.getByRole("status")).toHaveText("0 in the App", {
      timeout: 30_000,
    });
    await expect(
      page.getByText("Unpublished changes", { exact: true })
    ).toHaveCount(0);

    // A version committed elsewhere comes into the open preview.
    await api.apps.files.commit(
      app.id,
      tallyFiles("in version 2"),
      "Elsewhere"
    );
    await expect(frame.getByRole("status")).toHaveText("0 in version 2", {
      timeout: 30_000,
    });
    // The bar names the version shown: committed, not proposed nor live.
    await expect(
      page.getByText("Version 2 isn't published or up for review")
    ).toBeVisible();

    // Asked for one: the same preview shows it.
    const { opener } = modelScripts.buildsTally;
    const chat = page.getByRole("region", { name: "Chat" });
    await askOnceIdle(chat, opener);
    await expect(chat.getByText("The tally is in the preview.")).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText("Unpublished changes", { exact: true })
    ).toBeVisible();
    await expect(frame.getByRole("status")).toHaveText("0 in the preview", {
      timeout: 30_000,
    });
  } finally {
    core[Symbol.dispose]();
  }
});

test("a preview opened on a draft that doesn't build shows the App's latest version, saying it is being fixed, until a write builds", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("chatPreview");
  const { core, api } = apiOf(builder);
  const name = `Tally ${crypto.randomUUID().slice(0, 8)}`;
  try {
    const app = await api.apps.create({ name });
    await api.apps.files.commit(app.id, tallyFiles("in the App"), "A tally");
    const page = await pageOf(builder);
    await page.goto(`/apps/${app.id}/edit`);
    const preview = page.getByRole("region", { name: `Preview of ${name}` });
    const frame = preview.frameLocator("iframe");
    await expect(frame.getByRole("status")).toHaveText("0 in the App", {
      timeout: 30_000,
    });

    const { opener } = modelScripts.fixesBrokenTally;
    const chat = page.getByRole("region", { name: "Chat" });
    await askOnceIdle(chat, opener);
    await expect(
      chat.getByText("The tally's page doesn't build yet.")
    ).toBeVisible({ timeout: 30_000 });

    // Opened afresh on it: the App's latest version's page, its calls on
    // the draft as it is, and a word that the problem is being fixed.
    await page.reload();
    await expect(frame.getByRole("status")).toHaveText("0 in the preview", {
      timeout: 30_000,
    });
    await expect(preview.getByText("Fixing a problem…")).toBeVisible();

    await askOnceIdle(chat, "Fix the page.");
    await expect(chat.getByText("The tally works now.")).toBeVisible({
      timeout: 30_000,
    });
    await expect(preview.getByText("Fixing a problem…")).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(frame.getByRole("status")).toHaveText("0 in the preview");
  } finally {
    core[Symbol.dispose]();
  }
});

test("a preview whose first page doesn't build shows it once the agent's next write fixes it", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("chatPreview");
  const { core, api } = apiOf(builder);
  const name = `Tally ${crypto.randomUUID().slice(0, 8)}`;
  try {
    const app = await api.apps.create({ name });
    const page = await pageOf(builder);
    await page.goto(`/apps/${app.id}/edit`);
    await expect(page.getByText("Nothing built yet")).toBeVisible();

    const { opener } = modelScripts.fixesBrokenTally;
    const chat = page.getByRole("region", { name: "Chat" });
    await askOnceIdle(chat, opener);
    await expect(
      chat.getByText("The tally's page doesn't build yet.")
    ).toBeVisible({ timeout: 30_000 });

    // Its first build fails: the preview says so, and takes no updates.
    const preview = page.getByRole("region", { name: `Preview of ${name}` });
    await expect(
      preview.getByText("This page doesn't build. Ask a builder to fix it.")
    ).toBeVisible({ timeout: 30_000 });

    // The next write fixes it: the preview starts afresh and shows it.
    await askOnceIdle(chat, "Fix the page.");
    await expect(chat.getByText("The tally works now.")).toBeVisible({
      timeout: 30_000,
    });
    await expect(preview.frameLocator("iframe").getByRole("status")).toHaveText(
      "0 in the preview",
      { timeout: 30_000 }
    );
  } finally {
    core[Symbol.dispose]();
  }
});
