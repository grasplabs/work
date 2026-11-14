import { definitionText } from "@grasp-os/runtime/definition";
import { expect } from "@playwright/test";

import { publishApp, testApp } from "../apps/core/test/app-definitions.ts";
import { test } from "./csp.ts";
import { writeDraft } from "./draft-writes.ts";
import { apiOf, peopleIn } from "./people.ts";

// A chat's agent builds an App's draft, and a builder publishes it from
// the App's workspace: the draft checked and live as the App's next
// version, in one step. The local stack reaches no model,
// so the draft is written straight into core's database, as the agent's
// `env.build.write` leaves it (draft-writes.ts); the agent's writes and
// checks, and what a publish refuses, are core's tests
// (apps/core/test/agent-builds.test.ts).

/**
 * What the chat's agent adds to the desk, of spec 8's layout: an invoices
 * table, and a mutation that books one, which changes the App's data.
 */
const invoices = testApp(
  {
    name: "Invoice desk",
    tables: {
      invoices: {
        fields: { total: "v.number()" },
        access: { read: "appMembers", write: "appMembers" },
      },
    },
  },
  {
    "server/invoices.ts": `import { v } from "@grasp-os/sdk";
import { mutation } from "@server/_generated/server";

export const book = mutation({
  args: { total: v.number() },
  returns: v.id("invoices"),
  handler: async (ctx, args) => await ctx.db.insert("invoices", args),
});
`,
  }
);

/**
 * The desk's page, as its builders' lint wants it (a function component
 * as an arrow function): publishing checks every file of the draft, the
 * version's own included.
 */
const appPage = `import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@grasp-os/ui/components/button";

const Desk = () => (
  <main className="flex flex-col gap-4 p-6">
    <Button variant="outline">Approve</Button>
  </main>
);

export const Route = createFileRoute("/")({ component: Desk });
`;

test("a builder publishes the draft a chat built from the App's workspace, which makes it the App's next version, live", async ({
  pageOf,
}) => {
  const { builder, user } = peopleIn("chatBuilds");
  const { core, api } = apiOf(builder);
  const tag = crypto.randomUUID().slice(0, 8);
  const name = `Invoice desk ${tag}`;
  try {
    const app = await api.apps.create({ name });
    const { version } = await publishApp(
      api,
      app.id,
      testApp({ name: "Invoice desk" }, { "src/routes/index.tsx": appPage })
    );
    // Shared with a colleague, who uses the live version.
    await api.apps.members.add(app.id, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    // The chat's agent adds the desk's invoices, a table and a mutation, to
    // the draft.
    const chat = await api.chats.create(`Build ${tag}`);
    await writeDraft(
      builder.userId,
      chat.id,
      app.id,
      version,
      invoices.files,
      definitionText(invoices.definition)
    );

    const page = await pageOf(builder);
    await page.goto(`/apps/${app.id}`);
    // The changes only its builder sees, under the bar: Share changes
    // makes them the App's next version, for everyone it is shared with.
    await expect(page.getByText(/^\d+ changes? only you see$/u)).toBeVisible({
      timeout: 20_000,
    });
    await page
      .getByRole("button", { name: "Share changes" })
      .click({ timeout: 20_000 });
    // Its sheet: Share, once the changes are checked.
    await page
      .getByRole("dialog", { name: `Share ${name}` })
      .getByRole("button", { name: "Share", exact: true })
      .click({ timeout: 20_000 });
    await expect(page.getByText("Your changes are shared")).toBeVisible();

    // Live as the App's next version; the draft starts over from it.
    await expect
      .poll(
        async () => {
          const { currentVersion } = await api.apps.get(app.id);
          return currentVersion;
        },
        { timeout: 20_000 }
      )
      .toBeGreaterThan(version);
    const live = await api.apps.get(app.id);
    expect(await api.drafts.get({ kind: "app", id: app.id })).toMatchObject({
      base: live.currentVersion,
      changed: [],
    });
  } finally {
    core[Symbol.dispose]();
  }
});
