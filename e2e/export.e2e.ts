import { readFile } from "node:fs/promises";

import { expect } from "@playwright/test";
import type { Download, Page } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, pageOf, peopleIn } from "./people.ts";

// Every export offers Markdown or PDF (export/export-menu.tsx): a document
// and a chat each download as Markdown, and each prints as a page of their
// own, under the app's Content Security Policy (the `test` here fails on
// any violation).

const pageRead = { timeout: 15_000 };

/** Chooses `format` from the export menu named `label`. */
const choose = async (
  page: Page,
  label: string,
  format: "Markdown (.md)" | "PDF"
): Promise<void> => {
  await page.getByRole("button", { name: label }).click();
  await page.getByRole("menuitem", { name: format }).click();
};

const textOf = async (download: Download): Promise<string> =>
  await readFile(await download.path(), "utf-8");

test("a document and a chat each export as Markdown and as a page to print", async ({
  browser,
}) => {
  const { admin } = peopleIn("exports");
  const { core, api } = apiOf(admin);
  let collectionId: string;
  let documentId: string;
  try {
    ({ id: collectionId } = await api.knowledge.createCollection({
      name: `Handbook ${crypto.randomUUID()}`,
      access: "everyone",
    }));
    ({ id: documentId } = await api.knowledge.saveDocument({
      collectionId,
      path: "leave.md",
      text: "# Leave\n\nSixteen weeks, **paid**.\n",
      ifVersion: 0,
    }));
  } finally {
    core[Symbol.dispose]();
  }
  const page = await pageOf(browser, admin);

  await page.goto(`/knowledge/${collectionId}?doc=${documentId}`);
  await expect(page.getByText("Sixteen weeks")).toBeVisible(pageRead);
  const document = page.waitForEvent("download");
  await choose(page, "Export this document", "Markdown (.md)");
  const file = await document;
  expect(file.suggestedFilename()).toBe("leave.md");
  expect(await textOf(file)).toContain("Sixteen weeks, **paid**.");

  // The page to print: the title, then the text rendered, in a frame of
  // this origin that keeps its policy.
  await choose(page, "Export this document", "PDF");
  const printed = page.frameLocator('iframe[title="Leave"]');
  await expect(printed.getByRole("heading", { name: "Leave" })).toHaveCount(1);
  await expect(printed.getByText("paid", { exact: true })).toBeAttached();

  // A chat: its title, and each question.
  const tag = crypto.randomUUID().slice(0, 8);
  const question = `How long is leave ${tag}?`;
  await page.goto("/");
  await page.getByLabel("Your question").fill(question);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/[?&]chat=/u);
  const messages = page.getByRole("list", { name: "Messages" });
  await expect(messages.getByRole("listitem").first()).toHaveText(question);
  const chat = page.waitForEvent("download");
  await choose(page, "Export this chat", "Markdown (.md)");
  const chatFile = await chat;
  expect(chatFile.suggestedFilename()).toBe("grasp-chat.md");
  const markdown = await textOf(chatFile);
  expect(markdown).toMatch(/^# /u);
  expect(markdown).toContain(`**You:** ${question}`);

  await choose(page, "Export this chat", "PDF");
  const printedChat = page.locator("iframe").last().contentFrame();
  await expect(
    printedChat.getByRole("heading", { level: 1, name: question })
  ).toHaveCount(1);
  await expect(printedChat.getByText(`You: ${question}`)).toBeAttached();
});
