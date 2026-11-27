import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { execute } from "./connections-seed.ts";
import { test } from "./csp.ts";
import { modelScripts, monthEndCloseLast } from "./model-scripts.ts";
import { askInNewChat, emptyChat } from "./new-chats.ts";
import { apiOf, peopleIn } from "./people.ts";
import type { Person } from "./people.ts";
import { e2eModel } from "./stack.ts";

// The Chat page: a person asks in a new chat, which opens Grasp's chat full
// screen over the page, and follows the answer as it comes in, finds it in
// the ⌘K window by what was said in it, renames it
// there, reads the writes its agent holds for them
// (one as its tool describes it, one by its raw input), confirms and
// rejects them, and sees nothing of held writes while they are switched
// off, and reads the agent's answer to a chat a script opens, which the
// sidebar then shows by the title the chat was named with. The stack's
// provider answers only a scripted chat (e2e/model-scripts.ts) and refuses
// the key of any other, so that answer is the gateway's failure;
// streaming, resuming and the person check themselves are core's tests
// (apps/core/test/chats.test.ts).

const quoted = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/** The window of the person's chats, ⌘K away on every page. */
const chatsWindow = async (page: Page) => {
  await page.keyboard.press("ControlOrMeta+k");
  const window = page.getByRole("dialog", { name: "Chats" });
  await expect(window).toBeVisible();
  return window;
};

/** A chat's row in the window, by its title. */
const rowOf = (window: ReturnType<Page["getByRole"]>, title: string) =>
  window
    .getByRole("option")
    .filter({ has: window.page().getByText(title, { exact: true }) });

/**
 * Opens the actions of the row titled `title` in the window, as its
 * arrow does: the row highlighted, then the arrow toward the line's end.
 */
const rowActions = async (
  window: ReturnType<Page["getByRole"]>,
  title: string
): Promise<void> => {
  await rowOf(window, title).hover();
  await window.getByRole("combobox").press("ArrowRight");
};

/** A chat on its own page, where a question asked on Chat's start goes. */
const chatPageOf = (page: Page) => page.getByRole("main");

/** `person`'s chat titled `title`: its ID, as core lists it. */
const chatIdOf = async (person: Person, title: string): Promise<string> => {
  const { core, api } = apiOf(person);
  try {
    const chats = await api.chats.list();
    return chats.find((chat) => chat.title === title)?.id ?? "";
  } finally {
    core[Symbol.dispose]();
  }
};

/**
 * A write the chat's agent asked for, as connect holds it for `person`:
 * written straight into connect's local database, as a call from the
 * chat's code would leave it (held-writes are core's tests too).
 */
const holdWrite = async (
  person: Person,
  chatId: string,
  {
    connectionId = crypto.randomUUID(),
    input = { to: "ben@acme.test", subject: "Invoice" },
  }: { connectionId?: string; input?: Record<string, unknown> } = {}
): Promise<void> => {
  const context = JSON.stringify({
    type: "chat",
    // The person's own chats' object, and the organization's agent.
    workspaceId: `person:${person.userId}`,
    chatId,
  });
  const values = [
    quoted(crypto.randomUUID()),
    quoted("agent"),
    quoted("organization"),
    quoted(person.userId),
    quoted("interactive"),
    "NULL",
    quoted(connectionId),
    "NULL",
    "NULL",
    quoted("mail.send"),
    quoted(`chat:${crypto.randomUUID()}`),
    quoted(JSON.stringify(input)),
    quoted("0".repeat(64)),
    quoted(crypto.randomUUID()),
    quoted(context),
    "0",
    String(Date.now()),
  ];
  await execute(
    `INSERT INTO pending_actions (id, subject_type, subject_id, on_behalf_of, mode, app_version, connection_id, account_id, resource, action, idempotency_key, input, input_hash, permission_id, context, restricted, created_at) VALUES (${values.join(", ")})`
  );
};

/**
 * `person`'s own Microsoft 365 connection, as connect keeps one: its ID.
 * Its connector's tools describe their writes, so one held on it reads as
 * its tool says.
 */
