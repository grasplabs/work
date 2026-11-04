import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";

// An engine's declared permissions and their bindings, end to end in a
// real browser: a builder's engine declares `ai`, which its action asks;
// an admin finds it unbound on the engine's page, binds it to a model and
// revokes the binding, while the builder sees each state and nothing to
// act on. That the action's next request is refused once the binding is
// revoked, and served while it stands, is core's own test, at the
// request's boundary (resource-bindings.test.ts): the review this page
// shows resolves a binding exactly as that request does.

/** The engine's files: an action that asks its `ai`. */
const writerFiles = (): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({ notes: defineTable({ title: v.string() }) });
`,
  "operations/desk.ts": `import { permission, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const ai = permission.ai({ maxOutputTokens: 200 });

export const draft = action({
  args: {},
  returns: v.string(),
  uses: [ai],
  handler: async (ctx) => await ctx.ai.generate({ prompt: "Draft a greeting." }),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { ai, draft } from "./operations/desk.ts";
import schema from "./schema.ts";

export default app({
  name: "Desk",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { desk: { draft } },
  internalOperations: {},
  screens: [],
  permissions: { ai },
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
    // Published, for the people it is shared with (a draft is its
    // builders' alone).
    await api.apps.publish(id);
    return id;
  } finally {
    core[Symbol.dispose]();
  }
};

/** The App's permission `alias`, under Connections in its settings. */
const resourceOn = async (page: Page, app: string, alias: string) => {
  await page.goto(`/apps/${app}/settings?section=connections`);
  return page
    .getByRole("region", { name: "Resources" })
    .getByRole("article", { name: alias });
};

const unbound = "The App's actions can't use it until an admin binds it.";

test("an admin binds an engine's AI to a model, with no budget of its own, and revokes it; its builder only sees", async ({
  pageOf,
}) => {
  const { builder, admin } = peopleIn("resourceBindings");
  const app = await engineOf(builder, writerFiles());

  // Declared, and so far bound to nothing.
  const deciding = await pageOf(admin);
  const ai = await resourceOn(deciding, app, "ai");
  await expect(ai).toContainText(unbound);
  await expect(ai).toContainText("desk.draft");
  const form = ai.getByRole("form", { name: "Bind ai" });
  // A model binding is the model alone: no cap or alert to set.
  await expect(form.getByLabel(/US dollars|percent/u)).toHaveCount(0);
  await form.getByRole("button", { name: "Bind ai" }).click();
  await expect(ai).toContainText("Bound to");
  await expect(ai).not.toContainText(unbound);
  await expect(
    form.getByRole("button", { name: "Replace the binding of ai" })
  ).toBeVisible();

  // The builder sees it bound, and nothing to bind or revoke.
  const building = await pageOf(builder);
  const seen = await resourceOn(building, app, "ai");
  await expect(seen).toContainText("Bound to");
  await expect(seen.getByRole("button")).toHaveCount(0);
  await expect(seen.getByRole("form")).toHaveCount(0);

  // Revoked, once confirmed: unbound again, for the admin and the builder
  // alike.
  await ai.getByRole("button", { name: "Revoke the binding of ai" }).click();
  const confirm = deciding.getByRole("dialog", {
    name: "Revoke the binding of ai?",
  });
  await confirm.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(ai).toContainText(unbound);
  await expect(ai).not.toContainText("Bound to");
  await building.reload();
  await expect(
    building
      .getByRole("region", { name: "Resources" })
      .getByRole("article", { name: "ai" })
  ).toContainText(unbound);
});
