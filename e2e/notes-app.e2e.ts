import { expect } from "@playwright/test";
import type { FrameLocator, Page } from "@playwright/test";

import { test } from "./csp.ts";
import { notesAppFiles } from "./notes-app.ts";
import { apiOf, pageOf, peopleIn, release } from "./people.ts";

// The Notes App end to end on the platform's own runtime and React SDK: a
// builder's App of spec 8's layout, sealed and current, its screen in its
// sandboxed frame reading and writing the App's store through the session
// client the platform mounts, with the generated `#grasp` references, an
// operation-bound create form and a record editor with explicit Save.
// What a lost answer, a cancelled save or a reused key does is core's
// own test, through the same client (apps/core/test/screen-client.test.ts).

/** A builder's new Notes App, released. */
const notesApp = async (
  builder: Parameters<typeof apiOf>[0]
): Promise<string> => {
  const name = `Notes ${crypto.randomUUID().slice(0, 8)}`;
  const { core, api } = apiOf(builder);
  try {
    const { id } = await api.apps.create({ name });
    await release(api, id, notesAppFiles(), name);
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
