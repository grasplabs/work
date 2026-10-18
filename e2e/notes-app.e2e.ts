import { readFile } from "node:fs/promises";

import { expect } from "@playwright/test";
import type { FrameLocator, Page } from "@playwright/test";

import { test } from "./csp.ts";
import {
  fileViewFiles,
  notesAppFiles,
  unaskedDownloadFiles,
} from "./notes-app.ts";
import {
  apiOf,
  endSession,
  peopleIn,
  release,
  sensitiveData,
  signInTo,
} from "./people.ts";

// The Notes App end to end on the platform's own runtime and React SDK: a
// builder's App of spec 8's layout, sealed and current, its screen in its
// sandboxed frame reading and writing the App's store through the session
// client the platform mounts, with the generated `#grasp` references, an
// operation-bound create form and a record editor with explicit Save.
// What a lost answer, a cancelled save or a reused key does is core's
// own test, through the same client (apps/core/test/screen-client.test.ts).
// A screen whose page connects again as someone else, or calls core once
// someone else signed in, is stopped before anything it holds is sent as
// them; one whose person signed out is emptied too.

/**
 * A builder's new Notes App of `files`, released, and shared with
 * `sharedWith`.
 */
const notesApp = async (
  builder: Parameters<typeof apiOf>[0],
  sharedWith?: { userId: string },
  files: Record<string, string> = notesAppFiles()
): Promise<string> => {
  const name = `Notes ${crypto.randomUUID().slice(0, 8)}`;
  const { core, api } = apiOf(builder);
  try {
    const { id } = await api.apps.create({ name });
    await release(api, id, files, name);
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
 * The notes screen, once it shows its notes. The first open of an App's
 * screen builds it before the frame can show anything, which on a loaded
 * machine takes longer than the default 5 seconds.
 */
const openNotes = async (page: Page, app: string): Promise<FrameLocator> => {
  await page.goto(`/engines/${app}/apps/notes/full`);
  const screen = page.frameLocator('iframe[title="notes app"]');
  await expect(screen.getByRole("heading", { name: "Notes" })).toBeVisible({
    timeout: 20_000,
  });
  return screen;
};

/** Creates a note in the screen's create form. */
const createNote = async (
  screen: FrameLocator,
  title: string,
  body = ""
): Promise<void> => {
  const form = screen.getByRole("form", { name: "New note" });
  await form.getByLabel("Title").fill(title);
  await form.getByLabel("Body").fill(body);
  await form.getByRole("button", { name: "Create note" }).click();
};

test("a person creates, loads, edits and deletes notes, and a stale save keeps the draft", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("notesApp");
  const app = await notesApp(builder);
  const page = await pageOf(builder);
  const screen = await openNotes(page, app);
  await expect(screen.getByText("No notes yet.")).toBeVisible();

  // A title of only spaces fails the operation's own check, in the
  // browser: nothing is sent, the field says why and gets focus.
  const create = screen.getByRole("form", { name: "New note" });
  const title = create.getByLabel("Title");
  await createNote(screen, "   ");
  await expect(title).toHaveAttribute("aria-invalid", "true");
  await expect(title).toBeFocused();
  await expect(screen.getByText("No notes yet.")).toBeVisible();

  // Created as the host normalized it, the form reset after the commit,
  // and the list it reads refreshed.
  await createNote(screen, "  Call Acme  ");
  const notes = screen.getByRole("list", { name: "Notes" });
  await expect(notes.getByText("Call Acme", { exact: true })).toBeVisible();
  await expect(title).toHaveValue("");
  await expect(title).toHaveAttribute("aria-invalid", "false");
  await createNote(screen, "Send the invoice", "Before Friday");
  await expect(notes.getByRole("listitem")).toHaveText([
    /Send the invoice/u,
    /Call Acme/u,
  ]);

  // An action that saves a note and then fails: the note it saved stays,
  // and the list shows it, though the action itself failed.
  await screen.getByRole("button", { name: "Import a note" }).click();
  await expect(screen.getByRole("status", { name: "Import" })).toHaveText(
    "The import stopped halfway."
  );
  await expect(notes.getByText("Imported", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Delete Imported" }).click();
  await expect(notes.getByRole("listitem")).toHaveCount(2);

  // They are the App's records: a new session loads them again.
  await page.reload();
  const reloaded = await openNotes(page, app);
  const list = reloaded.getByRole("list", { name: "Notes" });
  await expect(list.getByRole("listitem")).toHaveCount(2);

  // Edited with explicit Save; the list follows the committed note.
  await reloaded.getByRole("button", { name: "Edit Call Acme" }).click();
  const editor = reloaded.getByRole("form", { name: "Edit note" });
  await expect(editor.getByLabel("Title")).toHaveValue("Call Acme");
  await editor.getByLabel("Title").fill("Call Acme back");
  await editor.getByLabel("Body").fill("On Monday");
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(list.getByText("Call Acme back", { exact: true })).toBeVisible();
  await expect(editor.getByLabel("Body")).toHaveValue("On Monday");

  // The same note open in a second tab, its draft started from the same
  // revision. The first tab saves; the second's save is stale.
  const other = await pageOf(builder);
  const second = await openNotes(other, app);
  await second.getByRole("button", { name: "Edit Call Acme back" }).click();
  const draft = second.getByRole("form", { name: "Edit note" });
  await expect(draft.getByLabel("Title")).toHaveValue("Call Acme back");
  await draft.getByLabel("Title").fill("Their title");

  await editor.getByLabel("Title").fill("My title");
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(list.getByText("My title", { exact: true })).toBeVisible();

  await draft.getByRole("button", { name: "Save changes" }).click();
  await expect(draft.getByRole("alert")).toContainText("changed since");
  // The draft survived the refusal, unchanged.
  await expect(draft.getByLabel("Title")).toHaveValue("Their title");

  // Only a deliberate, confirmed reload gives it up for the latest version.
  await draft.getByRole("button", { name: "Load the latest version" }).click();
  const confirm = second.getByRole("alertdialog", {
    name: "Discard your changes?",
  });
  await confirm.getByRole("button", { name: "Discard and load" }).click();
  await expect(draft.getByLabel("Title")).toHaveValue("My title");
  await expect(draft.getByRole("alert")).toHaveCount(0);

  // Deleted, from the first tab.
  await reloaded.getByRole("button", { name: "Delete My title" }).click();
  await expect(list.getByRole("listitem")).toHaveText([/Send the invoice/u]);
  await expect(reloaded.getByText("This note is gone.")).toBeVisible();
  await reloaded
    .getByRole("button", { name: "Delete Send the invoice" })
    .click();
  await expect(reloaded.getByText("No notes yet.")).toBeVisible();
});

test("a screen whose page connects again as someone else is stopped, and the page loads again as them, sending nothing of the first person's", async ({
  pageOf,
}) => {
  // Someone else may use the App and its data is ordinary, so a save sent
  // again under their cookie would run, and commit, as them.
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

  const screen = await openNotes(page, app);
  await expect(screen.getByText("No notes yet.")).toBeVisible();
  // The first person's save: its answer lost, so the client sends it again
  // under the same key until the host answers.
  await createNote(screen, "Mine");
  await expect.poll(() => lost).toBeGreaterThan(0);

  // The connection drops, and the browser's cookie becomes someone else's
  // (another tab signed in as them) before it connects again.
  const reloaded = page.waitForEvent("load", { timeout: 20_000 });
  refuse = true;
  await drop?.();
  await signInTo(page.context(), next);
  loseSaves = false;
  refuse = false;

  // Connected again as them: the tab's connection ends, the screen is
  // stopped before anything else, and the page loads again, for the person
  // signed in now, without the first person's note. Nothing the first
  // person's screen held reached core.
  await reloaded;
  const theirs = page.frameLocator('iframe[title="notes app"]');
  await expect(theirs.getByText("No notes yet.")).toBeVisible({
    timeout: 20_000,
  });
  expect(reached).toStrictEqual([]);
});

test("a screen whose function call core refuses as someone else's is stopped, and the page loads again as them", async ({
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
  const screen = await openNotes(page, app);
  await expect(screen.getByText("No notes yet.")).toBeVisible();

  // Another tab signs in as someone else: the cookie changes, the page's
  // connection doesn't. The first person's save goes with their cookie.
  await signInTo(page.context(), next);
  const reloaded = page.waitForEvent("load", { timeout: 20_000 });
  await createNote(screen, "Mine");

  // Core refused it as someone else's: the tab's connection ends, the
  // screen is stopped before anything else, and the page loads again, for
  // the person signed in now, without the first person's note.
  await reloaded;
  expect(answered.length).toBeGreaterThan(0);
  expect(answered.every((status) => status === 401)).toBe(true);
  const theirs = page.frameLocator('iframe[title="notes app"]');
  await expect(theirs.getByText("No notes yet.")).toBeVisible({
    timeout: 20_000,
  });
});

test("a screen whose person signed out is stopped and the page loads again, so nothing of theirs stays on it", async ({
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
  const screen = await openNotes(page, app);
  await createNote(screen, "Private");
  await expect(
    screen
      .getByRole("list", { name: "Notes" })
      .getByText("Private", { exact: true })
  ).toBeVisible();

  // Signed out elsewhere; the page hears of it when it connects again,
  // stops the screen and loads again, and shows the session ended, with
  // no screen in the frame.
  await endSession(first);
  const reloaded = page.waitForEvent("load", { timeout: 20_000 });
  await drop?.();
  await reloaded;
  await expect(page.getByText("Your session has ended")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('iframe[title="notes app"]')).not.toHaveAttribute(
    "src",
    /./u
  );
});

test("a note saved in one session appears on another session's open screen without reloading", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("notesLive");
  const app = await notesApp(builder);
  const watching = await openNotes(await pageOf(builder), app);
  await expect(watching.getByText("No notes yet.")).toBeVisible();
  const saving = await openNotes(await pageOf(builder), app);

  // Saved in the second session: the first, which asks nothing, shows it.
  await createNote(saving, "Pushed to the other screen");
  const notes = watching.getByRole("list", { name: "Notes" });
  await expect(
    notes.getByText("Pushed to the other screen", { exact: true })
  ).toBeVisible();

  // An edit follows the same way, and so does a delete.
  await saving
    .getByRole("button", { name: "Edit Pushed to the other screen" })
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

/** Waits until the page keeps a draft holding `text` for the tab (sessionStorage). */
const draftKept = async (page: Page, text: string): Promise<void> => {
  await page.waitForFunction(
    (wanted) =>
      Object.keys(sessionStorage).some(
        (key) =>
          key.startsWith("grasp.form-drafts:") &&
          (sessionStorage.getItem(key) ?? "").includes(wanted)
      ),
    text
  );
};

test("a draft survives a newer note, a stale save and a refresh, and is re-applied on the latest version", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("notesDrafts");
  const app = await notesApp(builder);
  const mine = await pageOf(builder);
  const theirPage = await pageOf(builder);
  const theirs = await openNotes(theirPage, app);
  await createNote(theirs, "Plan", "First body");
  const list = theirs.getByRole("list", { name: "Notes" });
  await expect(list.getByText("Plan", { exact: true })).toBeVisible();

  // I start editing the title; someone else saves a new body meanwhile.
  let screen = await openNotes(mine, app);
  await screen.getByRole("button", { name: "Edit Plan" }).click();
  let editor = screen.getByRole("form", { name: "Edit note" });
  await editor.getByLabel("Title").fill("My plan");

  await theirs.getByRole("button", { name: "Edit Plan" }).click();
  const other = theirs.getByRole("form", { name: "Edit note" });
  await other.getByLabel("Body").fill("Their body");
  await other.getByRole("button", { name: "Save changes" }).click();
  await expect(other.getByLabel("Body")).toHaveValue("Their body");

  // The newer note arrives: my draft stays as it was, and I see what
  // changed beside what I changed.
  let changes = editor.getByRole("status").filter({
    hasText: "This changed since you started editing",
  });
  await expect(changes).toContainText("Latest version: Their body");
  await expect(changes).toContainText("Yours: My plan");
  // Each field changed shows both versions: what re-applying replaces.
  await expect(changes).toContainText("Latest version: Plan");
  await expect(changes).toContainText("Yours: First body");
  await expect(editor.getByLabel("Title")).toHaveValue("My plan");
  await expect(editor.getByLabel("Body")).toHaveValue("First body");

  // Re-applied on the latest version, then saved: both changes are kept.
  await changes
    .getByRole("button", { name: "Re-apply my changes to the latest version" })
    .click();
  await expect(editor.getByLabel("Title")).toHaveValue("My plan");
  await expect(editor.getByLabel("Body")).toHaveValue("Their body");
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(list.getByText("My plan", { exact: true })).toBeVisible();
  await expect(changes).toHaveCount(0);

  // An unsaved draft, then a refresh of the page: the draft comes back
  // when the note is opened again.
  await editor.getByLabel("Title").fill("Unsaved title");
  await draftKept(mine, "Unsaved title");
  // Someone else saves again before the refresh, on my saved note.
  await expect(other.getByLabel("Title")).toHaveValue("My plan");
  await other.getByLabel("Body").fill("Their second body");
  await other.getByRole("button", { name: "Save changes" }).click();
  await expect(changes).toContainText("Latest version: Their second body");
  await mine.reload();
  screen = await openNotes(mine, app);
  await screen.getByRole("button", { name: "Edit My plan" }).click();
  editor = screen.getByRole("form", { name: "Edit note" });
  changes = editor.getByRole("status").filter({
    hasText: "This changed since you started editing",
  });
  await expect(editor.getByLabel("Title")).toHaveValue("Unsaved title");
  await expect(editor.getByLabel("Body")).toHaveValue("Their body");

  // The restored draft still carries the revision it started from, older
  // than the note's, so my save is refused as stale and the draft stays,
  // until I re-apply it on the latest version.
  await expect(changes).toContainText("Latest version: Their second body");
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(editor.getByRole("alert")).toContainText("changed since");
  await expect(editor.getByLabel("Title")).toHaveValue("Unsaved title");
  await changes
    .getByRole("button", { name: "Re-apply my changes to the latest version" })
    .click();
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(list.getByText("Unsaved title", { exact: true })).toBeVisible();
  // The note as saved, read afresh: my title on their second body.
  const reread = await openNotes(theirPage, app);
  await reread.getByRole("button", { name: "Edit Unsaved title" }).click();
  const saved = reread.getByRole("form", { name: "Edit note" });
  await expect(saved.getByLabel("Title")).toHaveValue("Unsaved title");
  await expect(saved.getByLabel("Body")).toHaveValue("Their second body");

  // An unsaved draft, then my session ends in another tab: the next load
  // of this tab, as a browser restoring it would, finds no draft kept.
  await editor.getByLabel("Body").fill("Left behind");
  await draftKept(mine, "Left behind");
  const elsewhere = await mine.context().newPage();
  await elsewhere.goto("/");
  const signedOut = await elsewhere.evaluate(async () => {
    const response = await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return response.ok;
  });
  expect(signedOut).toBeTruthy();
  await mine.reload();
  await mine.waitForFunction(
    () =>
      !Object.keys(sessionStorage).some((key) =>
        key.startsWith("grasp.form-drafts:")
      )
  );

  // A tab the browser restored with my own drafts in it, signed out: the
  // page drops them as soon as it learns nobody is signed in, with no
  // screen open to do it.
  const restoredKey = `grasp.form-drafts:${encodeURIComponent(builder.userId)}:${encodeURIComponent(app)}`;
  await mine.evaluate((key) => {
    sessionStorage.setItem(
      key,
      JSON.stringify({ n1: { text: "Restored", at: Date.now() } })
    );
  }, restoredKey);
  await mine.goto("/");
  await mine.waitForFunction(
    (key) => sessionStorage.getItem(key) === null,
    restoredKey
  );
});

test("a screen's frame speaks the page's language", async ({ pageOf }) => {
  const { builder } = peopleIn("notesLanguage");
  const app = await notesApp(builder);
  const page = await pageOf(builder, { locale: "de-DE" });
  await page.goto(`/engines/${app}/apps/notes/full`);
  const screen = page.frameLocator("iframe");
  await expect(screen.getByRole("heading", { name: "Notes" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(screen.locator("html")).toHaveAttribute("lang", "de");
});

/** How long the activation a page has as a screen opens can last. */
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
  const screen = await openNotes(page, app);
  // Playwright's checks give the page activation as the screen opens,
  // which the page takes for the click that opened it: one that admits
  // no download for as long as it can last (screen-files.ts). The
  // person's clicks below keep the page's activation going all the while.
  await page.waitForTimeout(openingActivationMs);
  await createNote(screen, "Trip");
  await screen.getByRole("button", { name: "Edit Trip" }).click();
  const attachments = screen.getByRole("region", { name: "Attachments" });
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

test("a screen can't download a file nobody clicked for", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("notesApp");
  const app = await notesApp(builder, undefined, unaskedDownloadFiles());
  const page = await pageOf(builder);
  await page.goto(`/engines/${app}/apps/notes/full`);
  const screen = page.frameLocator('iframe[title="notes app"]');
  // Nothing touches the page while the screen waits to download: Playwright
  // runs its checks with a user gesture, which would count as a click.
  await page.waitForTimeout(12_000);
  // A while after opening, with no click: refused by the page.
  await expect(
    screen.getByRole("status", { name: "Unasked download" })
  ).toHaveText("file.gesture_required", { timeout: 20_000 });
  // After a click it goes on to core, which knows no such file.
  await screen.getByRole("button", { name: "Download" }).click();
  await expect(
    screen.getByRole("status", { name: "Asked download", exact: true })
  ).toHaveText("file.not_found");
});

/** Opens the file view screen of `app`, its heading shown. */
const openFiles = async (page: Page, app: string): Promise<FrameLocator> => {
  await page.goto(`/engines/${app}/apps/notes/full`);
  const screen = page.frameLocator('iframe[title="notes app"]');
  await expect(screen.getByRole("heading", { name: "Files" })).toBeVisible({
    timeout: 20_000,
  });
  return screen;
};

test("a file shown through another resource is loading until that read answers, never the last view", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("notesApp");
  const app = await notesApp(builder, undefined, fileViewFiles());
  const page = await pageOf(builder);
  const screen = await openFiles(page, app);
  await screen
    .getByLabel("Upload a file")
    .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: pixel });
  await expect(screen.getByText("Showing photo.png")).toBeVisible();
  // The read through photos is held back a moment on its way to core.
  const { promise: released, resolve: letThrough } =
    Promise.withResolvers<null>();
  await page.route("**/api/app-files/*/photos/**", async (route) => {
    await released;
    await route.continue();
  });
  await screen.getByRole("button", { name: "Through photos" }).click();
  await expect(screen.getByText("Loading the file…")).toBeVisible();
  await expect(screen.getByText("Showing photo.png")).toHaveCount(0);
  letThrough(null);
  // The read through photos answers, and the file is loading no more.
  await expect(screen.getByText("Loading the file…")).toHaveCount(0);
});

test("a file shown is read once, however often its screen renders", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("notesApp");
  const app = await notesApp(builder, undefined, fileViewFiles());
  const page = await pageOf(builder);
  const screen = await openFiles(page, app);
  await screen
    .getByLabel("Upload a file")
    .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: pixel });
  await expect(screen.getByText("Showing photo.png, rendered 0")).toBeVisible();
  let reads = 0;
  page.on("request", (request) => {
    if (request.url().includes("/attachments/files/")) {
      reads += 1;
    }
  });
  const again = screen.getByRole("button", { name: "Render again" });
  await again.click();
  await again.click();
  await again.click();
  await expect(screen.getByText("Showing photo.png, rendered 3")).toBeVisible();
  await page.waitForTimeout(1000);
  expect(reads).toBe(0);
});

test("a file hidden, then shown again, loads afresh instead of its last view", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("notesApp");
  const app = await notesApp(builder, undefined, fileViewFiles());
  const page = await pageOf(builder);
  const screen = await openFiles(page, app);
  await screen
    .getByLabel("Upload a file")
    .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: pixel });
  await expect(screen.getByText("Showing photo.png")).toBeVisible();
  await screen.getByRole("button", { name: "Hide the file" }).click();
  await expect(screen.getByText("The file is hidden")).toBeVisible();
  // The next read is held back a moment on its way to core.
  const { promise: released, resolve: letThrough } =
    Promise.withResolvers<null>();
  await page.route("**/api/app-files/*/attachments/files/**", async (route) => {
    await released;
    await route.continue();
  });
  await screen.getByRole("button", { name: "Show the file" }).click();
  await expect(screen.getByText("Loading the file…")).toBeVisible();
  await expect(screen.getByText("Showing photo.png")).toHaveCount(0);
  letThrough(null);
  await expect(screen.getByText("Showing photo.png")).toBeVisible();
});

