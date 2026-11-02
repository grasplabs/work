import type { AuditEvent } from "@grasp-os/shared/audit";
import { connectErrors } from "@grasp-os/shared/connect";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { withheldResult } from "../src/agent.ts";
import {
  chatOf,
  codeResults,
  codeStep,
  model,
  says,
  transcript,
} from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection, mailWithSearch } from "./mail-connection.ts";
import { fakeProvider } from "./model-provider.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// `env.connections` in a chat's code: the chat's agent acting through the
// connections it was granted, for its person. These tests start from the
// ways it can fail: a write goes out before the person confirms it; the
// agent reaches a connection it wasn't granted, or someone else's personal
// connection (R5); a call leaves no trace; and what a connection returned
// reaches a model the client's rules forbid for that connection's data, in
// a later turn.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const invoiceMail = { to: "ben@acme.test", subject: "Invoice INV-7" };

/** The chat's person, an admin to grant, and a mail connection. */
const setUp = async (...replies: Parameters<typeof chatOf>[1][]) => {
  const person = await signedInApi(idp, "user");
  const admin = await signedInApi(idp, "admin");
  const mail = await mailConnection([], mailWithSearch);
  const chat = await chatOf(person.userId, ...replies);
  const grant = async (connectionId: string, binding: string) =>
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "connection", connectionId },
      actions: ["mail.send", "mail.search"],
      binding,
    });
  return { person, admin, mail, chat, grant };
};

/** The audit events of the chat's agent, once `done` holds for them. */
const eventsOf = async (
  agentId: string,
  done: (events: AuditEvent[]) => boolean
): Promise<AuditEvent[]> => {
  const mine = async () => {
    const events = await allEvents();
    return events.filter(
      ({ actor }) => actor.type === "agent" && actor.agentId === agentId
    );
  };
  await vi.waitFor(
    async () => {
      expect(done(await mine())).toBeTruthy();
    },
    { timeout: 10_000, interval: 50 }
  );
  return await mine();
};

/** What a held call returned to the chat's code, as the model read it. */
const pendingOf = (id: string | undefined) =>
  `Returned:\n${JSON.stringify({ output: null, pending: { id } })}`;

/** The subject of the mail a call sent, from its input as JSON text. */
const subjectOf = (input: string | null): string | null =>
  input === null
    ? null
    : z.object({ subject: z.string() }).parse(JSON.parse(input)).subject;

/** The model reads how the held call `id` ended, or why it can't. */
const outcomeOf = (id: string) =>
  codeStep(
    `export default async (self, env) => { try { return await env.connections.outcome(${JSON.stringify(id)}); } catch (error) { return error.message; } };`
  );

/** What the chat's code steps returned, as the model read them. */
const texts = async (
  stub: Awaited<ReturnType<typeof chatOf>>["stub"],
  chatId: string
) => {
  const results = await codeResults(stub, chatId);
  return results.map(({ text }) => text);
};

/** The events that record a read of a held call's outcome, or the call held. */
const reads = (all: AuditEvent[]) =>
  all.filter(
    ({ action, detail }) =>
      (action === "agent.call" && detail.method === "connections.outcome") ||
      (action === "connection.call" &&
        ["held", "replayed"].includes(String(detail.outcome)))
  );

/** The hour and minute `at` reads in `timeZone`, as `HH:MM`. */
const clockIn = (timeZone: string, at: string | undefined): string =>
  at === undefined
    ? "none"
    : new Intl.DateTimeFormat("en-GB", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(at));

const dayMs = 24 * 60 * 60 * 1000;

