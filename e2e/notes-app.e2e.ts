import { readFile } from "node:fs/promises";

import { expect } from "@playwright/test";
import type { FrameLocator, Page } from "@playwright/test";

import type { TestSource } from "../apps/core/test/app-definitions.ts";
import { test } from "./csp.ts";
import {
  fileViewFiles,
  linksFiles,
  notesAppFiles,
  unaskedDownloadFiles,
} from "./notes-app.ts";
import {
  apiOf,
  endSession,
  ordinaryData,
  peopleIn,
  release,
  revokeNewestRelease,
  signInTo,
} from "./people.ts";

// The Notes App end to end on the platform's own runtime and React SDK: a
// builder's App of spec 8's layout, sealed and live, its page in its
// sandboxed frame reading and writing the App's store through the session
// client the platform mounts, with the generated `@server/_generated/api` references, an
// function-bound create form and a record editor with explicit Save.
// What a lost answer, a cancelled save or a reused key does is core's
// own test, through the same client (apps/core/test/page-client*.test.ts).
// A page whose page connects again as someone else, or calls core once
// someone else signed in, is stopped before anything it holds is sent as
// them; one whose person signed out is emptied too.

/**
 * A builder's new Notes App of `files`, released, and shared with
 * `sharedWith`.
 */
const notesApp = async (
  builder: Parameters<typeof apiOf>[0],
  sharedWith?: { userId: string },
  files: TestSource = notesAppFiles()
): Promise<string> => {
  const name = `Notes ${crypto.randomUUID().slice(0, 8)}`;
  const { core, api } = apiOf(builder);
  try {
    const { id } = await api.apps.create({ name });
    await release(api, id, files);
    if (sharedWith !== undefined) {
      await api.apps.members.add(id, {
        type: "person",
        id: sharedWith.userId,
        role: "user",
      });
    }
    return id;
  } finally {
    core[Symbol.dispose]();
  }
};

/**
 * The notes page, once it shows its notes. The first open of an App's
 * page builds it before the frame can show anything, which on a loaded
 * machine takes longer than the default 5 seconds.
 */
const openNotes = async (page: Page, app: string): Promise<FrameLocator> => {
  await page.goto(`/apps/${app}/full`);
  const appPage = page.frameLocator('iframe[title="App"]');
  await expect(appPage.getByRole("heading", { name: "Notes" })).toBeVisible({
    timeout: 20_000,
  });
  return appPage;
};

/** Creates a note in the page's create form. */
const createNote = async (
  appPage: FrameLocator,
  title: string,
  body = ""
): Promise<void> => {
  const form = appPage.getByRole("form", { name: "New note" });
  await form.getByLabel("Title").fill(title);
  await form.getByLabel("Body").fill(body);
  await form.getByRole("button", { name: "Create note" }).click();
};

