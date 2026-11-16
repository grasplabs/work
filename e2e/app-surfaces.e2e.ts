import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { navigationFiles, surfaceFiles } from "./notes-app.ts";
import { apiOf, peopleIn, release } from "./people.ts";

// An App's surfaces (spec 34.1) in a real browser: the App's sidebar
// entries, which stop once it is no longer shared, and its settings page.
// What core refuses is core's own tests (page-surfaces.test.ts).

const surfacedApp = async () => {
  const { builder } = peopleIn("appSurfaces");
  const name = `Surfaces ${crypto.randomUUID().slice(0, 8)}`;
  const { core, api } = apiOf(builder);
  try {
    const { id: app } = await api.apps.create({ name });
    await release(api, app, surfaceFiles());
    return { builder, name, app };
  } finally {
    core[Symbol.dispose]();
  }
};

test("an App's page stops once the App is no longer shared with the person", async ({
  pageOf,
}) => {
  const { builder, user } = peopleIn("appSurfaces");
  const name = `Surfaces ${crypto.randomUUID().slice(0, 8)}`;
  const owner = apiOf(builder);
  let app: string;
  try {
    ({ id: app } = await owner.api.apps.create({ name }));
    await release(owner.api, app, surfaceFiles());
    await owner.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
  } finally {
    owner.core[Symbol.dispose]();
  }
  const page = await pageOf(user);
  await page.clock.install();
  await page.goto("/");
  // A page of it, from its sidebar entry.
  await page
    .getByRole("list", { name: "From your Apps" })
    .getByRole("link", { name: "All notes" })
    .click();
  const main = page.locator('main iframe[title="App"]');
  await expect(
    page
      .frameLocator('main iframe[title="App"]')
      .getByRole("heading", { name: "Notes" })
  ).toBeVisible({ timeout: 20_000 });

  const again = apiOf(builder);
  try {
    await again.api.apps.members.remove(app, {
      type: "person",
      id: user.userId,
    });
  } finally {
    again.core[Symbol.dispose]();
  }
  // Unshared: the App's version subscription refuses the person, and the
  // page stops its pages, with no timer to wait for: its frame emptied, no
  // code of it running on behind the message.
  await expect(main).not.toHaveAttribute("src", { timeout: 20_000 });
});

test("an App's sidebar entry opens its page, and its settings page is its settings' Options", async ({
  pageOf,
}) => {
  const { builder, name, app } = await surfacedApp();
  const page = await pageOf(builder);
  await page.goto(`/apps/${app}/settings`);
  const shortcuts = page.getByRole("list", { name: "From your Apps" });
  await expect(shortcuts.getByRole("link", { name })).toBeVisible();
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  await sections.getByRole("link", { name: "Options" }).click();
  const settings = page.frameLocator('iframe[title="App"]');
  await expect(
    settings.getByRole("heading", { name: "Preferences" })
  ).toBeVisible({ timeout: 20_000 });

  await shortcuts
    .getByRole("listitem")
    .filter({ hasText: name })
    .getByRole("link", { name: "All notes" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/apps/${app}$`, "u"));
  await expect(page.locator('iframe[title="App"]')).toHaveCount(1);

  // An App without settings, its Options asked for by address: none to
  // list, and it says so.
  const { core, api } = apiOf(builder);
  let plain: string;
  try {
    ({ id: plain } = await api.apps.create({ name: `${name} plain` }));
    await release(api, plain, navigationFiles());
  } finally {
    core[Symbol.dispose]();
  }
  await page.goto(`/apps/${plain}/settings?section=options`);
  await expect(page.getByText("This App offers no options.")).toBeVisible();
  await expect(sections.getByRole("link", { name: "Options" })).toHaveCount(0);

  // A section the page doesn't know, by address, as text or as what reads
  // as a number: General.
  const general = sections.getByRole("link", { name: "General" });
  await page.goto(`/apps/${app}/settings?section=pages`);
  await expect(general).toHaveAttribute("aria-current", "page");
  await page.goto(`/apps/${app}/settings?section=1`);
  await expect(general).toHaveAttribute("aria-current", "page");
});
