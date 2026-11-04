import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { seedDependencyRequest } from "./dependency-request.ts";
import { apiOf, peopleIn } from "./people.ts";

// Chat's own page: the builder approves, on the card under the thread,
// the npm packages the chat's agent asked for. It decides under the
// deployment's policy generation, which retiring and revoking packages
// move on, so it runs with the other package approval tests
// (playwright.config.ts).

test("a builder approves, on Chat's own page, the packages the chat's agent asked for", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("chatPackages");
  const { core, api } = apiOf(builder);
  const engine = `Charts ${crypto.randomUUID().slice(0, 8)}`;
  const { id: app } = await api.apps.create({ name: engine });
  const { id: chat } = await api.chats.create(engine);
  // As the chat's agent leaves a request (dependency-request.ts): a local
  // stack can't resolve from the registry.
  const request = await seedDependencyRequest({
    app,
    requestedBy: builder.userId,
    purpose: "Draw the quarter's totals as a chart.",
    targets: ["browser"],
    approved: false,
    requestedVia: {
      workspaceId: crypto.randomUUID(),
      chatId: chat,
      agentId: crypto.randomUUID(),
    },
    graph: {
      direct: [{ name: "charts", version: "3.1.0" }],
      packages: [
        {
          name: "charts",
          version: "3.1.0",
          origin: "https://registry.npmjs.org",
          integrity: `sha512-${"E".repeat(86)}==`,
          license: "MIT",
          dependencies: [],
          peers: [],
        },
      ],
      platformPeers: {},
    },
  });

  const page = await pageOf(builder);
  await page.goto(`/?chat=${chat}`);
  const cards = page.getByRole("region", { name: "Package requests" });
  await expect(
    cards.getByText(`The agent asks to install packages for ${engine}`)
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    cards.getByText("Draw the quarter's totals as a chart.")
  ).toBeVisible();
  // One click, on the person's own session.
  await cards
    .getByRole("button", { name: `Approve the packages for ${engine}` })
    .click();

  await expect(cards).toHaveCount(0);
  await expect
    .poll(async () => {
      const { approved } = await api.dependencies.status({ app });
      return approved?.id;
    })
    .toBe(request.id);
  core[Symbol.dispose]();
});