test("a person creates, loads, edits and deletes notes, and two saves of different fields both stick", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("notesApp");
  const app = await notesApp(builder);
  const page = await pageOf(builder);
  const appPage = await openNotes(page, app);
  await expect(appPage.getByText("No notes yet.")).toBeVisible();

  // A title of only spaces fails the function's own check, in the
  // browser: nothing is sent, the field says why and gets focus.
  const create = appPage.getByRole("form", { name: "New note" });
  const title = create.getByLabel("Title");
  await createNote(appPage, "   ");
  await expect(title).toHaveAttribute("aria-invalid", "true");
  await expect(title).toBeFocused();
  await expect(appPage.getByText("No notes yet.")).toBeVisible();

  // Created as the host normalized it, the form reset after the commit,
  // and the list it reads refreshed.
  await createNote(appPage, "  Call Acme  ");
  const notes = appPage.getByRole("list", { name: "Notes" });
  await expect(notes.getByText("Call Acme", { exact: true })).toBeVisible();
  await expect(title).toHaveValue("");
  await expect(title).toHaveAttribute("aria-invalid", "false");
  await createNote(appPage, "Send the invoice", "Before Friday");
  await expect(notes.getByRole("listitem")).toHaveText([
    /Send the invoice/u,
    /Call Acme/u,
  ]);

  // An action that saves a note and then fails: the note it saved stays,
  // and the list shows it, though the action itself failed.
  await appPage.getByRole("button", { name: "Import a note" }).click();
  await expect(appPage.getByRole("status", { name: "Import" })).toHaveText(
    "The import stopped halfway."
  );
  await expect(notes.getByText("Imported", { exact: true })).toBeVisible();
  await appPage.getByRole("button", { name: "Delete Imported" }).click();
  await expect(notes.getByRole("listitem")).toHaveCount(2);

  // They are the App's records: a new session loads them again.
  await page.reload();
  const reloaded = await openNotes(page, app);
  const list = reloaded.getByRole("list", { name: "Notes" });
  await expect(list.getByRole("listitem")).toHaveCount(2);

  // Edited with explicit Save; the list follows the committed note, and
  // the editor opens again on it.
  await reloaded.getByRole("button", { name: "Edit Call Acme" }).click();
  const editor = reloaded.getByRole("form", { name: "Edit note" });
  await expect(editor.getByLabel("Title")).toHaveValue("Call Acme");
  await editor.getByLabel("Title").fill("Call Acme back");
  await editor.getByLabel("Body").fill("On Monday");
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(list.getByText("Call Acme back", { exact: true })).toBeVisible();
  await expect(editor.getByLabel("Body")).toHaveValue("On Monday");

  // The same note open in a second tab, both edits started from the same
  // note: the first tab changes its title, the second its body.
  const other = await pageOf(builder);
  const second = await openNotes(other, app);
  await second.getByRole("button", { name: "Edit Call Acme back" }).click();
  const draft = second.getByRole("form", { name: "Edit note" });
  await expect(draft.getByLabel("Title")).toHaveValue("Call Acme back");
  await draft.getByLabel("Body").fill("Their body");

  await editor.getByLabel("Title").fill("My title");
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(list.getByText("My title", { exact: true })).toBeVisible();

  // Another note chosen after a save opens that note, never the newer one
  // just saved: what is saved reaches it alone.
  await reloaded.getByRole("button", { name: "Edit Send the invoice" }).click();
  await expect(editor.getByLabel("Title")).toHaveValue("Send the invoice");
  await expect(editor.getByLabel("Body")).toHaveValue("Before Friday");
  await editor.getByLabel("Title").fill("Send the invoice today");
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(list.getByRole("listitem")).toHaveText([
    /Send the invoice today/u,
    /My title/u,
  ]);
  await reloaded.getByRole("button", { name: "Edit My title" }).click();
  await expect(editor.getByLabel("Title")).toHaveValue("My title");

  // The second tab's save sends only the body it changed: the first tab's
  // title stays, and the note it opens again on has both.
  await draft.getByRole("button", { name: "Save changes" }).click();
  await expect(draft.getByLabel("Title")).toHaveValue("My title");
  await expect(draft.getByLabel("Body")).toHaveValue("Their body");
  await expect(draft.getByRole("alert")).toHaveCount(0);
  await expect(list.getByText("My title", { exact: true })).toBeVisible();

  // Deleted, from the first tab, while the second still has it open.
  await reloaded.getByRole("button", { name: "Delete My title" }).click();
  await expect(list.getByRole("listitem")).toHaveText([/Send the invoice/u]);
  await expect(second.getByText("This note is gone.")).toBeVisible();
  await reloaded
    .getByRole("button", { name: "Delete Send the invoice" })
    .click();
  await expect(reloaded.getByText("No notes yet.")).toBeVisible();
});

