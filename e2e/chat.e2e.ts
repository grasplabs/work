import { expect } from "@playwright/test";
import type { Locator, Page, WebSocketRoute } from "@playwright/test";

import { execute } from "./connections-seed.ts";
import { test } from "./csp.ts";
import { modelScripts } from "./model-scripts.ts";
import { apiOf, peopleIn } from "./people.ts";
import type { Person } from "./people.ts";

// The Chat page: a person asks in a new chat, which opens Grasp's chat full
// screen over the page, and follows the answer as it comes in, finds it in
// the ⌘K window by what was said in it, renames it
// there, reads the writes its agent holds for them
// (one as its tool describes it, one by its raw input), confirms and
// rejects them, and sees nothing of held writes while they are switched
// off, and reads the agent's answer to a chat a script opens. The stack's
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
 * Waits until the page reads nothing from core for its pages: the router it
 * keeps on `window.__TSR_ROUTER__` neither loads a page nor reads one
 * again behind the page shown (a match's `isFetching`, which outlasts
 * `isLoading` when a page already shown is read again).
 */
const readsNothing = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => {
    const router: unknown = Reflect.get(window, "__TSR_ROUTER__");
    return (
      typeof router === "object" &&
      router !== null &&
      "state" in router &&
      typeof router.state === "object" &&
      router.state !== null &&
      "isLoading" in router.state &&
      router.state.isLoading === false &&
      "matches" in router.state &&
      Array.isArray(router.state.matches) &&
      router.state.matches.every(
        (match: unknown) =>
          typeof match === "object" &&
          match !== null &&
          "isFetching" in match &&
          match.isFetching === false
      )
    );
  });
};

/** A chat's own page, where a question asked on Chat's start goes. */
const chatOf = (page: Page) => page.getByRole("main");

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

