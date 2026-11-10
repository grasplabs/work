import { expect } from "@playwright/test";

import {
  commitApp,
  testApp,
  withFiles,
} from "../apps/core/test/app-definitions.ts";
import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";

// The side panel of a chat shows the App being built: a version up for
// review, with what core says it changes, and a builder making it
// current from there. The local stack reaches no model, so the version is
// proposed through the builder's own API, as the chat's agent proposes
// one (`env.build.propose`); the agent's drafts, checks and proposals
// themselves are core's tests (apps/core/test/agent-builds.test.ts).

/**
 * The desk's data and functions, of spec 8's layout: an invoices table,
 * and a mutation that books one, which changes the App's data.
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
    "server/invoices.ts": `import { v } from "@grasp-os/runtime";
import { mutation } from "@server/_generated/server";

export const book = mutation({
  args: { total: v.number() },
  returns: v.id("invoices"),
  handler: async (ctx, args) => await ctx.db.insert("invoices", args),
});
`,
  }
);

const appPage = `import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@grasp-os/ui/components/button";

function Desk() {
  return (
    <main className="flex flex-col gap-4 p-6">
      <Button variant="outline">Approve</Button>
    </main>
  );
}
export const Route = createFileRoute("/")({ component: Desk });
`;

test("the side panel shows an App being built, and a builder makes its version current", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("chatBuilds");
  const { core, api } = apiOf(builder);
  const tag = crypto.randomUUID().slice(0, 8);
  const name = `Invoice desk ${tag}`;
  try {
    const app = await api.apps.create({ name });
    const { version } = await commitApp(
      api.apps.files,
      app.id,
      withFiles(invoices, { "src/routes/index.tsx": appPage }),
      "An invoice desk for invoices@"
    );
    await api.apps.versions.propose(app.id, version);
    const chat = await api.chats.create(`Build ${tag}`);

    const page = await pageOf(builder);
    await page.goto(`/?chat=${chat.id}`);
    await page.getByRole("button", { name: "Side panel" }).click();
    const built = page
      .getByRole("complementary", { name: "Side panel" })
      .getByRole("region", { name: "Being built" });
    await expect(built).toContainText(
      `${name}: version ${version} waiting for review`
    );
    await expect(built.getByRole("region", { name: "Files" })).toHaveText(
      /Added src\/routes\/index\.tsx/u
    );
    await expect(built).toContainText(
      "Nothing runs yet: this would be the App's first current version."
    );
    // Who proposed it, and the proposer's own words, labelled as such.
    await expect(built).toContainText("Committed by a person.");
    await expect(built.getByRole("blockquote")).toHaveText(
      "In the proposer's wordsAn invoice desk for invoices@"
    );
    const makeCurrent = built.getByRole("button", {
      name: `Make version ${version} current`,
      exact: true,
    });
    await expect(makeCurrent).toBeEnabled();

    await makeCurrent.click();
    await expect(built).toHaveCount(0);
    await expect
      .poll(async () => {
        const listed = await api.apps.list();
        return listed.find(({ id }) => id === app.id)?.currentVersion;
      })
      .toBe(version);
  } finally {
    core[Symbol.dispose]();
  }
});
