import { expect } from "@playwright/test";
import type { WebSocketRoute } from "@playwright/test";

import { execute } from "./connections-seed.ts";
import { test } from "./csp.ts";
import { pageOf, peopleIn } from "./people.ts";
import type { Person } from "./people.ts";

// The Chat page: a person asks in a new chat and follows the answer as it
// comes in, renames the chat, reads the writes its agent holds for them
// (one as its tool describes it, one by its raw input), confirms and
// rejects them, and sees nothing of held writes while they are switched
// off. The local stack reaches no model, so the answer is the
// gateway's failure; streaming, resuming and the person check themselves
// are core's tests (apps/core/test/chats.test.ts).

const quoted = (text: string): string => `'${text.replaceAll("'", "''")}'`;

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
  browser,
}) => {
  const { user } = peopleIn("chat");
  const page = await pageOf(browser, user);
  // Unique to the attempt, so each finds its own chat in the list.
  const tag = crypto.randomUUID().slice(0, 8);
  const question = `Send Ben invoice ${tag}.`;
  const title = `Invoice ${tag}`;
  await page.goto("/");

  await page.getByLabel("Your question").fill(question);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/[?&]chat=/u);
  const messages = page.getByRole("list", { name: "Messages" });
  await expect(messages.getByRole("listitem").first()).toHaveText(question);
  // No model answers here: the answer says so once the turn ends.
  await expect(messages.getByRole("alert")).toHaveText(
    "The model call failed.",
    { timeout: 30_000 }
  );
  const chats = page.getByRole("navigation", { name: "Recent chats" });
  await expect(chats.getByRole("link", { name: question })).toBeVisible();

  // Trying again asks the question again, and a draft started meanwhile
  // stays in the box.
  const box = page.getByLabel("Your question");
  const draft = `And then ${tag}?`;
  await box.fill(draft);
  await messages.getByRole("button", { name: "Try again" }).click();
  await expect(
    messages.getByRole("listitem").filter({ hasText: question })
  ).toHaveCount(2);
  await expect(box).toHaveValue(draft);
  await expect(messages.getByRole("alert")).toHaveText(
    "The model call failed.",
    { timeout: 30_000 }
  );
  await box.fill("");

  // Renamed from the chat's menu in the list.
  await chats.getByRole("button", { name: `More for ${question}` }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  // In place: the name is in a field, Enter keeps it.
  const name = chats.getByLabel("Chat name");
  await expect(name).toBeFocused();
  await name.fill(`Draft ${tag}`);
  await name.press("Enter");
  await expect(chats.getByRole("link", { name: `Draft ${tag}` })).toBeVisible();

  // A double click renames it too, rather than opening it; Escape keeps
  // the name it had.
  await chats.getByRole("link", { name: `Draft ${tag}` }).dblclick();
  await chats.getByLabel("Chat name").fill("Never kept");
  await chats.getByLabel("Chat name").press("Escape");
  await expect(chats.getByRole("link", { name: `Draft ${tag}` })).toBeFocused();
  await chats.getByRole("link", { name: `Draft ${tag}` }).dblclick();
  await chats.getByLabel("Chat name").fill(title);
  await chats.getByLabel("Chat name").press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  await expect(chats.getByRole("link", { name: title })).toBeVisible();
  // One line per chat: its title alone.
  await expect(chats.getByRole("link", { name: title })).toHaveText(title);

  const chatId = new URL(page.url()).searchParams.get("chat") ?? "";
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
  await page.reload();
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
  // When each was asked for, so an old one isn't taken for a new one.
  await expect(waiting.locator("time")).toHaveCount(2);
  await expect(waiting.locator("time").first()).toHaveAttribute(
    "datetime",
    /^\d{4}-\d{2}-\d{2}T/u
  );
  // Confirming goes through core's checks again: the agent was never
  // granted this connection, so it's refused, and the write still waits.
  await waiting.getByRole("button", { name: `Confirm ${described}` }).click();
  await expect(waiting.getByRole("alert")).toHaveText(
    "This App or agent has no permission to do that."
  );
  await expect(waiting).toContainText("cleo@acme.test");
  // Rejecting each drops it.
  await waiting.getByRole("button", { name: `Reject ${described}` }).click();
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
  await page.reload();
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

test("a followed chat says core can't be reached when it stays out of reach", async ({
  browser,
}) => {
  const { user } = peopleIn("chat");
  const page = await pageOf(browser, user);
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
  await page.getByLabel("Your question").fill(`Out of reach ${tag}.`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/[?&]chat=/u);
  // The turn has ended (the local stack reaches no model), so nothing
  // else is on its way when the connection drops.
  const messages = page.getByRole("list", { name: "Messages" });
  await expect(messages.getByRole("listitem").first()).toHaveText(
    `Out of reach ${tag}.`
  );
  await expect(messages.getByRole("alert")).toHaveText(
    "The model call failed.",
    { timeout: 30_000 }
  );
  await expect(
    page
      .getByRole("navigation", { name: "Recent chats" })
      .getByRole("link", { name: `Out of reach ${tag}.` })
  ).toBeVisible();

  // The page's connection drops and none gets in: following stops, and
  // says why, once the page has waited its few seconds for a connection.
  refusing = true;
  await open?.close();
  await expect(
    page.getByText("Grasp can't be reached right now. Try again in a moment.")
  ).toBeVisible({ timeout: 15_000 });
});

test("one control picks the model and how hard it thinks, sends both with the question, and is remembered", async ({
  browser,
}) => {
  const { user } = peopleIn("chat");
  const page = await pageOf(browser, user);
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

  // The default model doesn't think: the control names it alone.
  await expect(control).toHaveAccessibleName(
    "Model: llama-3.3-70b-instruct-fp8-fast. Change model"
  );
  await control.click();
  const choices = page.getByRole("menuitemradio");
  await expect(choices).toHaveText([
    /llama-3\.3-70b-instruct-fp8-fast/u,
    /glm-5\.3-flash/u,
  ]);

  // One that thinks offers its efforts in the same menu, which stays open
  // for them, at the model's own default.
  await page.getByRole("menuitemradio", { name: /^glm-5\.3-flash/u }).click();
  await expect(choices).toHaveText([
    /llama-3\.3-70b-instruct-fp8-fast/u,
    /glm-5\.3-flash/u,
    "Low",
    "High",
    "Max",
  ]);
  await expect(
    page.getByRole("menuitemradio", { name: "High" })
  ).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Max" }).click();
  await page.keyboard.press("Escape");
  await expect(choices).toHaveCount(0);
  await expect(control).toHaveAccessibleName(
    "Model: glm-5.3-flash, thinking max. Change model or thinking"
  );

  const question = `Think hard ${tag}.`;
  await page.getByLabel("Your question").fill(question);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/[?&]chat=/u);
  await expect(
    page.getByRole("list", { name: "Messages" }).getByRole("listitem").first()
  ).toHaveText(question);
  // The question, not the new chat named after it.
  const asked = sent.find(
    (message) => message.includes('"send"') && message.includes(question)
  );
  expect(asked).toContain('"effort":"max"');
  expect(asked).toContain('"model":"workers-ai/@cf/zai-org/glm-5.3-flash"');

  // Kept for the person in this browser.
  await page.reload();
  await expect(control).toHaveAccessibleName(
    "Model: glm-5.3-flash, thinking max. Change model or thinking"
  );

  // Back on the model that doesn't think, the effort goes.
  await control.click();
  await page
    .getByRole("menuitemradio", { name: /^llama-3\.3-70b-instruct-fp8-fast/u })
    .click();
  await expect(choices).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(control).toHaveAccessibleName(
    "Model: llama-3.3-70b-instruct-fp8-fast. Change model"
  );
});

