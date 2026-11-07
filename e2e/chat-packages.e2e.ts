import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { seedDependencyRequest } from "./dependency-request.ts";
import { apiOf, peopleIn } from "./people.ts";

// The npm packages the chat's agent asked for, on a card in that chat:
// the App's builder approves them there, in their own session, and the
// card goes. Nothing else approves them.

/** How long a page may take to show what core said. */
const pageRead = { timeout: 20_000 };

test("the App's builder approves the packages its chat's agent asked for, on the chat's card", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("chatPackages");
  const { core, api } = apiOf(builder);
  try {
    const name = `Totals ${crypto.randomUUID().slice(0, 8)}`;
    const { id: app } = await api.apps.create({ name });
    const chat = await api.chats.create(`Build ${name}`);
    const { userId } = await api.whoami();
    const request = await seedDependencyRequest({
      app,
      requestedBy: userId,
      chat: chat.id,
      purpose: "Format the report's dates.",
      packages: { "date-fns": "3.6.0" },
    });

    const page = await pageOf(builder);
    await page.goto(`/?chat=${chat.id}`);
    const card = page
      .getByRole("region", { name: "Package requests" })
      .filter({ hasText: `The agent asks for npm packages for ${name}` });
    await expect(card).toBeVisible(pageRead);
    await expect(card).toContainText("date-fns@3.6.0");
    await expect(card).toContainText("Format the report's dates.");
    await card
      .getByRole("button", { name: `Approve the packages for ${name}` })
      .click();

    await expect(card).toHaveCount(0);
    await expect
      .poll(async () => {
        const { approved } = await api.dependencies.status({ app });
        return approved?.id;
      })
      .toBe(request.id);
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    core[Symbol.dispose]();
  }
});