describe("a chat's connections", setUpTime, () => {
  it("hold a write, with no key of the model's, for the person to confirm, and send it once when they do", async () => {
    const { person, mail, chat, grant } = await setUp(
      codeStep(
        `export default async (self, env) => await env.connections.call("MAIL", "mail.send", ${JSON.stringify(invoiceMail)});`
      ),
      says("It waits for you to confirm it.")
    );
    await grant(mail.id, "MAIL");

    await chat.ask("Send Ben the invoice.");

    const [held, ...others] = await person.api.pendingActions.list();
    expect({
      result: await codeResults(chat.stub, chat.chat.id),
      held: held?.input,
      others: others.length,
      sent: await mail.did(),
    }).toStrictEqual({
      result: [
        {
          isError: false,
          text: `Returned:\n${JSON.stringify({ output: null, pending: { id: held?.id } })}`,
        },
      ],
      held: JSON.stringify(invoiceMail),
      others: 0,
      sent: { calls: 0, sent: [] },
    });

    await person.api.pendingActions.confirm(
      held?.id ?? "",
      held?.inputHash ?? ""
    );
    // Taken: it can't be confirmed, and so sent, a second time.
    await expect(
      outcome(
        person.api.pendingActions.confirm(held?.id ?? "", held?.inputHash ?? "")
      )
    ).resolves.toBe("connect.pending_not_found");
    expect({
      waiting: await person.api.pendingActions.list(),
      sent: await mail.did(),
    }).toStrictEqual({
      waiting: [],
      sent: { calls: 1, sent: [invoiceMail] },
    });
  });

  it("list and call only the connections the agent was granted that its person may use", async () => {
    const { person, admin, mail, chat, grant } = await setUp(
      codeStep(
        `export default async (self, env) => {
          const tried = async (name) => { try { return (await env.connections.call(name, "mail.search", { query: "invoice" })).output; } catch (error) { return error.message; } };
          const listed = await env.connections.list();
          return {
            listed: listed.map(({ name, connectionId, actions }) => ({ name, connectionId, actions })),
            mail: await tried("MAIL"),
            theirs: await tried("THEIRS"),
            ungranted: await tried("OTHER"),
          };
        };`
      ),
      says("Done.")
    );
    // Someone else's personal connection, granted to the agent anyway.
    const theirs = await mailConnection([], mailWithSearch);
    await connectDb()
      .prepare(
        "UPDATE connections SET scope = 'personal', owner_user_id = ? WHERE id = ?"
      )
      .bind(admin.userId, theirs.id)
      .run();
    await grant(mail.id, "MAIL");
    await grant(theirs.id, "THEIRS");

    await chat.ask("Find the invoice.");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(result?.text).toBe(
      `Returned:\n${JSON.stringify({
        listed: [
          {
            name: "MAIL",
            connectionId: mail.id,
            actions: ["mail.send", "mail.search"],
          },
        ],
        mail: { messages: ["invoice-1"] },
        theirs: connectErrors.create("connect.not_owner").message,
        ungranted: connectErrors.create("connect.connection_not_found").message,
      })}`
    );
    // Each call recorded once, naming the chat: the listing and the call
    // refused before connect as the agent's, the calls connect took by
    // connect.
    const events = await eventsOf(
      chat.agent.agentId,
      (all) =>
        all.filter(
          ({ action, detail }) =>
            // Not the catalog each turn reads for its skills.
            (action === "agent.call" && detail.turn !== true) ||
            action === "connection.call"
        ).length === 4
    );
    const actor = { ...chat.agent, onBehalfOf: person.userId };
    expect(
      events
        .filter(
          ({ action, detail }) =>
            // Not the catalog each turn reads for its skills.
            (action === "agent.call" && detail.turn !== true) ||
            action === "connection.call"
        )
        .map(({ action, actor: by, target, detail }) => ({
          action,
          by,
          target: target?.id ?? null,
          method: detail.method ?? null,
          outcome: detail.outcome,
          reason: detail.reason ?? null,
          chat: detail.chat,
        }))
        .toSorted(
          (one, other) =>
            one.action.localeCompare(other.action) ||
            String(one.method).localeCompare(String(other.method)) ||
            String(one.target).localeCompare(String(other.target))
        )
    ).toStrictEqual(
      [
        {
          action: "agent.call",
          by: actor,
          target: null,
          method: "connections.call",
          outcome: "refused",
          reason: "connect.connection_not_found",
          chat: chat.chat.id,
        },
        {
          action: "agent.call",
          by: actor,
          target: null,
          method: "connections.list",
          outcome: "ok",
          reason: null,
          chat: chat.chat.id,
        },
        {
          action: "connection.call",
          by: actor,
          target: mail.id,
          method: null,
          outcome: "ok",
          reason: null,
          chat: chat.chat.id,
        },
        {
          action: "connection.call",
          by: actor,
          target: theirs.id,
          method: null,
          outcome: "refused",
          reason: "connect.not_owner",
          chat: chat.chat.id,
        },
      ].toSorted(
        (one, other) =>
          one.action.localeCompare(other.action) ||
          String(one.method).localeCompare(String(other.method)) ||
          String(one.target).localeCompare(String(other.target))
      )
    );
  });

  it("audit a call refused before connect once, by core, and one connect took by connect alone", async () => {
    const { mail, chat, grant } = await setUp(
      codeStep(
        `export default async (self, env) => {
          const tried = async (action) => { try { await env.connections.call("MAIL", action, { query: "invoice" }); return "ok"; } catch (error) { return error.message; } };
          return {
            search: await tried("mail.search"),
            badAction: await tried("not an action!"),
          };
        };`
      ),
      says("Done.")
    );
    await grant(mail.id, "MAIL");

    await chat.ask("Try them.");

    const invalid = connectErrors.create("connect.invalid").message;
    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(result?.text).toBe(
      `Returned:\n${JSON.stringify({ search: "ok", badAction: invalid })}`
    );
    // The one refused before connect, by core, once; the one connect took,
    // by connect alone.
    const events = await eventsOf(
      chat.agent.agentId,
      (all) =>
        all.filter(
          ({ action, detail }) =>
            (action === "agent.call" && detail.method === "connections.call") ||
            action === "connection.call"
        ).length === 2
    );
    expect(
      events
        .filter(
          ({ action, detail }) =>
            (action === "agent.call" && detail.method === "connections.call") ||
            action === "connection.call"
        )
        .map(
          ({ action, detail }) =>
            `${action} ${String(detail.outcome)} ${String(detail.reason ?? "")}`
        )
        .toSorted()
    ).toStrictEqual([
      "agent.call refused connect.invalid",
      "connection.call ok ",
    ]);
  });

  it("find the same held write when the model asks for it again while it waits, whatever options it passes, and hold a new one once it is decided", async () => {
    // A fourth argument, as the API once took a key there, is ignored: two
    // keys don't make two actions.
    const send = (key: string) =>
      codeStep(
        `export default async (self, env) => await env.connections.call("MAIL", "mail.send", ${JSON.stringify(invoiceMail)}, { idempotencyKey: "${key}" });`
      );
    const { person, mail, chat, grant } = await setUp(
      send("first"),
      says("It waits for you."),
      send("second"),
      says("It still waits for you."),
      send("third"),
      says("I asked anew.")
    );
    await grant(mail.id, "MAIL");

    await chat.ask("Send Ben the invoice.");
    await chat.ask("Try again.");
    const waiting = await person.api.pendingActions.list();
    const [held] = waiting;
    await person.api.pendingActions.decline(held?.id ?? "");
    await chat.ask("Once more.");

    const anew = await person.api.pendingActions.list();
    const results = await codeResults(chat.stub, chat.chat.id);
    expect({
      waiting: waiting.map(({ input }) => input),
      anew: anew.map(({ input }) => input),
      sameAction: anew[0]?.id === held?.id,
      results: results.map(({ text }) => text),
      sent: await mail.did(),
    }).toStrictEqual({
      waiting: [JSON.stringify(invoiceMail)],
      anew: [JSON.stringify(invoiceMail)],
      sameAction: false,
      results: [
        pendingOf(held?.id),
        pendingOf(held?.id),
        pendingOf(anew[0]?.id),
      ],
      sent: { calls: 0, sent: [] },
    });
  });

  it("read how a held call ended by its ID: a read held in a restricted chat, once its person confirmed it, and only in the chat that asked", async () => {
    const { person, mail, chat, grant } = await setUp(
      codeStep(
        `export default async (self, env) => {
          const held = await env.connections.call("MAIL", "mail.search", { query: "invoice" });
          return { held: held.output, now: await env.connections.outcome(held.pending.id) };
        };`
      ),
      says("It waits for you.")
    );
    await grant(mail.id, "MAIL");
    // The chat has read restricted data: on a Composio connection every
    // call from it is held now, a read too.
    await chat.stub.restrictChat(chat.chat.id);

    await chat.ask("Find the invoice.");
    const [held] = await person.api.pendingActions.list();
    const id = held?.id ?? "";
    const searchedBefore = await mail.searched();
    await person.api.pendingActions.confirm(id, held?.inputHash ?? "");

    await fakeProvider(
      outcomeOf(id),
      says("Found it."),
      outcomeOf(id),
      says("No.")
    );
    await chat.ask("What did it find?");
    // Another chat of the same person and agent, and another person's chat.
    const other = await chat.stub.createChat("Other", person.userId, chat.id);
    await chat.stub.ask(other.id, { text: "What did it find?", model });
    const ben = await signedInApi(idp, "user");
    const bens = await chatOf(ben.userId, outcomeOf(id), says("No."));
    await bens.ask("What did it find?");

    const notFound = connectErrors.create("connect.pending_not_found").message;
    const found = { messages: ["invoice-1"] };
    expect({
      searchedBefore,
      searched: await mail.searched(),
      mine: await texts(chat.stub, chat.chat.id),
      otherChat: await texts(chat.stub, other.id),
      bens: await texts(bens.stub, bens.chat.id),
    }).toStrictEqual({
      searchedBefore: [],
      searched: ["invoice"],
      mine: [
        `Returned:\n${JSON.stringify({ held: null, now: { status: "waiting", output: null, error: null } })}`,
        `Returned:\n${JSON.stringify({ status: "done", output: found, error: null })}`,
      ],
      otherChat: [`Returned:\n${notFound}`],
      bens: [`Returned:\n${notFound}`],
    });
    // Each read is recorded once: by connect as a call (still held, then
    // handed over as a repeat's answer), and what never reached connect as
    // a call, by core.
    const events = await eventsOf(
      chat.agent.agentId,
      (all) => reads(all).length === 4
    );
    expect(
      reads(events)
        .map(
          ({ action, detail }) =>
            `${action} ${String(detail.outcome)} ${String(detail.reason ?? "")}`
        )
        .toSorted()
    ).toStrictEqual([
      "agent.call refused connect.pending_not_found",
      // The call itself, held, and the read of it while it waited.
      "connection.call held ",
      "connection.call held ",
      "connection.call replayed ",
    ]);
  });

  it("read how a held write whose answer was lost ended once its person said what became of it: won't be sent again, or may be sent once more", async () => {
    const person = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    // Both sends go out, and their answers are lost.
    const mail = await mailConnection(["lost", "lost"]);
    const send = (subject: string) =>
      codeStep(
        `export default async (self, env) => await env.connections.call("MAIL", "mail.send", ${JSON.stringify({ ...invoiceMail, subject })});`
      );
    const chat = await chatOf(
      person.userId,
      send("First"),
      says("It waits for you."),
      send("Second"),
      says("It waits for you too.")
    );
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "connection", connectionId: mail.id },
      actions: ["mail.send"],
      binding: "MAIL",
    });
    await chat.ask("Send Ben the first invoice.");
    await chat.ask("Send Ben the second invoice.");
    const held = await person.api.pendingActions.list();
    const ids = held.map(({ id }) => id).toSorted();
    const confirmed = await Promise.all(
      held.map(
        async ({ id, inputHash }) =>
          await outcome(person.api.pendingActions.confirm(id, inputHash))
      )
    );
    const lost = await person.api.unknownOutcomes.list();
    const first = lost.find(({ input }) => subjectOf(input) === "First");
    const second = lost.find(({ input }) => subjectOf(input) === "Second");
    if (first === undefined || second === undefined) {
      throw new Error("Expected both sends of unknown outcome");
    }
    await person.api.unknownOutcomes.resolve(
      first.key,
      "happened",
      first.claim
    );
    await person.api.unknownOutcomes.resolve(
      second.key,
      "not_happened",
      second.claim
    );
    const heldIdOf = (subject: string): string =>
      held.find(({ input }) => subjectOf(input) === subject)?.id ?? "";
    await fakeProvider(
      outcomeOf(heldIdOf("First")),
      outcomeOf(heldIdOf("Second")),
      says("One went, one may go again.")
    );
    await chat.ask("What became of them?");

    const results = await texts(chat.stub, chat.chat.id);
    const did = await mail.did();
    expect({
      ids: ids.length,
      confirmed,
      read: results.slice(-2),
      sent: did.sent.length,
    }).toStrictEqual({
      ids: 2,
      confirmed: ["connect.outcome_unknown", "connect.outcome_unknown"],
      read: [
        `Returned:\n${JSON.stringify({ status: "resolved", output: null, error: "connect.resolved_done" })}`,
        `Returned:\n${JSON.stringify({ status: "resolved", output: null, error: "connect.resolved_not_done" })}`,
      ],
      sent: 2,
    });
  });

  it("read a held call's outcome only as the call would be allowed now: not once its resource's permission is revoked", async () => {
    const person = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    // Searches held to the query they name, as the admin's rule says.
    const mail = await mailConnection(
      [],
      ["mail.send", { name: "mail.search", read: true, resource: "query" }]
    );
    const chat = await chatOf(
      person.userId,
      codeStep(
        `export default async (self, env) => await env.connections.call("INVOICES", "mail.search", { query: "invoice" });`
      ),
      says("It waits for you.")
    );
    const permissionFor = async (binding: string, resource: string) =>
      await requestGranted(idp, admin, {
        subject: chat.agent,
        object: { type: "connection", connectionId: mail.id, resource },
        actions: ["mail.search"],
        binding,
      });
    const invoices = await permissionFor("INVOICES", "invoice");
    await permissionFor("OTHER", "other");
    await chat.stub.restrictChat(chat.chat.id);

    await chat.ask("Find the invoice.");
    const [held] = await person.api.pendingActions.list();
    const id = held?.id ?? "";
    await person.api.pendingActions.confirm(id, held?.inputHash ?? "");

    // The permission for that resource goes; one for another stays.
    await admin.api.permissions.revoke(invoices);
    await fakeProvider(outcomeOf(id), says("No."));
    await chat.ask("What did it find?");

    await expect(texts(chat.stub, chat.chat.id)).resolves.toStrictEqual([
      `Returned:\n${JSON.stringify({ output: null, pending: { id } })}`,
      `Returned:\n${permissionErrors.create("permission.denied").message}`,
    ]);
  });

  it("withhold what a connection returned from the model once it is disconnected, but not while it only needs signing in again", async () => {
    const marker = `MARK-${crypto.randomUUID().slice(0, 8)}`;
    const { mail, chat, grant } = await setUp(
      codeStep(
        `export default async (self, env) => (await env.connections.call("MAIL", "mail.search", { query: ${JSON.stringify(marker)} })).output;`
      ),
      says("Found it."),
      says("Still there."),
      says("Gone.")
    );
    await grant(mail.id, "MAIL");
    const setStatus = async (status: string) => {
      await connectDb()
        .prepare("UPDATE connections SET status = ? WHERE id = ?")
        .bind(status, mail.id)
        .run();
    };

    await chat.ask("Find the mail.");
    await setStatus("needs_reauth");
    await chat.ask("And now?");
    await setStatus("disconnected");
    await chat.ask("And now?");

    expect(
      chat.provider.requests.slice(1).map(({ body }) => {
        const sent = JSON.stringify(body);
        return {
          found: sent.includes(`${marker}-1`),
          withheld: sent.includes(withheldResult),
        };
      })
    ).toStrictEqual([
      // Its result, as the code read it.
      { found: true, withheld: false },
      // Signing in again changes nobody's access.
      { found: true, withheld: false },
      { found: false, withheld: true },
    ]);
  });

  it("withhold what a connection returned from the model once the grant it was read under goes, though a narrower one stays, and audit it", async () => {
    const person = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const marker = `MARK-${crypto.randomUUID().slice(0, 8)}`;
    // Searches held to the query they name, as the admin's rule says.
    const mail = await mailConnection(
      [],
      ["mail.send", { name: "mail.search", read: true, resource: "query" }]
    );
    const chat = await chatOf(
      person.userId,
      codeStep(
        `export default async (self, env) => (await env.connections.call("ALL", "mail.search", { query: ${JSON.stringify(marker)} })).output;`
      ),
      says("Found it."),
      says("Gone.")
    );
    const permissionFor = async (binding: string, resource?: string) =>
      await requestGranted(idp, admin, {
        subject: chat.agent,
        object: {
          type: "connection",
          connectionId: mail.id,
          ...(resource === undefined ? {} : { resource }),
        },
        actions: ["mail.search"],
        binding,
      });
    // Read under the grant for the whole connection; one for that very
    // query, and one to send, stay once it goes.
    const all = await permissionFor("ALL");
    await permissionFor("ONE", marker);
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "connection", connectionId: mail.id },
      actions: ["mail.send"],
      binding: "SEND",
    });

    await chat.ask("Find the mail.");
    await admin.api.permissions.revoke(all);
    await chat.ask("And now?");

    expect(
      chat.provider.requests.slice(1).map(({ body }) => {
        const sent = JSON.stringify(body);
        return {
          found: sent.includes(`${marker}-1`),
          withheld: sent.includes(withheldResult),
        };
      })
    ).toStrictEqual([
      // Its result, as the code read it.
      { found: true, withheld: false },
      { found: false, withheld: true },
    ]);
    // Audited by the agent for its person: the grant the read rested on.
    const events = await eventsOf(chat.agent.agentId, (found) =>
      found.some(({ action }) => action === "chat.history_withheld")
    );
    expect(
      events
        .filter(({ action }) => action === "chat.history_withheld")
        .map(({ target, detail }) => ({
          target,
          connection: detail.connection,
          action: detail.action,
          resource: detail.resource,
        }))
    ).toStrictEqual([
      {
        target: { type: "chat", id: chat.chat.id },
        connection: mail.id,
        action: "mail.search",
        resource: null,
      },
    ]);
  });

  it("end a write held in a Teams chat at midnight of the company's day, and run nothing pressed after it", async () => {
    const send = codeStep(
      `export default async (self, env) => await env.connections.call("MAIL", "MAIL_SEND", ${JSON.stringify(invoiceMail)});`
    );
    const waits = says("It waits for you to confirm it.");
    // One turn in the Teams chat, then one in the web chat.
    const { person, admin, chat } = await setUp(send, waits, send, waits);
    const timeZone = "Pacific/Auckland";
    await admin.api.organization.update({ timeZone });
    // A send whose fields its server lists, so core can check a Teams
    // chat's write against them (channels/stephen-rules.ts).
    const mail = await mailConnection([], ["MAIL_SEND"]);
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "connection", connectionId: mail.id },
      actions: ["MAIL_SEND"],
      binding: "MAIL",
    });
    // The same workspace's agent, in a chat that came through Teams.
    const teams = await chat.stub.createChat(
      "Questions",
      person.userId,
      chat.id,
      undefined,
      undefined,
      undefined,
      "teams"
    );
    const asked = "Send ben@acme.test the invoice.";
    await chat.stub.ask(teams.id, { text: asked, model });
    await chat.ask(asked);

    const waiting = await person.api.pendingActions.list();
    const fromTeams = waiting.find(
      ({ context }) => context.type === "chat" && context.chatId === teams.id
    );
    const fromWeb = waiting.find(
      ({ context }) =>
        context.type === "chat" && context.chatId === chat.chat.id
    );
    const endsIn = Date.parse(fromTeams?.endsAt ?? "") - Date.now();
    expect({
      held: [fromTeams, fromWeb].every((held) => held !== undefined),
      teams: clockIn(timeZone, fromTeams?.endsAt),
      withinTheDay: endsIn > 0 && endsIn <= dayMs,
      web: fromWeb?.endsAt,
    }).toStrictEqual({
      held: true,
      teams: "00:00",
      withinTheDay: true,
      web: undefined,
    });

    // The company's midnight passes before the person presses its card.
    await connectDb()
      .prepare("UPDATE pending_actions SET ends_at = ? WHERE id = ?")
      .bind(Date.now() - 1, fromTeams?.id ?? "")
      .run();
    await expect(
      outcome(
        person.api.pendingActions.confirm(
          fromTeams?.id ?? "",
          fromTeams?.inputHash ?? ""
        )
      )
    ).resolves.toBe("connect.pending_expired");
    // Its chat's agent is told it ended; the web chat's still waits.
    const messages = await transcript(chat.stub, teams.id);
    const told = messages.filter(
      ({ role, content }) =>
        role === "system" &&
        typeof content === "string" &&
        content.includes(`pending ID ${fromTeams?.id}`)
    );
    const after = await person.api.pendingActions.list();
    expect({
      sent: await mail.did(),
      waiting: after.map(({ id }) => id),
      told: told.map(
        ({ content }) =>
          typeof content === "string" && content.includes("ended")
      ),
    }).toStrictEqual({
      sent: { calls: 0, sent: [] },
      waiting: [fromWeb?.id],
      told: [true],
    });
  });
});