test("the side panel opens in a sheet over the chat on a narrow screen, and beside it on a wide one", async ({
  browser,
}) => {
  const { user } = peopleIn("chat");
  const page = await pageOf(browser, user);
  const tag = crypto.randomUUID().slice(0, 8);
  await page.goto("/");
  await page.getByLabel("Your question").fill(`Panel ${tag}.`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/[?&]chat=/u);
  const panel = page.getByRole("complementary", { name: "Side panel" });

  // A phone: a sheet over the chat, closed from itself.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("button", { name: "Side panel" }).click();
  const sheet = page.getByRole("dialog", { name: "Side panel" });
  await expect(sheet).toBeVisible();
  await expect(panel).toHaveCount(0);
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);

  // A wide screen: beside the chat, which keeps its room.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Side panel" }).click();
  await expect(panel.getByRole("button", { name: "Close" })).toBeHidden();
  const beside = await panel.boundingBox();
  const chat = await page
    .getByRole("region", { name: `Panel ${tag}.` })
    .boundingBox();
  expect({
    fits: (beside?.x ?? 0) + (beside?.width ?? 0) <= 1440,
    besideTheChat: (chat?.x ?? 0) + (chat?.width ?? 0) <= (beside?.x ?? 0),
  }).toStrictEqual({ fits: true, besideTheChat: true });
});