test("a page whose page connects again as someone else is stopped, and the page loads again as them, sending nothing of the first person's", async ({
  pageOf,
}) => {
  // Someone else may use the App, so a save sent again under their cookie
  // would run, and commit, as them.
  const { first, next } = peopleIn("notesAppSwitch");
  const app = await notesApp(first, next);
  const page = await pageOf(first);

  // The page's one connection (this route has no shell), dropped at will,
  // and refused while the browser's cookie changes hands.
  let drop: (() => Promise<void>) | undefined;
  let refuse = false;
  await page.routeWebSocket("**/rpc", async (socket) => {
    if (refuse) {
      await socket.close();
      return;
    }
    socket.connectToServer();
    drop = async () => {
      await socket.close();
    };
  });
  // Saves are lost on the way while the first person's save is uncertain;
  // after that, every save that reaches core is counted.
  let loseSaves = true;
  let lost = 0;
  const reached: string[] = [];
  await page.route("**/api/app-functions/**", async (route) => {
    const body = route.request().postData() ?? "";
    if (body.includes('"idempotencyKey"')) {
      if (loseSaves) {
        lost += 1;
        await route.abort();
        return;
      }
      reached.push(body);
    }
    await route.continue();
  });

  const appPage = await openNotes(page, app);
  await expect(appPage.getByText("No notes yet.")).toBeVisible();
  // The first person's save: its answer lost, so the client sends it again
  // under the same key until the host answers.
  await createNote(appPage, "Mine");
  await expect.poll(() => lost).toBeGreaterThan(0);

  // The connection drops, and the browser's cookie becomes someone else's
  // (another tab signed in as them) before it connects again.
  const reloaded = page.waitForEvent("load", { timeout: 20_000 });
  refuse = true;
  await drop?.();
  await signInTo(page.context(), next);
  loseSaves = false;
  refuse = false;

  // Connected again as them: the tab's connection ends, the page is
  // stopped before anything else, and the page loads again, for the person
  // signed in now, without the first person's note. Nothing the first
  // person's page held reached core.
  await reloaded;
  const theirs = page.frameLocator('iframe[title="App"]');
  await expect(theirs.getByText("No notes yet.")).toBeVisible({
    timeout: 20_000,
  });
  expect(reached).toStrictEqual([]);
});

test("a page whose function call core refuses as someone else's is stopped, and the page loads again as them", async ({
  pageOf,
}) => {
  const { first, next } = peopleIn("notesAppTwoTabs");
  const app = await notesApp(first, next);
  const page = await pageOf(first);
  // What core answered each save: its status.
  const answered: number[] = [];
  page.on("response", (response) => {
    if (
      response.url().includes("/api/app-functions/") &&
      (response.request().postData() ?? "").includes('"idempotencyKey"')
    ) {
      answered.push(response.status());
    }
  });
  const appPage = await openNotes(page, app);
  await expect(appPage.getByText("No notes yet.")).toBeVisible();

  // Another tab signs in as someone else: the cookie changes, the page's
  // connection doesn't. The first person's save goes with their cookie.
  await signInTo(page.context(), next);
  const reloaded = page.waitForEvent("load", { timeout: 20_000 });
  await createNote(appPage, "Mine");

  // Core refused it as someone else's: the tab's connection ends, the
  // page is stopped before anything else, and the page loads again, for
  // the person signed in now, without the first person's note.
  await reloaded;
  expect(answered.length).toBeGreaterThan(0);
  expect(answered.every((status) => status === 401)).toBe(true);
  const theirs = page.frameLocator('iframe[title="App"]');
  await expect(theirs.getByText("No notes yet.")).toBeVisible({
    timeout: 20_000,
  });
});

test("a page whose person signed out is stopped and the page loads again, so nothing of theirs stays on it", async ({
  pageOf,
}) => {
  const { first } = peopleIn("notesAppSignedOut");
  const app = await notesApp(first);
  const page = await pageOf(first);
  let drop: (() => Promise<void>) | undefined;
  await page.routeWebSocket("**/rpc", (socket) => {
    socket.connectToServer();
    drop = async () => {
      await socket.close();
    };
  });
  const appPage = await openNotes(page, app);
  await createNote(appPage, "Private");
  await expect(
    appPage
      .getByRole("list", { name: "Notes" })
      .getByText("Private", { exact: true })
  ).toBeVisible();

  // Signed out elsewhere; the page hears of it when it connects again,
  // stops the page and loads again, and shows the session ended, with
  // no page in the frame.
  await endSession(first);
  const reloaded = page.waitForEvent("load", { timeout: 20_000 });
  await drop?.();
  await reloaded;
  await expect(page.getByText("Your session has ended")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('iframe[title="App"]')).not.toHaveAttribute(
    "src",
    /./u
  );
});

