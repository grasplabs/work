import { expect } from "@playwright/test";

import { execute, quoted } from "./connections-seed.ts";
import { test } from "./csp.ts";
import { chatAskingForPackages } from "./dependency-request.ts";
import { apiOf, peopleIn, release } from "./people.ts";

// A chart library, end to end: asked for in the chat, approved on its
// card by the App's builder, imported in a page and drawn in the App's
// frame, its module served from the build's own directory under the
// frame's policy. Once revoked, the page's frame is no longer served.

/** How long the App may take to build and draw. */
const drawn = { timeout: 60_000 };

const chartPage = `import { createFileRoute } from "@tanstack/react-router";
import { PieChart } from "react-minimal-pie-chart";

function Totals() {
  return (
    <main className="p-4">
      <h1 className="text-lg font-medium">Totals</h1>
      <PieChart data={[{ title: "Paid", value: 3, color: "currentColor" }]} />
    </main>
  );
}
export const Route = createFileRoute("/")({ component: Totals });
`;

test("a builder approves a chart library the agent asked for, a page draws with it, and a revoked one is no longer served", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("chartPackages");
  const { core, api } = apiOf(builder);
  try {
    const name = `Totals ${crypto.randomUUID().slice(0, 8)}`;
    const { id: app } = await api.apps.create({ name });
    const chat = await chatAskingForPackages(api, `Build ${name}`);
    const { userId } = await api.whoami();
    // Asked for in the chat, as its agent asks (`build.resolveDependencies`):
    // resolved from the npm registry, then named as the chat's.
    const request = await api.dependencies.resolve({
      app,
      purpose: "Draw the totals as a pie chart.",
      dependencies: [{ name: "react-minimal-pie-chart", range: "8.4.0" }],
    });
    await execute(
      `UPDATE dependency_requests SET requested_via = ${quoted(
        JSON.stringify({
          type: "agent",
          agentId: "chat-agent",
          onBehalfOf: userId,
          workspaceId: `person:${userId}`,
          chatId: chat.id,
        })
      )} WHERE id = ${quoted(request.id)}`,
      "core"
    );

    const page = await pageOf(builder);
    await page.goto(`/?chat=${chat.id}`);
    const card = page
      .getByRole("region", { name: "Package requests" })
      .filter({ hasText: "react-minimal-pie-chart@8.4.0" });
    await card
      .getByRole("button", { name: `Approve the packages for ${name}` })
      .click(drawn);
    await expect(card).toHaveCount(0, drawn);

    await release(api, app, { "src/routes/index.tsx": chartPage }, "Totals");
    await page.goto(`/apps/${app}/full`);
    const frame = page.frameLocator('iframe[title="App"]');
    await expect(frame.getByRole("heading", { name: "Totals" })).toBeVisible(
      drawn
    );
    await expect(frame.locator("svg path")).toHaveCount(1);

    // Revoked, as the clock's rescan revokes one reported as malware.
    await execute(
      `UPDATE dependency_requests SET status = 'revoked' WHERE id = ${quoted(request.id)}`,
      "core"
    );
    await page.reload();
    await expect(frame.getByRole("heading", { name: "Totals" })).toHaveCount(
      0,
      drawn
    );
  } finally {
    core[Symbol.dispose]();
  }
});
