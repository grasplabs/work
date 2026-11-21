import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn, release } from "./people.ts";
import { tallyFiles } from "./tally-app.ts";

// Blueprints, as people meet them in the browser: a builder saves an
// App's live version as a blueprint in its settings, and a builder it is
// shared with finds it among the ideas Make something offers for an App,
// which fills the box to ask Grasp to make one from it. Creating the App
// from a blueprint is Grasp's work from there, covered through core
// (apps/core/test/app-blueprints.test.ts, builtin-blueprints.test.ts).

test("a builder saves an App as a blueprint, and another finds it in Make something", async ({
  pageOf,
}) => {
  const { owner, maker } = peopleIn("blueprints");
  const name = `Tally ${crypto.randomUUID().slice(0, 8)}`;
  const { core, api } = apiOf(owner);
  let app: string;
  try {
    ({ id: app } = await api.apps.create({ name }));
    await release(api, app, tallyFiles("in the App"));
    // A role in the App, which finding its blueprint asks for.
    await api.apps.members.add(app, {
      type: "person",
      id: maker.userId,
      role: "user",
    });
  } finally {
    core[Symbol.dispose]();
  }

  const page = await pageOf(owner);
  await page.goto(`/apps/${app}/settings`);
  await page.getByRole("button", { name: "Save as blueprint" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Save as blueprint" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Saved as a blueprint" })
  ).toBeVisible();

  const theirs = await pageOf(maker);
  await theirs.goto("/?make=app");
  await theirs
    .getByRole("list", { name: "Ideas to start from" })
    .getByRole("button", { name, exact: true })
    .click();
  await expect(
    theirs.getByRole("textbox", { name: "Your question" })
  ).toContainText(`Make an App from the ${name} blueprint`);
});
