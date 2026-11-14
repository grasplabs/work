import { describe, expect, it } from "vite-plus/test";

import { chatOf, codeResults, codeStep, model, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// A turn nobody asked for there and then (`Workspace.askUnattended`): what
// wakes an agent asks through it. These start from the ways it can fail:
// a change going out with nobody there; a change held for good; a write
// that never passes connect (offering a workflow) made anyway; the same
// chat's next turn, which a person asks, still only reading.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const invoiceMail = { to: "ben@acme.test", subject: "Invoice INV-7" };

/** The chat's code calls `action` of the mail app with `input`, and says how it went. */
const calls = (action: string, input: unknown) =>
  codeStep(
    `export default async (self, env) => { try { const { pending } = await env.connections.call("MAIL", ${JSON.stringify(action)}, ${JSON.stringify(input)}); return pending === null ? "done" : "held"; } catch (error) { return error.message; } };`
  );

const filing = { query: "invoices due" };

/**
 * A change of the company's own things: the mail app's search, which the
 * admin here didn't mark as a read, so connect takes it for a change of
 * what it reaches, the company's.
 */
const changes = calls("mail.search", filing);

/** Reaches someone outside the chat: mail to Ben. */
const sendsMail = calls("mail.send", invoiceMail);

/** The chat's person, a mail connection its agent may send through, and both ways to ask. */
const setUp = async (...replies: Parameters<typeof chatOf>[1][]) => {
  const person = await signedInApi(idp, "user");
  const admin = await signedInApi(idp, "admin");
  const mail = await mailConnection([], ["mail.send", "mail.search"]);
  const chat = await chatOf(person.userId, ...replies);
  await requestGranted(idp, admin, {
    subject: chat.agent,
    object: { type: "connection", connectionId: mail.id },
    actions: ["mail.send", "mail.search"],
    binding: "MAIL",
  });
  const woken = async (text: string) =>
    await chat.stub.askUnattended(chat.chat.id, { text, model });
  const said = async () => {
    const results = await codeResults(chat.stub, chat.chat.id);
    return results.map(({ text }) => text);
  };
  return { person, mail, chat, woken, said };
};

describe("a turn nobody was there for", setUpTime, () => {
  it("holds a change through a connection for its person, said as unattended and ending with the day, and makes it once they confirm", async () => {
    const { person, mail, woken, said } = await setUp(
      changes,
      says("It waits for you.")
    );
    await woken("File the invoices that are due.");

    const [held, ...others] = await person.api.pendingActions.list();
    const { calls: reached } = await mail.did();
    expect({
      said: await said(),
      action: held?.action,
      input: held?.input,
      unattended: held?.unattended,
      ends: held?.endsAt === undefined ? "never" : "with the day",
      others: others.length,
      calls: reached,
    }).toStrictEqual({
      said: ["Returned:\nheld"],
      action: "mail.search",
      input: JSON.stringify(filing),
      unattended: true,
      ends: "with the day",
      others: 0,
      calls: 0,
    });

    const confirmed = await outcome(
      person.api.pendingActions.confirm(held?.id ?? "", held?.inputHash ?? "")
    );
    const again = await outcome(
      person.api.pendingActions.confirm(held?.id ?? "", held?.inputHash ?? "")
    );
    expect({
      confirmed,
      again,
      waiting: await person.api.pendingActions.list(),
    }).toStrictEqual({
      confirmed: "ok",
      again: "connect.pending_not_found",
      waiting: [],
    });
  });

  it("isn't offered what reaches other people: mail to someone is refused, not even held", async () => {
    const { person, mail, woken, said } = await setUp(
      sendsMail,
      says("I can't send that.")
    );
    await woken("Send the invoices that are due.");
    expect({
      said: await said(),
      waiting: await person.api.pendingActions.list(),
      sent: await mail.did(),
    }).toStrictEqual({
      said: [
        "Returned:\nYour company hasn't turned this kind of action on for you, so it wasn't done. An admin can turn it on.",
      ],
      waiting: [],
      sent: { calls: 0, sent: [] },
    });
  });

  it("holds what a person asks for in the same chat without saying unattended, and for as long as they take", async () => {
    const { person, chat } = await setUp(sendsMail, says("It waits for you."));
    await chat.ask("Send Ben the invoice.");
    const [held] = await person.api.pendingActions.list();
    expect({
      unattended: held !== undefined && "unattended" in held,
      ends: held?.endsAt === undefined ? "never" : "with the day",
    }).toStrictEqual({ unattended: false, ends: "never" });
  });

  it("offers no workflow to start on a card, in a chat that came through a chat app", async () => {
    const person = await signedInApi(idp, "user");
    const chat = await chatOf(
      person.userId,
      codeStep(
        'export default async (self, env) => { try { await env.workflows.offer("workflow-1", {}); return "offered"; } catch (error) { return error.message; } };'
      ),
      says("I can't offer that now.")
    );
    const inTeams = await chat.stub.createChat(
      "From Teams",
      person.userId,
      chat.id,
      undefined,
      "teams"
    );
    await chat.stub.askUnattended(inTeams.id, { text: "Start it.", model });
    const [result] = await codeResults(chat.stub, inTeams.id);
    expect(result?.text).toBe(
      "Returned:\nNobody asked for this just now, so the agent can only read. What it wants to change waits for its person."
    );
  });
});