test("a note saved in one session appears on another session's open page without reloading", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("notesLive");
  const app = await notesApp(builder);
  const watching = await openNotes(await pageOf(builder), app);
  await expect(watching.getByText("No notes yet.")).toBeVisible();
  const saving = await openNotes(await pageOf(builder), app);

  // Saved in the second session: the first, which asks nothing, shows it.
  await createNote(saving, "Pushed to the other page");
  const notes = watching.getByRole("list", { name: "Notes" });
  await expect(
    notes.getByText("Pushed to the other page", { exact: true })
  ).toBeVisible();

  // An edit follows the same way, and so does a delete.
  await saving
    .getByRole("button", { name: "Edit Pushed to the other page" })
    .click();
  const editor = saving.getByRole("form", { name: "Edit note" });
  await editor.getByLabel("Title").fill("Edited elsewhere");
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(
    notes.getByText("Edited elsewhere", { exact: true })
  ).toBeVisible();
  await saving.getByRole("button", { name: "Delete Edited elsewhere" }).click();
  await expect(watching.getByText("No notes yet.")).toBeVisible();
});

test("a list loads five notes at a time and keeps the loaded notes current across sessions", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("notesPages");
  const app = await notesApp(builder);
  const watching = await openNotes(await pageOf(builder), app);
  await expect(watching.getByText("No notes yet.")).toBeVisible();
  const notes = watching.getByRole("list", { name: "Notes" });
  for (let note = 1; note <= 6; note += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one note after the other
    await createNote(watching, `Note ${note}`);
    // oxlint-disable-next-line no-await-in-loop -- see above
    await expect(
      notes.getByText(`Note ${note}`, { exact: true })
    ).toBeVisible();
  }

  // Five at first, newest first; the sixth once asked for.
  await expect(notes.getByRole("listitem")).toHaveText([
    /Note 6/u,
    /Note 5/u,
    /Note 4/u,
    /Note 3/u,
    /Note 2/u,
  ]);
  await watching.getByRole("button", { name: "Load more" }).click();
  await expect(notes.getByRole("listitem")).toHaveCount(6);
  await expect(watching.getByRole("button", { name: "Load more" })).toHaveCount(
    0
  );

  // Another session saves a note and deletes one inside the loaded list:
  // the open list follows, every note once, the rest closing up.
  const saving = await openNotes(await pageOf(builder), app);
  await createNote(saving, "Note 7");
  await expect(notes.getByRole("listitem")).toHaveCount(7);
  await saving.getByRole("button", { name: "Delete Note 4" }).click();
  await expect(notes.getByRole("listitem")).toHaveText([
    /Note 7/u,
    /Note 6/u,
    /Note 5/u,
    /Note 3/u,
    /Note 2/u,
    /Note 1/u,
  ]);
});