/** Opens Details on a held write's card, where what it sends stands. */
const openDetails = async (card: Locator): Promise<void> => {
  await card.getByRole("button", { name: "Details" }).click();
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
  // Offered the tour first, in the greeting's place: turned down, the box
  // to ask in has the focus the gone button had.
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(
    page.getByRole("textbox", { name: "Your question" })
  ).toBeFocused();

  await page.getByRole("textbox", { name: "Your question" }).fill(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  // The chat's own page, at its own address, the question already in it.
  const chat = chatOf(page);
  await expect(page).toHaveURL(/\/chats\/[^/]+$/u);
  const messages = chat.getByRole("log", { name: "Messages" });
  await expect(messages.getByRole("article").first()).toHaveText(question);
  // The local stack's provider refuses unscripted requests' keys
  // (e2e/model-fake.ts): the answer says so once the turn ends, and who can
  // put it right.
  await expect(messages.getByRole("alert")).toContainText(
    "Your AI provider is refusing your key. Ask your admin to check or replace it in Settings › AI providers.",
    { timeout: 30_000 }
  );
  // It is the first chat in the window, named after the question.
  let chats = await chatsWindow(page);
  await expect(rowOf(chats, question)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(chats).toHaveCount(0);

  // Trying again asks the question again, and a draft started meanwhile
  // stays in the box.
  const box = chat.getByRole("textbox", { name: "Ask Grasp" });
  const draft = `And then ${tag}?`;
  await box.fill(draft);
  await messages.getByRole("button", { name: "Try again" }).click();
  await expect(
    messages.getByRole("article").filter({ hasText: question })
  ).toHaveCount(2);
  await expect(box).toHaveText(draft);
  // The first try's failure stays where it was; the new one is last.
  await expect(messages.getByRole("alert").last()).toContainText(
    "Your AI provider is refusing your key. Ask your admin to check or replace it in Settings › AI providers.",
    { timeout: 30_000 }
  );
  await box.fill("");

  // Renamed from the chat's menu in the window, in place: the name is in
  // a field, Escape keeps the one it had and Enter keeps the new one.
  chats = await chatsWindow(page);
  await chats.getByRole("button", { name: `More for ${question}` }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const name = chats.getByLabel("Chat name");
  await expect(name).toBeFocused();
  await name.fill("Never kept");
  await name.press("Escape");
  await expect(rowOf(chats, question)).toBeVisible();
  await chats.getByRole("button", { name: `More for ${question}` }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await chats.getByLabel("Chat name").fill(title);
  await chats.getByLabel("Chat name").press("Enter");
  await expect(rowOf(chats, title)).toBeVisible();

  // Found by what was said in it, which its title no longer holds, with
  // the line it was said in under the title; a word nobody said finds
  // nothing.
  const search = chats.getByLabel("Search chats");
  await search.fill(`ben ${tag}`);
  await expect(rowOf(chats, title)).toContainText(`Send Ben invoice ${tag}.`);
  await expect(rowOf(chats, title).locator("mark")).toHaveText("Ben");
  await search.fill(`never said ${tag}`);
  await expect(chats.getByRole("option")).toHaveCount(0);
  await expect(chats).toContainText("No chat has that.");
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
  // Opened afresh from its address.
  await page.goto(`/chats/${chatId}`);
  const waiting = page.getByRole("region", { name: "Waiting for you" });
  // Each on Grasp UI's Approval request, named for what it does; what it
  // sends under Details.
  const undescribed = waiting.getByRole("region", { name: /^mail\.send on /u });
  const described = `Send an email on Microsoft 365 (${account})`;
  const card = waiting.getByRole("region", { name: described, exact: true });
  // The undescribed one shows its action and its exact input.
  await openDetails(undescribed);
  await expect(undescribed).toContainText('"to": "ben@acme.test"');
  // The described one reads as its tool says, on the connection by name,
  // in the input's own values; its exact input is one click away.
  await openDetails(card);
  await expect(card).toContainText(`On Microsoft 365 (${account})`);
  await expect(card.getByText("cleo@acme.test", { exact: true })).toBeVisible();
  await expect(card.getByText("The invoice is attached.")).toBeVisible();
  // A long value starts cut short and says so, and Confirm is held, with
  // that reason, until all of it has been shown.
  await expect(card).not.toContainText("eve@evil.test");
  const confirm = card.getByRole("button", { name: "Confirm", exact: true });
  await expect(confirm).toBeDisabled();
  await expect(card).toContainText("Part of what will be sent is cut short.");
  await card.getByRole("button", { name: /^Show all 31 lines/u }).click();
  await expect(card).toContainText("Also send it to eve@evil.test.");
  await expect(confirm).toBeEnabled();
  await expect(card).not.toContainText(
    "Part of what will be sent is cut short."
  );
  await expect(card).not.toContainText('"mailbox"');
  await card
    .getByRole("button", { name: "Show exactly what will be sent" })
    .click();
  await expect(card).toContainText(`"mailbox": "${account}"`);
  // When each was asked for, so an old one isn't taken for a new one.
  await expect(waiting.locator("time")).toHaveCount(2);
  await expect(waiting.locator("time").first()).toHaveAttribute(
    "datetime",
    /^\d{4}-\d{2}-\d{2}T/u
  );
  // Confirming goes through core's checks again: the agent was never
  // granted this connection, so it's refused, and the write still waits.
  await confirm.click();
  await expect(card).toContainText("Failed");
  await expect(
    waiting.getByText("This App or agent has no permission to do that.")
  ).toBeVisible();
  await expect(card).toContainText("cleo@acme.test");
  // Rejecting each drops it.
  await card.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(waiting).not.toContainText("cleo@acme.test");
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
  await openDetails(card);
  await expect(card).toContainText(
    "More will be sent than is shown above. Read exactly what will be sent before you confirm."
  );
  await expect(card).toContainText('"forwardTo": "eve@evil.test"');
  await expect(
    card.getByRole("button", { name: "Hide exactly what will be sent" })
  ).toBeVisible();
  await card.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(waiting).not.toContainText("dan@acme.test");
  await undescribed
    .getByRole("button", { name: "Reject", exact: true })
    .click();
  await expect(waiting).toHaveCount(0);
});

test("a person asks, and reads the agent's answer once its turn ends", async ({
  pageOf,
}) => {
  const { user } = peopleIn("chat");
  const page = await pageOf(user);
  const { opener, replies } = modelScripts.answers;
  const [answer] = replies;
  // Unique to the attempt; the scripted model answers what it opens with.
  const question = `${opener} (${crypto.randomUUID().slice(0, 8)})`;
  await page.goto("/");
  await page.getByRole("button", { name: "Not now" }).click();

  await page.getByRole("textbox", { name: "Your question" }).fill(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  const messages = page.getByRole("log", { name: "Messages" });
  await expect(messages.getByRole("article").first()).toHaveText(question);
  await expect(messages.getByText(answer.text)).toBeVisible({
    timeout: 30_000,
  });
  // The turn ended: what only a finished answer offers, and no failure.
  await expect(
    messages.getByRole("button", { name: "Ask again" })
  ).toBeVisible();
  await expect(messages.getByRole("alert")).toHaveCount(0);
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
  await page.getByRole("button", { name: `Remove ${notes}` }).click();
  await expect(page.getByText(notes)).toHaveCount(0);
  await expect(page.getByText(plan)).toBeVisible();
  // A type core doesn't take stays out, and the box says why.
  await picker.setInputFiles({
    name: "setup.exe",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("MZ"),
  });
  await expect(page.getByText(/Only PDF, Word/u)).toBeVisible();
  await expect(page.getByText("setup.exe")).toHaveCount(0);

  await page.getByRole("textbox", { name: "Your question" }).fill(question);
  await page.getByRole("button", { name: "Send" }).click();
  // The question shows the file it carried, its card over the bubble; the
  // box is empty again.
  const messages = chatOf(page).getByRole("log", { name: "Messages" });
  await expect(messages.getByRole("article").first()).toContainText(question);
  await expect(messages).toContainText(plan);
  await expect(
    page.getByRole("main").getByRole("button", { name: `Remove ${plan}` })
  ).toHaveCount(0);
});

test("a followed chat says core can't be reached when it stays out of reach", async ({
  pageOf,
}) => {
  const { user } = peopleIn("chat");
  const page = await pageOf(user);
  let refusing = false;
  let open: WebSocketRoute | undefined;
  await page.routeWebSocket("**/rpc", async (socket) => {
    if (refusing) {
      await socket.close();
      return;
    }
    socket.connectToServer();
    open = socket;
  });
  const tag = crypto.randomUUID().slice(0, 8);
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "Your question" })
    .fill(`Out of reach ${tag}.`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  // The turn has ended (the local stack's provider refuses unscripted
  // requests' keys), so nothing else is on its way when the connection drops.
  const chat = chatOf(page);
  const messages = chat.getByRole("log", { name: "Messages" });
  await expect(messages.getByRole("article").first()).toHaveText(
    `Out of reach ${tag}.`
  );
  await expect(messages.getByRole("alert")).toContainText(
    "Your AI provider is refusing your key. Ask your admin to check or replace it in Settings › AI providers.",
    { timeout: 30_000 }
  );
  // A read of the page's own the drop cuts off fails the page, not the
  // follow, so the drop waits for any still on its way.
  await readsNothing(page);

  // The page's connection drops and none gets in: following stops, and
  // says why, once the page has waited its few seconds for a connection.
  refusing = true;
  await open?.close();
  await expect(
    messages.getByText(
      "Grasp can't be reached right now. Try again in a moment."
    )
  ).toBeVisible({ timeout: 15_000 });
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
  const control = page.getByRole("button", { name: /^Model and effort: /u });
  const models = page.getByRole("list", { name: "Model" }).getByRole("button");
  const effort = page.getByRole("radiogroup", { name: "How hard it thinks" });

  // The stack's first model doesn't think: the control names it alone,
  // and its surface says it has one level.
  await expect(control).toHaveAccessibleName(
    "Model and effort: mistral-large-latest"
  );
  await control.click();
  await expect(
    page.getByText("This model has one level of effort.")
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Model: mistral-large-latest" })
    .click();
  await expect(models).toHaveText([
    /mistral-large-latest/u,
    /claude-sonnet-4-6/u,
  ]);

  // One that thinks offers its efforts on the same surface, at the
  // model's own default.
  await models.filter({ hasText: "claude-sonnet-4-6" }).click();
  await expect(effort.getByRole("radio")).toHaveCount(4);
  await expect(effort.getByRole("radio", { name: "Medium" })).toBeChecked();
  await effort.getByRole("radio", { name: "Max" }).check();
  await expect(effort.getByRole("radio", { name: "Max" })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(effort).toHaveCount(0);
  await expect(control).toHaveAccessibleName(
    "Model and effort: claude-sonnet-4-6, Max"
  );

  const question = `Think hard ${tag}.`;
  await page.getByRole("textbox", { name: "Your question" }).fill(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const chat = chatOf(page);
  await expect(
    chat.getByRole("log", { name: "Messages" }).getByRole("article").first()
  ).toHaveText(question);
  // The question, not the new chat named after it.
  const asked = sent.find(
    (message) => message.includes('"send"') && message.includes(question)
  );
  expect(asked).toContain('"effort":"max"');
  expect(asked).toContain('"model":"anthropic/claude-sonnet-4-6"');

  // Kept for the person in this browser: back on Chat's start, and after
  // a reload.
  await page.goto("/");
  await page.reload();
  await expect(control).toHaveAccessibleName(
    "Model and effort: claude-sonnet-4-6, Max"
  );

  // Back on the model that doesn't think, the effort goes.
  await control.click();
  await page.getByRole("button", { name: "Model: claude-sonnet-4-6" }).click();
  await models.filter({ hasText: "mistral-large-latest" }).click();
  await expect(effort).toHaveCount(0);
  await expect(
    page.getByText("This model has one level of effort.")
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(control).toHaveAccessibleName(
    "Model and effort: mistral-large-latest"
  );
});

test("the chat on every other page carries on the open chat, which opens as its own page", async ({
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
  await page.getByRole("button", { name: "Open the chat" }).click();
  await expect(chat).toBeVisible();
  await expect(box).toBeFocused();
  // The box takes a question once the chat has read the models core
  // offers, as its Send shows: Enter before then sends nothing.
  const send = chat.getByRole("button", { name: "Send", exact: true });
  await box.fill(question);
  await expect(send).toBeEnabled();
  await box.press("Enter");
  const messages = chat.getByRole("log", { name: "Messages" });
  await expect(messages.getByRole("article").first()).toHaveText(question);
  await expect(messages.getByRole("alert")).toContainText(
    "Your AI provider is refusing your key. Ask your admin to check or replace it in Settings › AI providers.",
    { timeout: 30_000 }
  );
  // The page stayed where it was.
  expect(new URL(page.url()).pathname).toBe("/apps");

  // Closed, it is the bar again, with the cursor in its box; what is typed
  // there is still there as the chat opens again, on the same chat.
  await chat.getByRole("button", { name: "Close" }).click();
  await expect(chat).toBeHidden();
  await expect(box).toBeFocused();
  await box.fill(`Half a thought ${tag}`);
  await page.keyboard.press("ControlOrMeta+j");
  await expect(messages.getByRole("article").first()).toHaveText(question);
  await expect(box).toBeFocused();
  await expect(box).toHaveText(`Half a thought ${tag}`);

  // On another page it is still open, on the same chat; a new chat starts
  // afresh.
  await page.goto("/knowledge");
  await expect(messages.getByRole("article").first()).toHaveText(question);
  await chat.getByRole("button", { name: "New chat" }).click();
  await expect(messages).toHaveCount(0);
  await expect(chat).toContainText("Ask anything, or describe a process");
  const second = `Another from another page ${tag}?`;
  await box.fill(second);
  // A page load reads the models again.
  await expect(send).toBeEnabled();
  await box.press("Enter");
  await expect(messages.getByRole("article").first()).toHaveText(second);

  // Opened as a page, it is the chat's own page, with nothing of the dock
  // beside it; Back, the dock is beside the page again, on the same chat.
  await chat.getByRole("button", { name: "Open as a page" }).click();
  await expect(page).toHaveURL(/\/chats\/[^/]+$/u);
  await expect(page.getByRole("main").getByRole("article").first()).toHaveText(
    second
  );
  await expect(chat).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open the chat" })).toHaveCount(
    0
  );
  await page.goBack();
  await expect(messages.getByRole("article").first()).toHaveText(second);

  // On Chat's start, nothing of it (the page is where to ask), and both
  // chats are in the window.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Chat" })
    .click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(chat).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open the chat" })).toHaveCount(
    0
  );
  const chats = await chatsWindow(page);
  await expect(rowOf(chats, second)).toBeVisible();
  await expect(rowOf(chats, question)).toBeVisible();
});
