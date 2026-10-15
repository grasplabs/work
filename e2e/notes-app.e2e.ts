import { expect } from "@playwright/test";
import type { FrameLocator, Page } from "@playwright/test";

import { test } from "./csp.ts";
import { notesAppFiles } from "./notes-app.ts";
import {
  apiOf,
  endSession,
  pageOf,
  peopleIn,
  release,
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

/** A builder's new Notes App, released, and shared with `sharedWith`. */
const notesApp = async (
  builder: Parameters<typeof apiOf>[0],
  sharedWith?: { userId: string }
): Promise<string> => {
  const name = `Notes ${crypto.randomUUID().slice(0, 8)}`;
  const { core, api } = apiOf(builder);
  try {
    const { id } = await api.apps.create({ name });
    await release(api, id, notesAppFiles(), name);
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
  browser,
}) => {
  const { builder } = peopleIn("notesApp");
  const app = await notesApp(builder);
  const page = await pageOf(browser, builder);
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
  const other = await pageOf(browser, builder);
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

test("a screen whose page connects again as someone else is stopped, and sends nothing of the first person's as them", async ({
  browser,
}) => {
  // Someone else may use the App and its data is ordinary, so a save sent
  // again under their cookie would run, and commit, as them.
  const { first, next } = peopleIn("notesAppSwitch");
  const app = await notesApp(first, next);
  const page = await pageOf(browser, first);

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
  refuse = true;
  await drop?.();
  await signInTo(page.context(), next);
  loseSaves = false;
  refuse = false;

  // Connected again as them: the screen is stopped and its frame emptied,
  // and nothing the first person's screen held reached core.
  await expect(
    page.getByText("Someone else signed in on this browser")
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('iframe[title="notes app"]')).not.toHaveAttribute(
    "src",
    /./u
  );
  expect(reached).toStrictEqual([]);

  // Tried again, the screen opens for the person signed in now, without
  // the first person's note.
  await page.getByRole("button", { name: "Try again" }).click();
  const theirs = page.frameLocator('iframe[title="notes app"]');
  await expect(theirs.getByText("No notes yet.")).toBeVisible({
    timeout: 20_000,
  });
  expect(reached).toStrictEqual([]);
});

test("a screen whose function call core refuses as someone else's is stopped, while its connection holds", async ({
  browser,
}) => {
  const { first, next } = peopleIn("notesAppTwoTabs");
  const app = await notesApp(first, next);
  const page = await pageOf(browser, first);
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
  await createNote(screen, "Mine");

  // Core refused it as someone else's, and the page stopped and emptied
  // the frame.
  await expect(
    page.getByText("Someone else signed in on this browser")
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('iframe[title="notes app"]')).not.toHaveAttribute(
    "src",
    /./u
  );
  expect(answered.length).toBeGreaterThan(0);
  expect(answered.every((status) => status === 401)).toBe(true);

  // Tried again, the screen opens for the person signed in now, without
  // the first person's note.
  await page.getByRole("button", { name: "Try again" }).click();
  const theirs = page.frameLocator('iframe[title="notes app"]');
  await expect(theirs.getByText("No notes yet.")).toBeVisible({
    timeout: 20_000,
  });
});

test("a screen whose person signed out is emptied, so nothing of theirs stays on the page", async ({
  browser,
}) => {
  const { first } = peopleIn("notesAppSignedOut");
  const app = await notesApp(first);
  const page = await pageOf(browser, first);
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

  // Signed out elsewhere; the page hears of it when it connects again.
  await endSession(first);
  await drop?.();
  await expect(page.getByText("Your session has ended")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('iframe[title="notes app"]')).not.toHaveAttribute(
    "src",
    /./u
  );
});

test("a note saved in one session appears on another session's open screen without reloading", async ({
  browser,
}) => {
  const { builder } = peopleIn("notesLive");
  const app = await notesApp(builder);
  const watching = await openNotes(await pageOf(browser, builder), app);
  await expect(watching.getByText("No notes yet.")).toBeVisible();
  const saving = await openNotes(await pageOf(browser, builder), app);

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
