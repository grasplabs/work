import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, pageOf, peopleIn, release } from "./people.ts";
import { writerAppFiles } from "./writer-app.ts";

// A streaming action end to end (spec 10.7.6): a screen in its sandboxed
// frame follows the action through `useStream`, the page relaying its
// frames from core one at a time; the person sees each whole snapshot,
// then the result, and can cancel a run. What a lost connection, another
// person or a revoked build does is core's own test
// (apps/core/test/screen-stream.test.ts).

test("a person watches a draft stream in, then cancels a slow one", async ({
  browser,
}) => {
  const { builder } = peopleIn("writerApp");
  const name = `Writer ${crypto.randomUUID().slice(0, 8)}`;
  const { core, api } = apiOf(builder);
  let app: string;
  try {
    const { id } = await api.apps.create({ name });
    await release(api, id, writerAppFiles(), name);
    app = id;
  } finally {
    core[Symbol.dispose]();
  }
  const page = await pageOf(browser, builder);
  await page.goto(`/engines/${app}/apps/writer/full`);
  const screen = page.frameLocator('iframe[title="writer app"]');
  await expect(screen.getByRole("heading", { name: "Writer" })).toBeVisible({
    timeout: 20_000,
  });
  const status = screen.getByRole("status");
  const draft = screen.getByLabel("Draft");
  await expect(status).toHaveText("idle");

  await screen.getByRole("button", { name: "Write", exact: true }).click();
  // A whole snapshot so far, then the result.
  await expect(draft).toHaveText(/^A draft/u);
  await expect(status).toHaveText("completed", { timeout: 15_000 });
  await expect(draft).toHaveText("A draft about launch.");
  const finished = screen.getByLabel("Finished");
  const refused = screen.getByLabel("Refused");
  await expect(finished).toHaveText("1");

  // Refused before it starts: nothing runs, and the view stays as it was.
  await screen.getByRole("button", { name: "Write, stopped already" }).click();
  await expect(refused).toHaveText("submission.cancelled");
  await screen
    .getByRole("button", { name: "Write with a wrong option" })
    .click();
  await expect(refused).toHaveText("TypeError");
  await expect(status).toHaveText("completed");
  await expect(finished).toHaveText("1");

  // A new run starts clean, and the person can cancel it.
  await screen.getByRole("button", { name: "Write slowly" }).click();
  await expect(status).toHaveText("running");
  await expect(draft).toHaveText("A");
  await screen.getByRole("button", { name: "Cancel" }).click();
  await expect(status).toHaveText("cancelled", { timeout: 15_000 });
  await expect(draft).toHaveText("A");

  // Switching to another action mid-run lets go of the run: the view
  // starts again, and the other action runs at once.
  await screen.getByRole("button", { name: "Write slowly" }).click();
  await expect(draft).toHaveText("A");
  await screen.getByRole("button", { name: "Outline instead" }).click();
  await expect(status).toHaveText("idle");
  await expect(draft).toHaveText("");
  await screen.getByRole("button", { name: "Write", exact: true }).click();
  await expect(status).toHaveText("completed", { timeout: 15_000 });
  await expect(draft).toHaveText("An outline about launch.");
});
