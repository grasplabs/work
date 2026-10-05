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
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.getByRole("menuitem", { name: format }).click();
};

const textOf = async (download: Download): Promise<string> =>
  await readFile(await download.path(), "utf-8");

declare global {
  interface Window {
    /** How often a page to print asked for the print dialog, see below. */
    printed?: number;
  }
}

/**
 * Counts the print dialogs asked for instead of opening them: what a
 * browser does with `print()` (a dialog, or nothing at all headless) isn't
 * the page's to test. The page's frame is of this origin, so its window
 * can be reached from here.
 */
const countPrints = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const own = Object.getOwnPropertyDescriptor(
      HTMLIFrameElement.prototype,
      "contentWindow"
    );
    Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
      configurable: true,
      get(this: HTMLIFrameElement) {
        const view: unknown = own?.get?.call(this);
        if (typeof view === "object" && view !== null && "print" in view) {
          Object.assign(view, {
            print: () => {
              window.printed = (window.printed ?? 0) + 1;
            },
          });
        }
        return view;
      },
    });
  });
};

/** The print dialog closing, as the browser says it does. */
const closePrint = async (page: Page, title: string): Promise<void> => {
  await page.evaluate((name) => {
    document
      .querySelector<HTMLIFrameElement>(`iframe[title="${name}"]`)
      ?.contentWindow?.dispatchEvent(new Event("afterprint"));
  }, title);
};

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
  await choose(page, "Export", "Markdown (.md)");
  const file = await document;
  expect(file.suggestedFilename()).toBe("leave.md");
  expect(await textOf(file)).toContain("Sixteen weeks, **paid**.");

  // The page to print: the title, then the text rendered, in a frame of
  // this origin that keeps its policy, styled by the app's own stylesheets
  // and set in Geist.
  await countPrints(page);
  await choose(page, "Export", "PDF");
  await expect
    .poll(async () => await page.evaluate(() => window.printed))
    .toBe(1);
  const printed = page.frameLocator('iframe[title="Leave"]');
  const heading = printed.getByRole("heading", { name: "Leave" });
  await expect(heading).toHaveCount(1);
  await expect(printed.getByText("paid", { exact: true })).toBeAttached();
  await expect
    .poll(
      async () =>
        await heading.evaluate((element) => {
          const style = getComputedStyle(element);
          return `${style.fontSize} ${style.fontFamily}`;
        })
    )
    .toMatch(/^24px .*Geist/u);
  // Once the dialog closes, the page to print goes.
  await closePrint(page, "Leave");
  await expect(page.locator('iframe[title="Leave"]')).toHaveCount(0);

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
  // Named after the chat, whose title is its first question here.
  expect(chatFile.suggestedFilename()).toBe(`How-long-is-leave-${tag}.md`);
  const markdown = await textOf(chatFile);
  expect(markdown).toMatch(/^# /u);
  expect(markdown).toContain(`**You:**\n\n${question}`);

  await countPrints(page);
  await choose(page, "Export this chat", "PDF");
  await expect
    .poll(async () => await page.evaluate(() => window.printed))
    .toBe(1);
  const printedChat = page.frameLocator(`iframe[title="${question}"]`);
  await expect(
    printedChat.getByRole("heading", { level: 1, name: question })
  ).toHaveCount(1);
  await expect(printedChat.getByText(question, { exact: true })).toHaveCount(2);
});