test("the chat dock on every other page carries on the open chat, which is the same chat in Chat", async ({
  browser,
}) => {
  const { user } = peopleIn("chatDock");
  const page = await pageOf(browser, user);
  const tag = crypto.randomUUID().slice(0, 8);
  const question = `From the dock ${tag}?`;

  // Asked from another page, it opens around the box and streams there.
  await page.goto("/domains");
  const box = page.getByRole("textbox", { name: "Ask Grasp" });
  await box.fill(question);
  await box.press("Enter");
  const dock = page.getByRole("region", { name: "Ask Grasp" });
  const messages = dock.getByRole("list", { name: "Messages" });
  await expect(messages.getByRole("listitem").first()).toHaveText(question);
  await expect(messages.getByRole("alert")).toHaveText(
    "The model call failed.",
    { timeout: 30_000 }
  );
  // The page stayed where it was.
  expect(new URL(page.url()).pathname).toBe("/domains");

  // Folded away, it is the bar again, and opens again on the same chat,
  // the cursor in the box all along, and what was typed still there.
  await dock.getByRole("button", { name: "Fold the chat away" }).click();
  await expect(dock).toHaveCount(0);
  await expect(box).toBeFocused();
  await box.fill(`Half a thought ${tag}`);
  await page.getByRole("button", { name: "Open the chat" }).click();
  await expect(messages.getByRole("listitem").first()).toHaveText(question);
  await expect(box).toBeFocused();
  await expect(box).toHaveValue(`Half a thought ${tag}`);

  // It is the chat in Chat, in its list, where the dock isn't.
  await dock.getByRole("link", { name: "Open in chat" }).click();
  await expect(page).toHaveURL(/[?&]chat=/u);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(question);
  await expect(
    page
      .getByRole("navigation", { name: "Recent chats" })
      .getByRole("link", { name: question, exact: true })
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Ask Grasp" })).toHaveCount(0);

  // A new chat from the dock starts afresh.
  await page.goto("/knowledge");
  await page.getByRole("button", { name: "Open the chat" }).click();
  await dock.getByRole("button", { name: "New chat" }).click();
  await expect(dock.getByRole("list", { name: "Messages" })).toHaveCount(0);
  await expect(dock).toContainText("Ask anything, or describe a process");
  const second = `Another from the dock ${tag}?`;
  await box.fill(second);
  await box.press("Enter");
  await expect(messages.getByRole("listitem").first()).toHaveText(second);

  // Chat, from the sidebar, opens on the dock's chat, and both chats are
  // in its list.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Chat" })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(second);
  const list = page.getByRole("navigation", { name: "Recent chats" });
  await expect(
    list.getByRole("link", { name: second, exact: true })
  ).toBeVisible();
  await expect(
    list.getByRole("link", { name: question, exact: true })
  ).toBeVisible();
});
