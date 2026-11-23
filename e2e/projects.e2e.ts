import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";

// A project, end to end: a builder makes one, puts an App of theirs in it
// without sharing it, files one of their own chats in it, adds a
// colleague, who then finds the project and can change nothing in it, and
// takes the chat out again. What filing, sharing and membership grant is
// core's tests.

test("a builder makes a project, files an App and a chat of theirs in it, and adds a colleague who only uses it", async ({
  pageOf,
}) => {
  const { builder, colleague } = peopleIn("projects");
  const tag = crypto.randomUUID().slice(0, 8);
  const appName = `Invoice desk ${tag}`;
  const chatTitle = `Budget review ${tag}`;
  const { core, api } = apiOf(builder);
  let chatId: string;
  try {
    await api.apps.create({ name: appName, description: "Invoices" });
    ({ id: chatId } = await api.chats.create(chatTitle));
  } finally {
    core[Symbol.dispose]();
  }

  const page = await pageOf(builder);
  await page.goto("/projects");
  // Nobody has put them in a project yet: making one is the way on.
  await expect(page.getByText("No projects yet")).toBeVisible();
  await page.getByRole("button", { name: "New project" }).click();
  const making = page.getByRole("dialog", { name: "New project" });
  await making.getByRole("textbox", { name: "Name" }).fill(`Quotes ${tag}`);
  await making
    .getByRole("textbox", { name: "What it is for" })
    .fill("Every quote, from the ask to the yes");
  await making.getByRole("button", { name: "Rocket" }).click();
  await making.getByRole("button", { name: "Make project" }).click();
  await expect(page).toHaveURL(/\/projects\/[^/]+$/u);
  const projectId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  await expect(
    page.getByRole("heading", { name: `Quotes ${tag}` })
  ).toBeVisible();
  await expect(page.getByText("No Apps in it yet.")).toBeVisible();

  // Their App, put in without sharing it with anyone.
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  const adding = page.getByRole("dialog", { name: `Add to Quotes ${tag}` });
  await adding.getByRole("combobox", { name: "App or workflow" }).fill(tag);
  await page.getByRole("option", { name: appName }).click();
  await expect(adding.getByRole("checkbox")).not.toBeChecked();
  await adding.getByRole("button", { name: "Add", exact: true }).click();
  await expect(adding).toHaveCount(0);
  const apps = page.getByRole("region", { name: "Apps" });
  await expect(apps.getByRole("link", { name: appName })).toBeVisible();
  await expect(apps).toContainText("Not shared with the project");

  // One of their own chats, which only they see in it.
  await page.getByRole("button", { name: "Add a chat" }).click();
  const filing = page.getByRole("dialog", { name: "Add a chat" });
  await filing.getByRole("searchbox", { name: "Find a chat" }).fill(tag);
  await filing
    .getByRole("listitem")
    .filter({ hasText: chatTitle })
    .getByRole("button", { name: "Add" })
    .click();
  await expect(filing).toHaveCount(0);
  const chats = page.getByRole("region", { name: "Your chats" });
  await expect(chats.getByRole("link", { name: chatTitle })).toBeVisible();

  // A colleague, as someone who uses it.
  await page.getByRole("button", { name: "Add people" }).click();
  const people = page.getByRole("dialog", { name: "People" });
  // Everyone here is called Person: the colleague is told apart by the end
  // of their ID.
  await people
    .getByRole("combobox", { name: "Search people and teams" })
    .click();
  await page
    .getByRole("option")
    .filter({ hasText: colleague.userId.slice(-6) })
    .click();
  await people.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    people
      .getByRole("list", { name: "People in the project" })
      .getByRole("listitem")
  ).toHaveCount(2);
  await people.getByRole("button", { name: "Close" }).last().click();
  await expect(
    page.getByRole("button", { name: "People in it: 2" })
  ).toBeVisible();

  const checks = apiOf(builder);
  try {
    const filed = await checks.api.chats.list({ project: projectId });
    expect(filed.map(({ id }) => id)).toStrictEqual([chatId]);
  } finally {
    checks.core[Symbol.dispose]();
  }

  // The colleague finds it, and nothing to change in it: not the App,
  // which filing shared with nobody, and never the builder's chat.
  const theirs = await pageOf(colleague);
  await theirs.goto("/projects");
  await theirs
    .getByRole("link", { name: new RegExp(`^Quotes ${tag}`, "u") })
    .click();
  await expect(
    theirs.getByRole("heading", { name: `Quotes ${tag}` })
  ).toBeVisible();
  await expect(theirs.getByText("No Apps in it yet.")).toBeVisible();
  await expect(theirs.getByRole("link", { name: appName })).toHaveCount(0);
  await expect(theirs.getByText(chatTitle)).toHaveCount(0);
  await expect(
    theirs.getByRole("button", { name: `More for Quotes ${tag}` })
  ).toHaveCount(0);
  await expect(
    theirs.getByRole("button", { name: "Add", exact: true })
  ).toHaveCount(0);

  // Taken out, the chat is theirs alone again, in no project.
  await chats
    .getByRole("button", { name: `Take ${chatTitle} out of the project` })
    .click();
  await expect(chats).toHaveCount(0);
  await expect(
    page.getByText("None of your chats are in it.", { exact: false })
  ).toBeVisible();
});
