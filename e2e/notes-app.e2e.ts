import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { notesAppFiles } from "./notes-app.ts";
import { apiOf, pageOf, peopleIn, release } from "./people.ts";

// The Notes App end to end on the platform's own runtime and React SDK:
// a builder's App of spec 8's layout, sealed and current, its screen in
// its sandboxed frame reading and writing the App's store through the
// session client the platform mounts (`useQuery`, `useMutation` and the
// generated `#grasp` references). What a lost answer, a cancelled save or
// a reused key does is core's own test, through the same client
// (apps/core/test/screen-client.test.ts).

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
const openNotes = async (page: Page, app: string) => {
  await page.goto(`/engines/${app}/apps/notes/full`);
  const screen = page.frameLocator('iframe[title="notes app"]');
  await expect(screen.getByRole("heading", { name: "Notes" })).toBeVisible({
    timeout: 20_000,
  });
  return screen;
};

test("a person creates, loads and deletes notes through the App's own operations", async ({
  browser,
}) => {
  const { builder } = peopleIn("notesApp");
  const app = await notesApp(builder);
  const page = await pageOf(browser, builder);
  const screen = await openNotes(page, app);
  await expect(screen.getByText("No notes yet.")).toBeVisible();

  // Each confirmed create refreshes the list the screen reads.
  const title = screen.getByLabel("Title");
  await title.fill("  Call Acme  ");
  await screen.getByRole("button", { name: "Create note" }).click();
  const notes = screen.getByRole("list", { name: "Notes" });
  // The host trimmed the title, as the operation's arguments declare.
  await expect(notes.getByText("Call Acme", { exact: true })).toBeVisible();
  await expect(title).toHaveValue("");
  await title.fill("Send the invoice");
  await screen.getByRole("button", { name: "Create note" }).click();
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

  await reloaded
    .getByRole("button", { name: "Delete Send the invoice" })
    .click();
  await expect(list.getByRole("listitem")).toHaveText([/Call Acme/u]);
  await reloaded.getByRole("button", { name: "Delete Call Acme" }).click();
  await expect(reloaded.getByText("No notes yet.")).toBeVisible();
});