const connectMail = async (
  person: Person,
  account: string
): Promise<string> => {
  const id = crypto.randomUUID();
  const now = String(Date.now());
  const values = [
    quoted(id),
    quoted("microsoft"),
    quoted("personal"),
    quoted(person.userId),
    quoted("active"),
    quoted("native"),
    quoted("microsoft-365"),
    quoted(`account-${id}`),
    quoted(account),
    quoted(person.userId),
    now,
    now,
  ];
  await execute(
    `INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, account_id, account_name, connected_by, created_at, updated_at) VALUES (${values.join(", ")})`
  );
  return id;
};

test("a person asks in a new chat, follows the answer, renames it, and reads and decides the writes it holds", async ({
  pageOf,
}) => {
  const { user } = peopleIn("chat");
  const page = await pageOf(user);
  // Unique to the attempt, so each finds its own chat in the list.
  const tag = crypto.randomUUID().slice(0, 8);
  const question = `Send Ben invoice ${tag}.`;
  const title = `Invoice ${tag}`;
  await page.goto("/");
  await page.getByLabel("Your question").fill(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  // The chat opens on its own page.
  await expect(page).toHaveURL(/\/chats\/[^/]+$/u);
  const chat = chatPageOf(page);
  const messages = chat.getByRole("log", { name: "Messages" });
  await expect(
    messages.getByRole("article", { name: "You" }).first()
  ).toContainText(question);
  // The local stack's provider refuses unscripted requests' keys
  // (e2e/model-fake.ts): the answer says so once the turn ends, and who can
  // put it right.
  await expect(messages.getByRole("alert")).toContainText(
    "Your AI provider is refusing your key. Ask your admin to check or replace it in Settings › AI providers.",
    { timeout: 30_000 }
  );
  // It is the first chat in the window, named after the question: ⌘K
  // from the chat's box opens it, and the same keys close it again.
  await chat.getByRole("textbox", { name: "Ask Grasp" }).click();
  let chats = await chatsWindow(page);
  await expect(rowOf(chats, question)).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(chats).toHaveCount(0);

  // Trying again asks the question again, in place: drawn once, its new
  // answer under the one that failed.
  await messages.getByRole("button", { name: "Try again" }).click();
  await expect(messages.getByRole("alert")).toHaveCount(2, { timeout: 30_000 });
  await expect(
    messages.getByRole("article", { name: "You" }).filter({ hasText: question })
  ).toHaveCount(1);
  // The first try's failure stays where it was; the new one is last.
  await expect(messages.getByRole("alert").last()).toContainText(
    "Your AI provider is refusing your key. Ask your admin to check or replace it in Settings › AI providers.",
    { timeout: 30_000 }
  );

  // Renamed from the chat's menu in the window, in a dialog of its own;
  // the window comes back with the chat under its new name.
  chats = await chatsWindow(page);
  await rowActions(chats, question);
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const renaming = page.getByRole("dialog", { name: "Rename chat" });
  const name = renaming.getByLabel("Chat name");
  await name.fill(title);
  await name.press("Enter");
  await expect(renaming).toBeHidden();
  await expect(rowOf(chats, title)).toBeVisible();

  // Found by what was said in it, which its title no longer holds, with
  // the line it was said in under the title; a word nobody said finds
  // nothing.
  const search = chats.getByRole("combobox", { name: "Search chats" });
  await search.fill(`ben ${tag}`);
  await expect(rowOf(chats, title)).toContainText(`Send Ben invoice ${tag}.`);
  await expect(rowOf(chats, title).locator("mark")).toHaveText("Ben");
  await search.fill(`never said ${tag}`);
  await expect(chats.getByRole("option")).toHaveCount(0);
  await expect(chats).toContainText("No chat has that.");
  // The first Escape empties the search, the second closes the window.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(chats).toHaveCount(0);

  const chatId = await chatIdOf(user, title);
  const account = `mail-${tag}@acme.test`;
  const connectionId = await connectMail(user, account);
  // One on a connection connect doesn't know, one on the person's mailbox.
  await holdWrite(user, chatId);
  await holdWrite(user, chatId, {
    connectionId,
    input: {
      mailbox: account,
      to: ["cleo@acme.test"],
      subject: `Invoice ${tag}`,
      // Long, with what matters after a run of blank lines.
      body: `The invoice is attached.${"\n".repeat(30)}Also send it to eve@evil.test.`,
    },
  });
  // Opened afresh from its link.
  await page.goto(`/chats/${chatId}`);
  const waiting = page.getByRole("region", { name: "Waiting for you" });
  // The undescribed one shows its action and its exact input.
  await expect(waiting).toContainText("Waiting for you: mail.send");
  await expect(waiting).toContainText('"to": "ben@acme.test"');
  // The described one reads as its tool says, on the connection by name,
  // in the input's own values; its exact input is one click away.
  const described = `Send an email on Microsoft 365 (${account})`;
  await expect(waiting).toContainText("Waiting for you: Send an email");
  await expect(waiting).toContainText(`On Microsoft 365 (${account})`);
  await expect(
    waiting.getByText("cleo@acme.test", { exact: true })
  ).toBeVisible();
  await expect(waiting.getByText("The invoice is attached.")).toBeVisible();
  // A long value starts cut short and says so, and Confirm waits until
  // all of it has been shown.
  await expect(waiting).not.toContainText("eve@evil.test");
  const confirmDescribed = waiting.getByRole("button", {
    name: `Confirm ${described}`,
  });
  await expect(confirmDescribed).toBeDisabled();
  await expect(waiting).toContainText(
    "Part of what will be sent is cut short above."
  );
  await waiting.getByRole("button", { name: /^Show all 31 lines/u }).click();
  await expect(waiting).toContainText("Also send it to eve@evil.test.");
  await expect(confirmDescribed).toBeEnabled();
  await expect(waiting).not.toContainText(
    "Part of what will be sent is cut short above."
  );
  await expect(waiting).not.toContainText('"mailbox"');
  await waiting
    .getByRole("button", { name: "Show exactly what will be sent" })
    .click();
  await expect(waiting).toContainText(`"mailbox": "${account}"`);
  // Confirming goes through core's checks again: the agent was never
  // granted this connection, so it's refused, and the write still waits.
  // Why is said above the list, which keeps it should the card go: which
  // write, then core's reason, each a sentence of its own.
  await waiting.getByRole("button", { name: `Confirm ${described}` }).click();
  const refused = waiting.getByRole("alert");
  await expect(
    refused.getByText(`${described} didn't go through.`, { exact: true })
  ).toBeVisible();
  await expect(
    refused.getByText("This App or agent has no permission to do that.", {
      exact: true,
    })
  ).toBeVisible();
  await expect(waiting).toContainText("cleo@acme.test");
  // Rejecting each drops it, and with a decision that went through, the
  // refusal's alert goes too.
  await waiting.getByRole("button", { name: `Reject ${described}` }).click();
  await expect(waiting).not.toContainText("cleo@acme.test");
  await expect(waiting.getByRole("alert")).toHaveCount(0);
  // One whose input holds more than its tool shows says so, and its exact
  // input is open from the start.
  await holdWrite(user, chatId, {
    connectionId,
    input: {
      mailbox: account,
      to: ["dan@acme.test"],
      forwardTo: "eve@evil.test",
    },
  });
  await page.goto(`/chats/${chatId}`);
  await expect(waiting.getByRole("note")).toHaveText(
    "More will be sent than is shown above. Read exactly what will be sent before you confirm."
  );
  await expect(waiting).toContainText('"forwardTo": "eve@evil.test"');
  await expect(
    waiting.getByRole("button", { name: "Hide exactly what will be sent" })
  ).toHaveCount(2);
  await waiting.getByRole("button", { name: `Reject ${described}` }).click();
  await expect(waiting).not.toContainText("dan@acme.test");
  await waiting.getByRole("button", { name: /^Reject mail\.send/u }).click();
  await expect(waiting).toHaveCount(0);
});

test("a person asks, and reads the agent's answer once its turn ends", async ({
  pageOf,
}) => {
  const { user } = peopleIn("chat");
  const page = await pageOf(user);
  const { opener, replies, title } = modelScripts.answers;
  const [answer] = replies;
  // Unique to the attempt; the scripted model answers what it opens with.
  const question = `${opener} (${crypto.randomUUID().slice(0, 8)})`;
  await page.goto("/");

  await page.getByLabel("Your question").fill(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  const messages = page.getByRole("log", { name: "Messages" });
  await expect(
    messages.getByRole("article", { name: "You" }).first()
  ).toContainText(question);
  await expect(messages.getByText(answer.text)).toBeVisible({
    timeout: 30_000,
  });
  // The turn ended: what only a finished answer offers, and no failure.
  await expect(
    messages.getByRole("button", { name: "Ask again" })
  ).toBeVisible();
  await expect(messages.getByRole("alert")).toHaveCount(0);
  // Named from its question by the small model, in the background: the
  // sidebar shows the title in place of the question's start, the page
  // never loaded again.
  await expect(page).toHaveURL(/\/chats\/[^/?#]+$/u);
  const chatId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  await expect(
    page
      .getByRole("navigation", { name: "Main" })
      .locator(`a[href="/chats/${chatId}"]`)
  ).toHaveText(title);
});

test("a person asks again while the answer is still being written, sees it queued, and both are answered in order", async ({
  pageOf,
}) => {
  const { user } = peopleIn("chat");
  const page = await pageOf(user);
  const { opener } = modelScripts.answersWhileAsked;
  const question = `${opener} (${crypto.randomUUID().slice(0, 8)})`;
  const again = "And by when is the budget set?";
  const firstAnswer =
    "First the goals, then the budget and who owns each part.";
  const secondAnswer = "The budget is set by the end of the month.";
  await page.goto("/");

  await page.getByLabel("Your question").fill(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const messages = page.getByRole("log", { name: "Messages" });
  // The answer's first words, the rest still on its way.
  await expect(messages.getByText("First the goals")).toBeVisible({
    timeout: 30_000,
  });
  await expect(messages.getByText(firstAnswer)).toHaveCount(0);

  // The box still takes a question, and the thread shows it queued.
  const box = page.getByRole("textbox", { name: "Ask Grasp" });
  await box.fill(again);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(box).toHaveText("");
  await expect(messages.getByText("Queued")).toBeVisible();

  await expect(messages.getByText(secondAnswer)).toBeVisible({
    timeout: 30_000,
  });
  await expect(messages.getByText("Queued")).toHaveCount(0);
  // In order: the question, its answer, the question asked meanwhile, its answer.
  const said = (await messages.textContent()) ?? "";
  const at = [question, firstAnswer, again, secondAnswer].map((words) =>
    said.indexOf(words)
  );
  expect(at.every((index) => index >= 0)).toBeTruthy();
  expect(at).toStrictEqual(at.toSorted((one, other) => one - other));
  await expect(
    messages.getByRole("button", { name: "Ask again" })
  ).toBeVisible();
  await expect(messages.getByRole("alert")).toHaveCount(0);
});

test("a person reads an answer in blocks: a table, a formula, code and a diagram, each with its own tools", async ({
  pageOf,
}) => {
  const { user } = peopleIn("chat");
  const page = await pageOf(user);
  const { opener } = modelScripts.answersInBlocks;
  const question = `${opener} (${crypto.randomUUID().slice(0, 8)})`;
  await page.goto("/");

  await page.getByLabel("Your question").fill(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  const messages = page.getByRole("log", { name: "Messages" });
  const answer = messages.getByRole("article").last();
  await expect(answer.getByRole("table")).toContainText("North", {
    timeout: 30_000,
  });
  await expect(
    answer.getByRole("button", { name: "Copy table" })
  ).toBeVisible();
  await expect(
    answer.getByRole("button", { name: "Download table" })
  ).toBeVisible();
  // The formula, drawn by KaTeX as maths a screen reader reads.
  await expect(answer.locator("math")).toHaveCount(1);
  // The code, which can be saved as a file as well as copied, coloured on
  // the page under the frontend's own policy (no worker): its words in more
  // than one colour.
  await expect(
    answer.getByRole("button", { name: "Download", exact: true })
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        await answer
          .locator('[data-slot="code-block"] code[data-language="python"]')
          .evaluate(
            (code) =>
              new Set(
                [...code.querySelectorAll("span")]
                  .filter(
                    (span) =>
                      span.children.length === 0 &&
                      (span.textContent ?? "").trim() !== ""
                  )
                  .map((span) => getComputedStyle(span).color)
              ).size
          )
    )
    .toBeGreaterThan(1);
  // The diagram, drawn by Pele, and its own download. A diagram is drawn
  // once it comes near the screen, and this one ends a long answer that may
  // open at its start, below the fold: read down to it, as a person does,
  // then wait for its settled state, `data-diagram`, which names why when
  // it is not drawn.
  const diagram = answer.locator('[data-slot="markdown-diagram"]');
  await diagram.scrollIntoViewIfNeeded();
  await expect(diagram).toHaveAttribute("data-diagram", "drawn", {
    timeout: 15_000,
  });
  await expect(
    answer.getByRole("application", { name: "Mermaid diagram" })
  ).toBeVisible();
  await expect(
    answer.getByRole("button", { name: "Download diagram" })
  ).toBeVisible();
});

test("a person comes back to a chat that answered while they were away, sees its dot, opens it and lands at the New line", async ({
  pageOf,
}) => {
  const { user } = peopleIn("chat");
  const page = await pageOf(user);
  const title = `Month-end ${crypto.randomUUID().slice(0, 8)}`;
  // Asked elsewhere (their phone, say), and answered while Grasp was
  // nowhere open: core marked none of it seen.
  const { core, api } = apiOf(user);
  try {
    const chat = {
      id: await askInNewChat(api, title, {
        text: `${modelScripts.answersAtLength.opener} (${title})`,
        model: e2eModel,
      }),
    };
    await expect
      .poll(async () => await api.chats.summary(chat.id), { timeout: 30_000 })
      .toMatchObject({ running: false, unread: true });
  } finally {
    core[Symbol.dispose]();
  }

  // They come back: the chat's row has its dot, said as Unread, and its
  // title in the bold weight.
  await page.goto("/");
  const sidebar = page.getByRole("navigation", { name: "Main" });
  const unread = sidebar.getByRole("link", { name: `${title} Unread` });
  await expect(unread).toHaveCSS("font-weight", "600");
  await unread.click();

  // The chat opens at the New line, near the top, with room over it: the
  // answer is longer than the window, so its end is below, to scroll to.
  const messages = page.getByRole("log", { name: "Messages" });
  const line = messages.getByRole("separator", { name: "New" });
  await expect(line).toBeInViewport();
  await expect(messages.getByText(monthEndCloseLast)).not.toBeInViewport();
  await expect(
    page.getByRole("button", { name: "Jump to latest" })
  ).toBeVisible();

  // Read now, on core: back on Chat's start, the row has no dot, and its
  // title is in the regular weight again.
  await sidebar.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(
    sidebar.getByRole("link", { name: title, exact: true })
  ).toHaveCSS("font-weight", "400");
});

test("a person opens a long chat on its newest messages, and scrolls back to its first, each earlier page coming in with nothing on the screen moving", async ({
  pageOf,
}) => {
  test.setTimeout(150_000);
  const { user } = peopleIn("chat");
  const turns = 30;
  const { core, api } = apiOf(user);
  let chatId = "";
  try {
    // Each question once the last is answered, as a person asks them.
    const answered = async (): Promise<void> => {
      await expect
        .poll(async () => await api.chats.summary(chatId), { timeout: 30_000 })
        .toMatchObject({ running: false });
    };
    chatId = await askInNewChat(api, "Backlog", {
      text: modelScripts.answersEveryQuestion.opener,
      model: e2eModel,
    });
    await answered();
    for (let item = 2; item <= turns; item += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one question at a time, as a person asks
      await api.chats.send(chatId, { text: `Item ${item}`, model: e2eModel });
      // oxlint-disable-next-line no-await-in-loop -- see above
      await answered();
    }
    // Asked by them, each answer read as it came.
    await api.chats.markRead(chatId);
  } finally {
    core[Symbol.dispose]();
  }
  const page = await pageOf(user);
  await page.goto(`/chats/${chatId}`);
  const messages = page.getByRole("log", { name: "Messages" });
  const questions = messages.locator('[data-slot="bubble"]');
  // Its newest page: the last question, and a way to earlier ones.
  await expect(
    messages.getByText(`Item ${turns}`, { exact: true })
  ).toBeVisible();
  await expect(
    messages.getByRole("button", { name: "Earlier messages" })
  ).toBeAttached();
  const opened = await questions.count();
  expect(opened).toBeLessThan(turns);

  // Back to the first question, as a reader scrolls: each page comes in
  // over the rows there, which stay where they are on the screen.
  const box = await messages.boundingBox();
  await page.mouse.move(
    (box?.x ?? 0) + (box?.width ?? 0) / 2,
    (box?.y ?? 0) + (box?.height ?? 0) / 2
  );
  const first = messages.getByText(modelScripts.answersEveryQuestion.opener);
  let moved = 0;
  // oxlint-disable-next-line no-await-in-loop -- until the first question shows, a step at a time
  for (let step = 0; step < 200 && !(await first.isVisible()); step += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a wheel step at a time, as a reader scrolls
    const before = await messages.evaluate((log) => {
      const { top } = log.getBoundingClientRect();
      const row = [
        ...log.querySelectorAll<HTMLElement>("[data-message-id]"),
      ].find((each) => each.getBoundingClientRect().bottom > top + 40);
      return {
        id: row?.dataset.messageId ?? "",
        y: row?.getBoundingClientRect().top ?? 0,
        rows: log.querySelectorAll("[data-message-id]").length,
      };
    });
    // oxlint-disable-next-line no-await-in-loop -- see above
    await page.mouse.wheel(0, -300);
    // oxlint-disable-next-line no-await-in-loop -- see above
    await page.waitForTimeout(50);
    // oxlint-disable-next-line no-await-in-loop -- see above
    const after = await messages.evaluate(
      (log, id) => ({
        y:
          log
            .querySelector(`[data-message-id="${CSS.escape(id)}"]`)
            ?.getBoundingClientRect().top ?? 0,
        rows: log.querySelectorAll("[data-message-id]").length,
      }),
      before.id
    );
    if (after.rows > before.rows) {
      // Moved by the wheel alone, never by the rows that came in above.
      moved = Math.max(moved, Math.abs(after.y - before.y - 300));
    }
  }
  await expect(first).toBeVisible();
  await expect(
    messages.getByRole("button", { name: "Earlier messages" })
  ).toHaveCount(0);
  expect(await questions.count()).toBe(turns);
  expect(moved).toBeLessThan(2);
});

test("a person's list follows what happens elsewhere: a chat answered in the background gets its dot, and a question from another tab moves its chat up, with no page change", async ({
  pageOf,
}) => {
  const { user } = peopleIn("chat");
  const page = await pageOf(user);
  const tag = crypto.randomUUID().slice(0, 8);
  const older = `Invoices ${tag}`;
  const newer = `Travel ${tag}`;
  const { core, api } = apiOf(user);
  try {
    const first = { id: await emptyChat(api, older) };
    await emptyChat(api, newer);
    await page.goto("/apps");
    const sidebar = page.getByRole("navigation", { name: "Main" });
    const titles = sidebar
      .getByRole("link")
      .filter({ hasText: tag })
      .filter({ hasNotText: "Answering" });
    await expect(titles).toHaveText([newer, older]);

    // Asked on another device, and answered there while this page stays
    // on Apps: the row moves up and gets its dot, nothing read again.
    await api.chats.send(first.id, {
      text: `${modelScripts.answersAtLength.opener} (${older})`,
      model: e2eModel,
    });
    await expect(
      sidebar.getByRole("link", { name: `${older} Unread` })
    ).toBeVisible({ timeout: 30_000 });
    await expect(titles).toHaveText([`${older}Unread`, newer]);
  } finally {
    core[Symbol.dispose]();
  }

  // A second tab asks in the other chat: the first tab's list reorders.
  const other = await page.context().newPage();
  await other.goto("/");
  await other
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: newer, exact: true })
    .click();
  await other
    .getByRole("textbox", { name: "Ask Grasp" })
    .fill(`${modelScripts.answersAtLength.opener} (${newer})`);
  await other.getByRole("button", { name: "Send", exact: true }).click();
  const sidebar = page.getByRole("navigation", { name: "Main" });
  await expect(
    sidebar.getByRole("link").filter({ hasText: tag }).first()
  ).toContainText(newer);
});

test("a person answers the agent's questions in the box's place, and sends the answers", async ({
  pageOf,
}) => {
  const { user } = peopleIn("chat");
  const page = await pageOf(user);
  const { opener, replies } = modelScripts.asksFirst;
  const [, answer] = replies;
  const question = `${opener} (${crypto.randomUUID().slice(0, 8)})`;
  await page.goto("/");
  await page.getByLabel("Your question").fill(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  // One question at a time, in the box's place, the agent's pick marked.
  const chat = chatPageOf(page);
  const asked = chat.getByRole("group", { name: "Grasp asks" });
  await expect(asked).toContainText("1 of 2", { timeout: 30_000 });
  await expect(chat.getByRole("textbox", { name: "Ask Grasp" })).toHaveCount(0);
  await expect(
    asked.getByRole("radio", { name: "Weekly Recommended" })
  ).toBeVisible();
  await asked.getByRole("radio", { name: /^Weekly/u }).click();
  await asked.getByRole("button", { name: "Next" }).click();
  await asked.getByRole("checkbox", { name: "Me" }).click();
  await asked.getByRole("checkbox", { name: "Finance" }).click();
  await asked.getByRole("button", { name: "Send answer" }).click();

  // Their message is the answers, each after its question; the agent goes on.
  const messages = chat.getByRole("log", { name: "Messages" });
  await expect(
    messages.getByRole("article", { name: "You" }).last()
  ).toContainText("How often should it come?Weekly");
  await expect(
    messages.getByRole("article", { name: "You" }).last()
  ).toContainText("Who should get it?Me and Finance");
  await expect(messages.getByText(answer.text)).toBeVisible({
    timeout: 30_000,
  });
  await expect(chat.getByRole("textbox", { name: "Ask Grasp" })).toBeVisible();
});

test("a person attaches files to a question, takes one off, and sees the question carry the other", async ({
  pageOf,
}) => {
  const { user } = peopleIn("chat");
  const page = await pageOf(user);
  const tag = crypto.randomUUID().slice(0, 8);
  const plan = `plan-${tag}.md`;
  const notes = `notes-${tag}.txt`;
  const question = `What does the plan say ${tag}?`;
  await page.goto("/");

  // Picked with the button's file input: each shows as a card in the box.
  const picker = page.getByRole("main").locator('input[type="file"]');
  await picker.setInputFiles([
    {
      name: plan,
      mimeType: "text/markdown",
      buffer: Buffer.from("# Plan\n\nShip it."),
    },
    { name: notes, mimeType: "text/plain", buffer: Buffer.from("Notes") },
  ]);
  const main = page.getByRole("main");
  await expect(main.getByText(plan)).toBeVisible();
  await main.getByRole("button", { name: `Remove ${notes}` }).click();
  await expect(page.getByText(notes)).toHaveCount(0);
  await expect(page.getByText(plan)).toBeVisible();

  await page.getByLabel("Your question").fill(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  // The question shows the file it carried; the box is empty again.
  const asked = chatPageOf(page)
    .getByRole("log", { name: "Messages" })
    .getByRole("article", { name: "You" })
    .first();
  await expect(asked).toContainText(question);
  await expect(asked).toContainText(plan);
  await expect(
    page.getByRole("main").getByRole("button", { name: `Remove ${plan}` })
  ).toHaveCount(0);
});

test("one control picks the model and how hard it thinks, sends both with the question, and is remembered", async ({
  pageOf,
}) => {
  const { user } = peopleIn("chat");
  const page = await pageOf(user);
  // What the page sends core, to see the question go out with its effort.
  const sent: string[] = [];
  await page.routeWebSocket("**/rpc", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      sent.push(String(message));
      server.send(message);
    });
  });
  const tag = crypto.randomUUID().slice(0, 8);
  await page.goto("/");
  const control = page.getByRole("button", { name: /^Model: /u });

  // The stack's first model doesn't think: the control names it alone.
  await expect(control).toHaveAccessibleName(
    "Model: mistral-large-2512. Change model"
  );
  await control.click();
  // The models by their makers; one that thinks offers its efforts
  // beside the models.
  const models = page.getByRole("option");
  const makers = page.getByRole("listbox", { name: "Makers" });
  await makers.getByRole("option", { name: "Anthropic" }).click();
  await page.getByRole("option", { name: /^claude-sonnet-4-6/u }).click();
  await expect(models).toHaveCount(0);
  await control.click();
  const effort = page.getByRole("group", { name: "How hard it thinks" });
  await expect(effort.getByRole("button")).toHaveText([
    "Low",
    "Medium",
    "High",
    "Max",
  ]);
  await effort.getByRole("button", { name: "Max" }).click();
  await page.keyboard.press("Escape");
  await expect(models).toHaveCount(0);
  await expect(control).toHaveAccessibleName(
    "Model: claude-sonnet-4-6, thinking max. Change model or thinking"
  );

  const question = `Think hard ${tag}.`;
  await page.getByLabel("Your question").fill(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const chat = chatPageOf(page);
  await expect(
    chat
      .getByRole("log", { name: "Messages" })
      .getByRole("article", { name: "You" })
      .first()
  ).toContainText(question);
  // The question, not the new chat named after it.
  const asked = sent.find(
    (message) => message.includes('"send"') && message.includes(question)
  );
  expect(asked).toContain('"effort":"max"');
  expect(asked).toContain('"model":"anthropic/claude-sonnet-4-6"');

  // Kept for the person in this browser: back on Chat's start, loaded anew.
  await page.goto("/");
  await expect(control).toHaveAccessibleName(
    "Model: claude-sonnet-4-6, thinking max. Change model or thinking"
  );
});

test("the chat on every other page carries on the open chat, and Chat starts afresh", async ({
  pageOf,
}) => {
  const { user } = peopleIn("globalChat");
  const page = await pageOf(user);
  const tag = crypto.randomUUID().slice(0, 8);
  const question = `From another page ${tag}?`;

  // Opened from its bar on another page, it takes a question there.
  await page.goto("/apps");
  const chat = page.getByRole("region", { name: "Chat" });
  // The bar's box while the chat is closed, the chat's own while it is open:
  // one text, shown in one at a time.
  const box = page.getByRole("textbox", { name: "Ask Grasp" });
  await page.getByRole("button", { name: "Show or hide the chat" }).click();
  await expect(chat).toBeVisible();
  // The box takes a question once the chat has read the models core
  // offers, as its Send shows: Enter before then sends nothing.
  const send = chat.getByRole("button", { name: "Send", exact: true });
  await box.fill(question);
  await expect(send).toBeEnabled();
  await box.press("Enter");
  const messages = chat.getByRole("log", { name: "Messages" });
  await expect(
    messages.getByRole("article", { name: "You" }).first()
  ).toContainText(question);
  await expect(messages.getByRole("alert")).toContainText(
    "Your AI provider is refusing your key. Ask your admin to check or replace it in Settings › AI providers.",
    { timeout: 30_000 }
  );
  // The page stayed where it was.
  expect(new URL(page.url()).pathname).toBe("/apps");

  // Closed, it is the bar again; what is typed there is still there as
  // the chat opens again, on the same chat.
  await chat.getByRole("button", { name: "Close" }).click();
  await expect(chat).toBeHidden();
  await box.fill(`Half a thought ${tag}`);
  await page.keyboard.press("ControlOrMeta+j");
  await expect(
    messages.getByRole("article", { name: "You" }).first()
  ).toContainText(question);
  await expect(box).toHaveText(`Half a thought ${tag}`);

  // On another page it is still open, on the same chat; a new chat starts
  // afresh.
  await page.goto("/projects");
  await expect(
    messages.getByRole("article", { name: "You" }).first()
  ).toContainText(question);
  await chat.getByRole("button", { name: "More actions" }).click();
  // Its menu renames it too, where its name stands.
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  await page.getByRole("menuitem", { name: "New chat" }).click();
  await expect(messages).toHaveCount(0);
  const second = `Another from another page ${tag}?`;
  await box.fill(second);
  // A page load reads the models again.
  await expect(send).toBeEnabled();
  await box.press("Enter");
  await expect(
    messages.getByRole("article", { name: "You" }).first()
  ).toContainText(second);

  // On Chat, from the sidebar, there is no chat beside the page nor its
  // bar (the page is where to ask), and both chats are in its window.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Chat" })
    .click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(chat).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Show or hide the chat" })
  ).toHaveCount(0);
  const chats = await chatsWindow(page);
  await expect(rowOf(chats, second)).toBeVisible();
  await expect(rowOf(chats, question)).toBeVisible();
});
