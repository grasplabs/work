import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, pageOf, peopleIn } from "./people.ts";

// An engine's declared resources and their bindings, end to end in a real
// browser: a builder's engine declares a template its action reads; an
// admin finds it unbound on the engine's page, publishes a version of
// its contract, binds it and revokes the binding, while the builder sees
// each state and nothing to act on. That the action's next request is
// refused once the binding is revoked, and served while it stands, is
// core's own test, at the request's boundary (resource-bindings.test.ts):
// the review this page shows resolves a binding exactly as that request
// does.

/** The engine's files: an action that reads a template of `contract`. */
const deskFiles = (contract: string): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({ notes: defineTable({ title: v.string() }) });
`,
  "operations/desk.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const letter = resource.template("letter", { contract: ${JSON.stringify(contract)} });

export const read = action({
  args: {},
  returns: v.number(),
  uses: [letter],
  handler: async (ctx) => {
    const template = await ctx.resources.letter.read();
    return template.version;
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { letter, read } from "./operations/desk.ts";
import schema from "./schema.ts";

export default app({
  name: "Desk",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { desk: { read } },
  internalOperations: {},
  screens: [],
  uses: [letter],
});
`,
});

/** The engine's `letter` resource, on its page's Resources tab. */
const letterOn = async (page: Page, app: string) => {
  await page.goto(`/engines/${app}`);
  await page.getByRole("tab", { name: "Resources" }).click();
  return page
    .getByRole("region", { name: "Resources" })
    .getByRole("article", { name: "letter" });
};

const unbound = "The engine's actions can't use it until an admin binds it.";

test("an admin binds an engine's declared template and revokes it; its builder only sees", async ({
  browser,
}) => {
  const { builder, admin } = peopleIn("resourceBindings");
  const name = `Desk ${crypto.randomUUID().slice(0, 8)}`;
  // Templates are the organization's: a contract of this run's own.
  const contract = `grasp.desk-${crypto.randomUUID().slice(0, 8)}@1`;
  const { core, api } = apiOf(builder);
  let app: string;
  try {
    ({ id: app } = await api.apps.create({ name }));
    const { version } = await api.apps.files.commit(
      app,
      deskFiles(contract),
      name
    );
    await api.apps.versions.setCurrent(app, version);
  } finally {
    core[Symbol.dispose]();
  }

  // Declared, and so far bound to nothing, with nothing published yet.
  const deciding = await pageOf(browser, admin);
  const letter = await letterOn(deciding, app);
  await expect(letter).toContainText(unbound);
  await expect(letter).toContainText(contract);
  await expect(letter).toContainText("desk.read");
  await expect(letter).toContainText(
    `Nothing is published for ${contract} yet. Publish it first.`
  );

  // The admin publishes a version of the contract and binds the letter.
  await letter.getByLabel("Content, as JSON").fill("{not json");
  await letter
    .getByRole("button", { name: `Publish a version of ${contract}` })
    .click();
  await expect(letter.getByRole("alert")).toHaveText("That isn't valid JSON.");
  await letter
    .getByLabel("Content, as JSON")
    .fill(JSON.stringify({ greeting: "Dear" }));
  await letter
    .getByRole("button", { name: `Publish a version of ${contract}` })
    .click();
  await expect(letter.getByLabel("Template version")).toContainText(
    "version 1"
  );
  await letter.getByRole("button", { name: "Bind letter" }).click();
  await expect(letter).toContainText("Bound to");
  await expect(letter).not.toContainText(unbound);

  // The builder sees it bound, and nothing to bind, publish or revoke.
  const building = await pageOf(browser, builder);
  const seen = await letterOn(building, app);
  await expect(seen).toContainText("Bound to");
  await expect(seen.getByRole("button")).toHaveCount(0);
  await expect(seen.getByRole("form")).toHaveCount(0);

  // Revoked: unbound again, for the admin and the builder alike.
  await letter
    .getByRole("button", { name: "Revoke the binding of letter" })
    .click();
  await expect(letter).toContainText(unbound);
  await expect(letter).not.toContainText("Bound to");
  await building.reload();
  await building.getByRole("tab", { name: "Resources" }).click();
  await expect(
    building
      .getByRole("region", { name: "Resources" })
      .getByRole("article", { name: "letter" })
  ).toContainText(unbound);
});
