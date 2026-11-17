import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { modelScripts, writingOn, writtenBeforeHold } from "./model-scripts.ts";
import { peopleIn } from "./people.ts";

// Chatting with the agent, end to end, as a person does it: an answer read
// to its end; one stopped mid-way, one the page reloads under, and one a
// second question can't interrupt; a question core never confirms; the
// chat beside a page, floating, docked, full screen and back; a chat
// renamed where its name stands; and a phone. The stack's provider answers
// only scripted chats (e2e/model-scripts.ts): `answers` whole, `writesOn`
// its first words and then holding, as a long answer still being written.
// What core does behind it (streaming, resuming, the turn's lock) is core's
// tests (apps/core/test/chats.test.ts).

/** A question its script answers, unique to the attempt. */
const questionOf = (opener: string): string =>
  `${opener} (${crypto.randomUUID().slice(0, 8)})`;

/** Asks `question` from Chat's start, its tour turned down; the chat's messages. */
const askFromStart = async (page: Page, question: string) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Not now" }).click();
  await page.getByLabel("Your question").fill(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page).toHaveURL(/\/chats\/[^/]+$/u);
  const messages = page.getByRole("log", { name: "Messages" });
  await expect(messages.getByRole("article").first()).toHaveText(question);
  return messages;
};

/** What `writesOn` has written when it holds. */
const heldWords = writingOn.slice(0, writtenBeforeHold).trim();

/** The first words of what `writesOn` writes, as they show once written. */
const firstWords = "One, two, three";

test("a person asks from Chat's start, reads the answer to its end, and the chat no longer shows as working", async ({
  pageOf,
}) => {
  const { user } = peopleIn("chatAsk");
  const page = await pageOf(user);
  const { opener, replies } = modelScripts.answers;
  const [answer] = replies;

  const messages = await askFromStart(page, questionOf(opener));

  await expect(messages.getByText(answer.text)).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    messages.getByRole("button", { name: "Copy the answer" })
  ).toBeVisible();
  await expect(messages.getByRole("alert")).toHaveCount(0);
  // Its row in the sidebar no longer says the agent works there.
  await expect(page.locator("[data-slot=sidebar-row-working]")).toHaveCount(0);
});

test("a person stops an answer mid-way: what was written stays, said as stopped, and the box is ready again", async ({
  pageOf,
}) => {
  const { user } = peopleIn("chatStop");
  const page = await pageOf(user);
  const messages = await askFromStart(
    page,
    questionOf(modelScripts.writesOn.opener)
  );
  await expect(messages.getByText(firstWords, { exact: false })).toBeVisible({
    timeout: 30_000,
  });

  await page.getByRole("button", { name: "Stop", exact: true }).click();

  await expect(messages.getByText("Stopped", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(messages.getByText(firstWords, { exact: false })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true })
  ).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Ask Grasp" })).toBeEditable();
});

test("a reload while the agent writes shows the chat again, the answer still being written", async ({
  pageOf,
}) => {
  const { user } = peopleIn("chatReload");
  const page = await pageOf(user);
  await askFromStart(page, questionOf(modelScripts.writesOn.opener));
  await expect(page.getByText(firstWords, { exact: false })).toBeVisible({
    timeout: 30_000,
  });

  await page.reload();

  const messages = page.getByRole("log", { name: "Messages" });
  await expect(messages.getByText(firstWords, { exact: false })).toBeVisible({
    timeout: 30_000,
  });
  // Still at work: the box offers Stop, not Send.
  await expect(
    page.getByRole("button", { name: "Stop", exact: true })
  ).toBeVisible();
  await expect(messages.getByText(heldWords.slice(-8))).toBeVisible();
});

test("a second question while the agent writes waits in the box, sending nothing", async ({
  pageOf,
}) => {
  const { user } = peopleIn("chatSecond");
  const page = await pageOf(user);
  const messages = await askFromStart(
    page,
    questionOf(modelScripts.writesOn.opener)
  );
  await expect(messages.getByText(firstWords, { exact: false })).toBeVisible({
    timeout: 30_000,
  });
  const box = page.getByRole("textbox", { name: "Ask Grasp" });
  const second = "And then to thirty?";

  await box.fill(second);
  await box.press("Enter");

  await expect(box).toHaveText(second);
  // Still the one question in the chat.
  await expect(messages.getByText(second)).toHaveCount(0);
});

