import { expect } from "@playwright/test";

import {
  linearIssuer,
  linearMcpUrl,
  linearOrigin,
} from "../apps/connect/test/linear-mcp-fake.ts";
import { execute } from "./connections-seed.ts";
import { test } from "./csp.ts";
import { consentCodeOf } from "./linear-consent.ts";
import { linearAnswer, linearAsked, modelScripts } from "./model-scripts.ts";
import { peopleIn } from "./people.ts";

// Connectors made from an MCP server's URL (GRA-2331), end to end: an
// admin adds Linear's server by its URL, a person connects it by signing
// in at Linear, and their chat reads their issues through it once they
// granted it. Linear is connect's faithful fake, beside connect in the
// stack (e2e/connect-entry.ts); its sign-in page is answered here with the
// person's approval (e2e/linear-consent.ts).

test("an admin adds Linear's server by its URL, a person connects it, and their chat reads their issues through it", async ({
  pageOf,
}) => {
  const { admin, user } = peopleIn("connectorsByUrl");
  // A server is added once: a try again starts from none.
  await execute(`DELETE FROM connectors WHERE url = '${linearMcpUrl}'`);

  const adminPage = await pageOf(admin);
  await adminPage.goto("/connectors");
  await adminPage.getByRole("button", { name: "Add connector" }).click();
  const adding = adminPage.getByRole("dialog", {
    name: "Add a connector by URL",
  });
  await adding.getByLabel("Name").fill("Linear");
  await adding.getByLabel("Server URL").fill(linearMcpUrl);
  await adding.getByRole("button", { name: "Add the connector" }).click();
  // Its own page, once connect learned how it signs in and registered there.
  await expect(adminPage).toHaveURL(
    /\/connectors\/connector%3Amcp_[0-9a-f]{32}$/u
  );
  await expect(
    adminPage.getByRole("heading", { level: 1, name: "Linear" })
  ).toBeVisible();
  const page = new URL(adminPage.url()).pathname;

  // The person signs in at Linear, which approves and sends them back.
  const person = await pageOf(user);
  await person.route(`${linearOrigin}/authorize?**`, async (route) => {
    const asked = new URL(route.request().url());
    const back = new URL(asked.searchParams.get("redirect_uri") ?? "");
    back.searchParams.set("code", consentCodeOf(asked.href));
    back.searchParams.set("state", asked.searchParams.get("state") ?? "");
    back.searchParams.set("iss", linearIssuer);
    await route.fulfill({ status: 303, headers: { location: back.href } });
  });
  await person.goto(page);
  await person.getByRole("button", { name: "Connect", exact: true }).click();
  await person
    .getByRole("dialog")
    .getByRole("button", { name: "Sign in to Linear" })
    .click();
  await expect(
    person.getByRole("dialog", { name: "Linear is connected" })
  ).toBeVisible();

  // Their chat asks for it, they grant it there, and it reads through it.
  const { opener } = modelScripts.readsLinear;
  await person.goto("/");
  await person
    .getByLabel("Your question")
    .fill(`${opener} (${crypto.randomUUID().slice(0, 8)})`);
  await person.getByRole("button", { name: "Send", exact: true }).click();
  const messages = person.getByRole("log", { name: "Messages" });
  await expect(messages.getByText(linearAsked)).toBeVisible({
    timeout: 30_000,
  });
  await person.getByRole("button", { name: /^Grant /u }).click();
  const box = person.getByRole("textbox", { name: "Ask Grasp" });
  await box.fill("Now look.");
  await box.press("Enter");
  await expect(messages.getByText(linearAnswer)).toBeVisible({
    timeout: 30_000,
  });
});
