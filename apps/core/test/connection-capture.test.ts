import { provenanceMetaKey } from "@grasp-os/connector-kit/manifest";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { recallAs } from "../src/brain-next.ts";
import { chatOf, codeStep, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection, mailWithSearch } from "./mail-connection.ts";
import { signedInApi } from "./sign-in.ts";

// Capture (GRA-1730, src/connection-capture.ts): what a chat's agent reads
// through a connection is kept in the Brain for the chat's person alone.
// These tests start from the ways it can fail (the threat model on
// GRA-1730): someone else recalls what was read in another's chat; a
// connection whose provider forbids copies, or a change, is kept; reading
// the same items again leaves two current copies; the audit log holds what
// was read.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const budget = { tokens: 4000 };

/** A word nothing else holds. */
const markerOf = (): string => `cap${crypto.randomUUID().replaceAll("-", "")}`;

/** A code step that searches `binding`'s mail for `query`. */
const search = (binding: string, query: string) =>
  codeStep(
    `export default async (self, env) => (await env.connections.call(${JSON.stringify(binding)}, "mail.search", { query: ${JSON.stringify(query)} })).output;`
  );

/** A code step that sends a mail through `binding` with `subject`. */
const send = (binding: string, subject: string) =>
  codeStep(
    `export default async (self, env) => await env.connections.call(${JSON.stringify(binding)}, "mail.send", { to: "ben@acme.test", subject: ${JSON.stringify(subject)} });`
  );

/** A chat of `personId` whose agent may search and send through `connectionId`. */
const chatWith = async (
  personId: string,
  connectionId: string,
  ...replies: Parameters<typeof chatOf>[1][]
) => {
  const admin = await signedInApi(idp, "admin");
  const chat = await chatOf(personId, ...replies);
  await requestGranted(idp, admin, {
    subject: chat.agent,
    object: { type: "connection", connectionId },
    actions: ["mail.send", "mail.search"],
    binding: "MAIL",
  });
  return chat;
};

/** What `personId` recalls for `question`: each item's text and source. */
const recalled = async (personId: string, question: string) => {
  const { items, elsewhere } = await recallAs(env, personId, {
    question,
    budget,
  });
  return {
    items: items.map(({ source, version, text }) => ({
      producer: source.producer,
      version,
      text,
    })),
    elsewhere,
  };
};

/** The capture events about `connectionId`, once `done` holds for them. */
const captureEvents = async (
  connectionId: string,
  done: (events: AuditEvent[]) => boolean
): Promise<AuditEvent[]> => {
  const mine = async () => {
    const events = await allEvents();
    return events.filter(
      ({ action, target }) =>
        action.startsWith("brain.capture.") && target?.id === connectionId
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

/** A mail search's answer that names the message it read. */
const messageRead = (messageId: string, subject: string) => ({
  content: [{ type: "text", text: JSON.stringify({ subject }) }],
  structuredContent: { subject },
  _meta: { [provenanceMetaKey]: [messageId] },
});

describe("what a chat's agent reads through a connection", setUpTime, () => {
  it("is kept for the chat's person alone, and their recall names the connection to look in", async () => {
    const [person, other] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const marker = markerOf();
    const mail = await mailConnection([], mailWithSearch);
    const chat = await chatWith(
      person.userId,
      mail.id,
      search("MAIL", marker),
      says("Found it.")
    );

    await chat.ask("Find the mail.");

    // The fake server answers a search with `<query>-1`, naming no item.
    const answer = JSON.stringify({ messages: [`${marker}-1`] });
    await expect(recalled(person.userId, marker)).resolves.toStrictEqual({
      items: [{ producer: "capture", version: 1, text: answer }],
      elsewhere: [mail.id],
    });
    await expect(recalled(other.userId, marker)).resolves.toStrictEqual({
      items: [],
      elsewhere: [],
    });
    // Audited as kept, by the agent for the person, with no text.
    const events = await captureEvents(mail.id, (found) => found.length > 0);
    expect(
      events.map(({ action, actor, detail }) => ({
        action,
        onBehalfOf: actor.type === "agent" ? actor.onBehalfOf : null,
        chat: detail.chat,
        version: detail.version,
      }))
    ).toStrictEqual([
      {
        action: "brain.capture.kept",
        onBehalfOf: person.userId,
        chat: chat.chat.id,
        version: 1,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(marker);
  });

  it("keeps the same items read again as their next version, the earlier one as history", async () => {
    const person = await signedInApi(idp, "user");
    const marker = markerOf();
    const mail = await mailConnection([], mailWithSearch);
    const chat = await chatWith(
      person.userId,
      mail.id,
      search("MAIL", "first"),
      says("Found it."),
      search("MAIL", "again"),
      says("Found it again.")
    );

    await mail.answer(
      "mail.search",
      messageRead(`message-${marker}`, `Quote ${marker} draft`)
    );
    await chat.ask("Find the quote.");
    await mail.answer(
      "mail.search",
      messageRead(`message-${marker}`, `Quote ${marker} final`)
    );
    await chat.ask("Find it again.");

    await expect(recalled(person.userId, marker)).resolves.toStrictEqual({
      items: [
        {
          producer: "capture",
          version: 2,
          text: JSON.stringify({ subject: `Quote ${marker} final` }),
        },
      ],
      elsewhere: [mail.id],
    });
  });

  it("is not kept from a connection whose provider forbids copies, nor when it changed something", async () => {
    const person = await signedInApi(idp, "user");
    const [privateMarker, sentMarker] = [markerOf(), markerOf()];
    const forbidden = await mailConnection([], mailWithSearch, "mail_private");
    const mail = await mailConnection([], mailWithSearch);
    // One chat at a time: each sets the model's replies.
    const privateChat = await chatWith(
      person.userId,
      forbidden.id,
      search("MAIL", privateMarker),
      says("Found it.")
    );
    await privateChat.ask("Find the mail.");
    const sendingChat = await chatWith(
      person.userId,
      mail.id,
      send("MAIL", sentMarker),
      says("It waits for you.")
    );
    await sendingChat.ask("Send the mail.");

    // Both calls reached connect: the search ran, the send was held.
    await expect(forbidden.searched()).resolves.toStrictEqual([privateMarker]);
    await expect(
      Promise.all([
        recalled(person.userId, privateMarker),
        recalled(person.userId, sentMarker),
      ])
    ).resolves.toStrictEqual([
      { items: [], elsewhere: [] },
      { items: [], elsewhere: [] },
    ]);
    const events = await allEvents();
    expect(
      events.filter(
        ({ action, target }) =>
          action.startsWith("brain.capture.") &&
          (target?.id === forbidden.id || target?.id === mail.id)
      )
    ).toStrictEqual([]);
  });
});
