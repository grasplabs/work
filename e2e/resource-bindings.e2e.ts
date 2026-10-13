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

/** The engine's files: an action that asks a model, `writer`. */
const writerFiles = (): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({ notes: defineTable({ title: v.string() }) });
`,
  "operations/desk.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const writer = resource.model("writer", { maxOutputTokens: 200 });

export const draft = action({
  args: {},
  returns: v.string(),
  uses: [writer],
  handler: async (ctx) =>
    await ctx.resources.writer.generate({ prompt: "Draft a greeting." }),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { draft, writer } from "./operations/desk.ts";
import schema from "./schema.ts";

export default app({
  name: "Desk",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { desk: { draft } },
  internalOperations: {},
  screens: [],
  uses: [writer],
});
`,
});

/** A builder's new engine of `files`, with its first version current. */
const engineOf = async (
  builder: Parameters<typeof apiOf>[0],
  files: Record<string, string>
): Promise<string> => {
  const name = `Desk ${crypto.randomUUID().slice(0, 8)}`;
  const { core, api } = apiOf(builder);
  try {
    const { id } = await api.apps.create({ name });
    const { version } = await api.apps.files.commit(id, files, name);
    await api.apps.versions.setCurrent(id, version);
    return id;
  } finally {
    core[Symbol.dispose]();
  }
};

/** The engine's resource `alias`, on its page's Resources tab. */
const resourceOn = async (page: Page, app: string, alias: string) => {
  await page.goto(`/engines/${app}`);
  await page.getByRole("tab", { name: "Resources" }).click();
  return page
    .getByRole("region", { name: "Resources" })
    .getByRole("article", { name: alias });
};

/** The engine's `letter` resource, on its page's Resources tab. */
const letterOn = async (page: Page, app: string) =>
  await resourceOn(page, app, "letter");

const unbound = "The engine's actions can't use it until an admin binds it.";

test("an admin binds an engine's declared template and revokes it; its builder only sees", async ({
  browser,
}) => {
  const { builder, admin } = peopleIn("resourceBindings");
  // Templates are the organization's: a contract of this run's own.
  const contract = `grasp.desk-${crypto.randomUUID().slice(0, 8)}@1`;
  const app = await engineOf(builder, deskFiles(contract));

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

  // Revoked, once confirmed: unbound again, for the admin and the builder
  // alike.
  await letter
    .getByRole("button", { name: "Revoke the binding of letter" })
    .click();
  const confirm = deciding.getByRole("dialog", {
    name: "Revoke the binding of letter?",
  });
  await confirm.getByRole("button", { name: "Revoke", exact: true }).click();
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

test("an admin binds an engine's model with a daily cap, and replacing it keeps the cap", async ({
  browser,
}) => {
  const { builder, admin } = peopleIn("resourceBindings");
  const app = await engineOf(builder, writerFiles());
  const page = await pageOf(browser, admin);
  const writer = await resourceOn(page, app, "writer");
  await expect(writer).toContainText(unbound);
  const form = writer.getByRole("form", { name: "Bind writer" });
  const perDay = form.getByLabel("Per day (UTC), in US dollars");
  const alertAt = form.getByLabel(
    "Alert admins at, in percent of a day's or month's cap"
  );
  // The alert means something only with a day's or a month's cap.
  await expect(alertAt).toBeDisabled();

  // Under a cent is refused before anything is sent, as core would.
  await perDay.fill("0.001");
  await form.getByRole("button", { name: "Bind writer" }).click();
  await expect(form.getByRole("alert")).toHaveText(
    "Enter an amount in US dollars from $0.01 to $1,000,000,000.00, such as 2.50."
  );
  await expect(perDay).toHaveAttribute("aria-invalid", "true");
  await expect(writer).toContainText(unbound);

  await perDay.fill("5");
  await alertAt.fill("90");
  await form.getByRole("button", { name: "Bind writer" }).click();
  await expect(writer).toContainText("Bound to");
  await expect(writer).toContainText("Per day$5.00");
  await expect(writer).toContainText("Alert at90% of a cap");
  await expect(writer).not.toContainText("Per month$");

  // The replace form starts on the binding's caps, so replacing it keeps
  // them unless the admin changes them.
  await expect(perDay).toHaveValue("5");
  await expect(alertAt).toHaveValue("90");
});