test("a page's frame speaks the page's language", async ({ pageOf }) => {
  const { builder } = peopleIn("notesLanguage");
  const app = await notesApp(builder);
  const page = await pageOf(builder, { locale: "de-DE" });
  await page.goto(`/apps/${app}/full`);
  const appPage = page.frameLocator("iframe");
  await expect(appPage.getByRole("heading", { name: "Notes" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(appPage.locator("html")).toHaveAttribute("lang", "de");
});

/** How long the activation a page has as a page opens can last. */
const openingActivationMs = 5000;

/** A 1×1 PNG, as a person's file picker hands it over. */
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

test("a person attaches a file to a note, previews and downloads it, and removes it", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("notesApp");
  const app = await notesApp(builder);
  const page = await pageOf(builder);
  const appPage = await openNotes(page, app);
  // Playwright's checks give the page activation as the page opens,
  // which the page takes for the click that opened it: one that admits
  // no download for as long as it can last (page-files.ts). The
  // person's clicks below keep the page's activation going all the while.
  await page.waitForTimeout(openingActivationMs);
  await createNote(appPage, "Trip");
  await appPage.getByRole("button", { name: "Edit Trip" }).click();
  const attachments = appPage.getByRole("region", { name: "Attachments" });
  const picker = attachments.getByLabel("Attach a file");

  // A type a browser would run is refused before any byte leaves the page.
  await picker.setInputFiles({
    name: "page.html",
    mimeType: "text/html",
    buffer: Buffer.from("<script>alert(1)</script>"),
  });
  await expect(
    attachments.getByRole("status", { name: "Attaching" })
  ).toContainText("Only PNG, JPEG, GIF and WebP images");
  await expect(attachments.getByRole("status", { name: "Upload" })).toHaveText(
    "failed"
  );

  // Uploaded, checked, attached at the note's revision, and previewed
  // from a URL of the frame's own.
  await picker.setInputFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: pixel,
  });
  await expect(
    attachments.getByRole("status", { name: "Attaching" })
  ).toHaveText("Attached photo.png.");
  const files = attachments.getByRole("list", { name: "Attached files" });
  await expect(files.getByText("photo.png", { exact: true })).toBeVisible();
  await expect(files.getByText(`${pixel.length} bytes`)).toBeVisible();
  await expect(
    files.getByRole("img", { name: "Preview of photo.png" })
  ).toHaveAttribute("src", /^blob:/u);

  // Downloaded through the page, by the browser's own download.
  const downloading = page.waitForEvent("download");
  await files.getByRole("button", { name: "Download photo.png" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("photo.png");
  // The bytes uploaded, whole, and a preview that decodes.
  const saved = await download.path();
  expect(await readFile(saved)).toStrictEqual(pixel);
  await expect
    .poll(
      async () =>
        await files
          .getByRole("img", { name: "Preview of photo.png" })
          .evaluate((image: HTMLImageElement) => image.naturalWidth)
    )
    .toBeGreaterThan(0);

  // Removed from the note and deleted.
  await files.getByRole("button", { name: "Remove photo.png" }).click();
  await expect(files.getByRole("listitem")).toHaveCount(0);
  await expect(
    attachments.getByRole("status", { name: "Attaching" })
  ).toHaveText("Removed photo.png.");
});

test("a page can't download a file nobody clicked for", async ({ pageOf }) => {
  const { builder } = peopleIn("notesApp");
  const app = await notesApp(builder, undefined, unaskedDownloadFiles());
  const page = await pageOf(builder);
  await page.goto(`/apps/${app}/full`);
  const appPage = page.frameLocator('iframe[title="App"]');
  // Nothing touches the page while the page waits to download: Playwright
  // runs its checks with a user gesture, which would count as a click.
  await page.waitForTimeout(12_000);
  // A while after opening, with no click: refused by the page.
  await expect(
    appPage.getByRole("status", { name: "Unasked download" })
  ).toHaveText("file.gesture_required", { timeout: 20_000 });
  // After a click it goes on to core, which knows no such file.
  await appPage.getByRole("button", { name: "Download" }).click();
  await expect(
    appPage.getByRole("status", { name: "Asked download", exact: true })
  ).toHaveText("file.not_found");
});

/** Opens the file view page of `app`, its heading shown. */
const openFiles = async (page: Page, app: string): Promise<FrameLocator> => {
  await page.goto(`/apps/${app}/full`);
  const appPage = page.frameLocator('iframe[title="App"]');
  await expect(appPage.getByRole("heading", { name: "Files" })).toBeVisible({
    timeout: 20_000,
  });
  return appPage;
};

test("a file shown is read once, however often its page renders", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("notesApp");
  const app = await notesApp(builder, undefined, fileViewFiles());
  const page = await pageOf(builder);
  const appPage = await openFiles(page, app);
  await appPage
    .getByLabel("Upload a file")
    .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: pixel });
  await expect(
    appPage.getByText("Showing photo.png, rendered 0")
  ).toBeVisible();
  let reads = 0;
  page.on("request", (request) => {
    if (request.url().includes("/files/files/")) {
      reads += 1;
    }
  });
  const again = appPage.getByRole("button", { name: "Render again" });
  await again.click();
  await again.click();
  await again.click();
  await expect(
    appPage.getByText("Showing photo.png, rendered 3")
  ).toBeVisible();
  await page.waitForTimeout(1000);
  expect(reads).toBe(0);
});