test("a question core never confirms says it wasn't sent, and keeps it in the box", async ({
  pageOf,
}) => {
  const { user } = peopleIn("chatUnheard");
  const page = await pageOf(user);
  // Core's answer to a send never comes back: the RPC socket passes all
  // else, but not the send.
  await page.routeWebSocket(/\/rpc/u, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      if (!String(message).includes('"chats","send"')) {
        server.send(message);
      }
    });
    server.onMessage((message) => {
      socket.send(message);
    });
  });
  const question = questionOf(modelScripts.answers.opener);
  await page.goto("/");
  await page.getByRole("button", { name: "Not now" }).click();
  const box = page.getByLabel("Your question");
  await box.fill(question);

  await page.getByRole("button", { name: "Send", exact: true }).click();

  // Past the send's deadline (chat/use-ask.ts: 10s).
  await expect(page.getByText("Could not send")).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.getByText("Grasp hasn't confirmed your question yet.", {
      exact: false,
    })
  ).toBeVisible();
  await expect(box).toHaveText(question);
});

test("the chat beside a page floats, moves, docks again, goes full screen and back, and closes keeping its place and draft", async ({
  pageOf,
}) => {
  const { user } = peopleIn("chatPanel");
  const page = await pageOf(user, { viewport: { width: 1440, height: 900 } });
  await page.goto("/apps");
  await page.getByRole("button", { name: /^Open the chat/u }).click();
  const head = page.locator("[data-slot=app-shell-panel-head]");
  await expect(head).toBeVisible();

  await head.getByRole("button", { name: "Float over the page" }).click();
  await expect(head).toHaveAttribute("data-floating", "");
  // Moved by its head.
  const before = await head.boundingBox();
  const move = page.locator("[data-slot=app-shell-panel-move]");
  await move.dragTo(page.locator("body"), {
    sourcePosition: { x: 40, y: 20 },
    targetPosition: { x: 500, y: 300 },
  });
  const after = await head.boundingBox();
  expect(after?.x).not.toBe(before?.x);

  // Full screen and back, floating still.
  await head.getByRole("button", { name: "Full screen" }).click();
  await expect(
    head.getByRole("button", { name: "Leave full screen" })
  ).toBeVisible();
  await head.getByRole("button", { name: "Leave full screen" }).click();
  await expect(head).toHaveAttribute("data-floating", "");

  // A draft, then closed and opened again: in the same place, the draft kept.
  const draft = "Half a question";
  await page.getByRole("textbox", { name: "Ask Grasp" }).fill(draft);
  const placed = await head.boundingBox();
  await head.getByRole("button", { name: "Close" }).click();
  await expect(head).toHaveCount(0);
  await page.getByRole("button", { name: /^Open the chat/u }).click();
  await expect(head).toBeVisible();
  expect(await head.boundingBox()).toStrictEqual(placed);
  await expect(page.getByRole("textbox", { name: "Ask Grasp" })).toHaveText(
    draft
  );

  // Docked again by the switch.
  await head.getByRole("button", { name: "Dock beside the page" }).click();
  await expect(head).not.toHaveAttribute("data-floating", "");
});

test("a person renames a chat where its name stands: in the page's bar, and in the chat beside a page", async ({
  pageOf,
}) => {
  const { user } = peopleIn("chatRename");
  const page = await pageOf(user);
  const { opener, replies } = modelScripts.answers;
  const [answer] = replies;
  const messages = await askFromStart(page, questionOf(opener));
  await expect(messages.getByText(answer.text)).toBeVisible({
    timeout: 30_000,
  });
  const tag = crypto.randomUUID().slice(0, 8);

  // In the bar: a double-click on the name, a new one, Enter.
  const named = `Sales report ${tag}`;
  await page
    .locator("[data-slot=app-shell-bar] [aria-haspopup=dialog]")
    .last()
    .dblclick();
  await page.getByRole("textbox", { name: "Name" }).fill(named);
  await page.getByRole("textbox", { name: "Name" }).press("Enter");
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" })
  ).toContainText(named);
  await expect(page.getByRole("navigation").getByText(named)).toBeVisible();

  // Beside another page, in the chat's own head.
  const renamed = `Weekly sales ${tag}`;
  await page.goto("/apps");
  await page.getByRole("button", { name: /^Open the chat/u }).click();
  await page.locator("[data-slot=app-shell-panel-title]").dblclick();
  await page.getByRole("textbox", { name: "Name" }).fill(renamed);
  await page.getByRole("textbox", { name: "Name" }).press("Enter");
  await expect(page.locator("[data-slot=app-shell-panel-title]")).toHaveText(
    renamed
  );
});

test("on a phone, a person asks, follows the words coming in, and stops the answer", async ({
  pageOf,
}) => {
  const { user } = peopleIn("chatPhone");
  const page = await pageOf(user, {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const messages = await askFromStart(
    page,
    questionOf(modelScripts.writesOn.opener)
  );
  await expect(messages.getByText(firstWords, { exact: false })).toBeVisible({
    timeout: 30_000,
  });

  await page.getByRole("button", { name: "Stop", exact: true }).click();

  await expect(messages.getByText("Stopped", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  // Nothing runs off the screen's side.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
