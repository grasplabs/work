import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn, release } from "./people.ts";
import { tallyFiles } from "./tally-app.ts";

// Blueprints, as people make and use them: a builder saves an App's live
// version as a blueprint in its settings, and a builder it is shared
// with creates an App of their own from it, a copy of its code with none
// of its data, which they open.

test("a builder saves an App as a blueprint, and another creates an App from it, with none of its data", async ({
  pageOf,
}) => {
  const { owner, maker } = peopleIn("blueprints");
  const tag = crypto.randomUUID().slice(0, 8);
  const name = `Tally ${tag}`;
  const owned = apiOf(owner);
  let app: string;
  try {
    ({ id: app } = await owned.api.apps.create({ name }));
    await release(owned.api, app, tallyFiles("in the App"));
    // A role in the App, which creating from its blueprint asks for.
    await owned.api.apps.members.add(app, {
      type: "person",
      id: maker.userId,
      role: "user",
    });
  } finally {
    owned.core[Symbol.dispose]();
  }

  // The App has data of its own, which no copy gets.
  const page = await pageOf(owner);
  await page.goto(`/apps/${app}/full`);
  const own = page.frameLocator('iframe[title="App"]');
  await expect(own.getByRole("status")).toHaveText("0 in the App", {
    timeout: 30_000,
  });
  await own.getByRole("button", { name: "Add one" }).click();
  await expect(own.getByRole("status")).toHaveText("1 in the App");

  await page.goto(`/apps/${app}/settings`);
  await page.getByRole("button", { name: "Save as blueprint" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Save as blueprint" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Saved as a blueprint" })
  ).toBeVisible();

  const making = apiOf(maker);
  let copy: string;
  try {
    const listed = await making.api.apps.blueprints.list();
    const blueprint = listed.find((each) => each.app === app);
    if (blueprint === undefined) {
      throw new Error("The saved blueprint isn't listed for the maker");
    }
    const created = await making.api.apps.blueprints.create(blueprint.id, {
      name: `Copy ${tag}`,
    });
    copy = created.app.id;
    await making.api.versions.rollback({ kind: "app", id: copy }, 1);
  } finally {
    making.core[Symbol.dispose]();
  }

  const theirs = await pageOf(maker);
  await theirs.goto(`/apps/${copy}/full`);
  await expect(
    theirs.frameLocator('iframe[title="App"]').getByRole("status")
  ).toHaveText("0 in the App", { timeout: 30_000 });
});