test("a file hidden, then shown again, loads afresh instead of its last view", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("notesApp");
  const app = await notesApp(builder, undefined, fileViewFiles());
  const page = await pageOf(builder);
  const appPage = await openFiles(page, app);
  await appPage
    .getByLabel("Upload a file")
    .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: pixel });
  await expect(appPage.getByText("Showing photo.png")).toBeVisible();
  await appPage.getByRole("button", { name: "Hide the file" }).click();
  await expect(appPage.getByText("The file is hidden")).toBeVisible();
  // The next read is held back a moment on its way to core.
  const { promise: released, resolve: letThrough } =
    Promise.withResolvers<null>();
  await page.route("**/api/app-files/*/files/files/**", async (route) => {
    await released;
    await route.continue();
  });
  await appPage.getByRole("button", { name: "Show the file" }).click();
  await expect(appPage.getByText("Loading the file…")).toBeVisible();
  await expect(appPage.getByText("Showing photo.png")).toHaveCount(0);
  letThrough(null);
  await expect(appPage.getByText("Showing photo.png")).toBeVisible();
});

test("a file the page deletes while showing it is gone, never read again or a failure", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("notesApp");
  const app = await notesApp(builder, undefined, fileViewFiles());
  const page = await pageOf(builder);
  const appPage = await openFiles(page, app);
  await appPage
    .getByLabel("Upload a file")
    .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: pixel });
  await expect(appPage.getByText("Showing photo.png")).toBeVisible();
  const reads: string[] = [];
  page.on("request", (request) => {
    // A read of the file (its deletion is a POST).
    if (request.method() === "GET" && request.url().includes("/files/")) {
      reads.push(request.url());
    }
  });
  // Still shown when its deletion lands, as a row is until the change
  // that removes it reaches the page's own data.
  await appPage.getByRole("button", { name: "Delete the file" }).click();
  await expect(appPage.getByRole("status", { name: "Deletion" })).toHaveText(
    "deleted"
  );
  await expect(appPage.getByText("The file is gone")).toBeVisible();
  await expect(appPage.getByRole("heading", { name: "Files" })).toBeVisible();
  // Hidden, then shown again: still gone, not read again.
  await appPage.getByRole("button", { name: "Hide the file" }).click();
  await expect(appPage.getByText("The file is hidden")).toBeVisible();
  await appPage.getByRole("button", { name: "Show the file" }).click();
  await expect(appPage.getByText("The file is gone")).toBeVisible();
  await page.waitForTimeout(1000);
  expect(reads).toStrictEqual([]);
});

test("a file whose page lost the App's data shows the refusal, and isn't read again", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("notesApp");
  const app = await notesApp(builder, undefined, fileViewFiles());
  const page = await pageOf(builder);
  const appPage = await openFiles(page, app);
  const picker = appPage.getByLabel("Upload a file");
  await picker.setInputFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: pixel,
  });
  await expect(appPage.getByText("Showing photo.png")).toBeVisible();
  // The App's release is revoked: its build gets none of the App's data,
  // and the next thing the page asks is refused. The page then asks
  // core about the build at once, and stops the page: the refusal the
  // person is left with is the page's, not the page's own, which shows
  // only until then.
  await revokeNewestRelease(app);
  let reads = 0;
  page.on("request", (request) => {
    if (request.url().includes("/files/files/")) {
      reads += 1;
    }
  });
  // The page's own refusal of a revoked release (the page's or the
  // version's, whichever it hears first).
  const refusal = page.getByText(/^This version of the App was revoked/u);
  // The upload makes the page ask, but it may have asked already: its
  // live data is refused the same way the moment the release is
  // revoked, and the page then stops the page, its picker with it. So
  // whichever comes first: the refusal, or the upload that brings it.
  const uploaded = async (): Promise<void> => {
    try {
      await picker.setInputFiles({
        name: "again.png",
        mimeType: "image/png",
        buffer: pixel,
      });
    } catch {
      // The page was stopped first: there was nothing left to upload to.
    }
  };
  const upload = uploaded();
  await Promise.race([refusal.waitFor(), upload]);
  await expect(refusal).toBeVisible();
  await expect(page.locator('iframe[title="App"]')).not.toHaveAttribute("src");
  await page.waitForTimeout(3000);
  expect(reads).toBe(0);
});