test("a file the screen deletes while showing it is gone, never read again or a failure", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("notesApp");
  const app = await notesApp(builder, undefined, fileViewFiles());
  const page = await pageOf(builder);
  const screen = await openFiles(page, app);
  await screen
    .getByLabel("Upload a file")
    .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: pixel });
  await expect(screen.getByText("Showing photo.png")).toBeVisible();
  // Shown through photos, deleted through attachments: the same file, gone
  // through every resource that reads it.
  await screen.getByRole("button", { name: "Through photos" }).click();
  await expect(screen.getByText("Showing photo.png")).toBeVisible();
  const reads: string[] = [];
  page.on("request", (request) => {
    // A read of the file through either resource.
    if (request.method() === "GET" && request.url().includes("/files/")) {
      reads.push(request.url());
    }
  });
  // Still shown when its deletion lands, as a row is until the change
  // that removes it reaches the screen's own data.
  await screen.getByRole("button", { name: "Delete the file" }).click();
  await expect(screen.getByRole("status", { name: "Deletion" })).toHaveText(
    "deleted"
  );
  await expect(screen.getByText("The file is gone")).toBeVisible();
  await expect(screen.getByRole("heading", { name: "Files" })).toBeVisible();
  // Hidden, then shown again: still gone, not read again.
  await screen.getByRole("button", { name: "Hide the file" }).click();
  await expect(screen.getByText("The file is hidden")).toBeVisible();
  await screen.getByRole("button", { name: "Show the file" }).click();
  await expect(screen.getByText("The file is gone")).toBeVisible();
  await page.waitForTimeout(1000);
  expect(reads).toStrictEqual([]);
});

test("a file whose screen lost the App's data shows the refusal, and isn't read again", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("notesApp");
  const app = await notesApp(builder, undefined, fileViewFiles());
  const page = await pageOf(builder);
  const screen = await openFiles(page, app);
  const picker = screen.getByLabel("Upload a file");
  await picker.setInputFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: pixel,
  });
  await expect(screen.getByText("Showing photo.png")).toBeVisible();
  // The App's data is sensitive again: its build, approved by nobody,
  // gets none, and the next thing the screen asks is refused. The page
  // then asks core about the build at once, and stops the screen: the
  // refusal the person is left with is the page's, not the screen's own,
  // which shows only until then.
  await sensitiveData(app);
  let reads = 0;
  page.on("request", (request) => {
    if (request.url().includes("/attachments/files/")) {
      reads += 1;
    }
  });
  await picker.setInputFiles({
    name: "again.png",
    mimeType: "image/png",
    buffer: pixel,
  });
  await expect(
    page.getByText(
      "Nobody has approved this app's code for the domain's data yet."
    )
  ).toBeVisible();
  await expect(page.locator('iframe[title="notes app"]')).not.toHaveAttribute(
    "src"
  );
  await page.waitForTimeout(3000);
  expect(reads).toBe(0);
});