/**
 * How long the links page's later open waits after its click (6 s),
 * with room for its check: past any activation the click left.
 */
const laterOpenWaitMs = 9000;

/** Opens the links page of `app`, its heading shown. */
const openLinks = async (page: Page, app: string): Promise<FrameLocator> => {
  await page.goto(`/apps/${app}/full`);
  const appPage = page.frameLocator('iframe[title="App"]');
  await expect(appPage.getByRole("heading", { name: "Links" })).toBeVisible({
    timeout: 20_000,
  });
  return appPage;
};

test("a page opens its declared help site on a click, with no opener or referrer, and only with the person's say otherwise", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("notesApp");
  const app = await notesApp(builder, undefined, linksFiles());
  // An admin judged its data fine to go out in a link: a click opens one
  // at once (core's app-link-route.ts; otherwise each link is confirmed).
  await ordinaryData(app);
  const page = await pageOf(builder);
  // The help site, as the browser reaches it: what each visit sent.
  const visits: { url: string; referer: string | undefined }[] = [];
  await page.context().route("https://help.example.com/**", async (route) => {
    visits.push({
      url: route.request().url(),
      referer: route.request().headers().referer,
    });
    await route.fulfill({
      contentType: "text/html",
      body: "<title>Help</title><p>Help</p>",
    });
  });
  const appPage = await openLinks(page, app);
  // The activation Playwright gave the page as it opened is the page's
  // own: it admits no link for as long as it can last (page-files.ts).
  await page.waitForTimeout(openingActivationMs);
  const dialog = page.getByRole("alertdialog");

  // A click in the page: opened at once, in a tab of its own.
  const opening = page.context().waitForEvent("page");
  await appPage.getByRole("button", { name: "Open help", exact: true }).click();
  const tab = await opening;
  await tab.waitForLoadState();
  await expect(appPage.getByRole("status", { name: "Link" })).toHaveText(
    "opened"
  );
  await expect(dialog).toBeHidden();
  expect({
    url: tab.url(),
    opener: await tab.evaluate(() => window.opener === null),
    referrer: await tab.evaluate(() => document.referrer),
  }).toStrictEqual({
    url: "https://help.example.com/guide",
    opener: true,
    referrer: "",
  });
  await tab.close();

  // Long after the click: the page asks, naming the origin; turned down,
  // nothing opens. Nothing touches the page while the page waits to
  // open: Playwright runs its checks with a user gesture, which the page
  // would take for the person's.
  await appPage.getByRole("button", { name: "Open help later" }).click();
  await page.waitForTimeout(laterOpenWaitMs);
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog).toContainText("https://help.example.com");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(appPage.getByRole("status", { name: "Link" })).toHaveText(
    "link.declined"
  );

  // Asked again (after the pause a turned-down link starts), confirmed:
  // opened.
  await page.waitForTimeout(5000);
  await appPage.getByRole("button", { name: "Open help later" }).click();
  await page.waitForTimeout(laterOpenWaitMs);
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  const confirmed = page.context().waitForEvent("page");
  await dialog.getByRole("button", { name: "Open", exact: true }).click();
  const later = await confirmed;
  await later.waitForLoadState();
  expect(later.url()).toBe("https://help.example.com/later");
  await expect(appPage.getByRole("status", { name: "Link" })).toHaveText(
    "opened"
  );

  // A site it didn't declare, written to pass for its own: refused.
  await appPage.getByRole("button", { name: "Open elsewhere" }).click();
  await expect(appPage.getByRole("status", { name: "Link" })).toHaveText(
    "link.not_allowed"
  );
  expect(visits).toStrictEqual([
    { url: "https://help.example.com/guide", referer: undefined },
    { url: "https://help.example.com/later", referer: undefined },
  ]);
});
