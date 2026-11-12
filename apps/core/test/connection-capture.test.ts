import { provenanceMetaKey } from "@grasp-os/connector-kit/manifest";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { erasePerson, eraseSource, recallAs } from "../src/brain-next.ts";
import { captureIdOf } from "../src/connection-capture-key.ts";
import { chatOf, codeStep, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import {
  consentCode,
  stephenGoogleUrl,
  stephenGraphUrl,
} from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection, mailWithSearch } from "./mail-connection.ts";
import { acmeTenant, signInConfig } from "./sign-in-config.ts";
import { routed, signedInApi } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// Capture (GRA-1730, src/connection-capture.ts): what a chat's agent reads
// through its person's own connection, with a tool that reaches their own
// things, is kept in the Brain, an item a source per tool, for that person
// alone, in their own store. These start from the ways it can fail (the
// threat model and decisions on GRA-1730): someone else recalls what was
// read in another's chat; a read of a shared connection, or of the
// company's or others' things, outlives the person's access at the source;
// a toolkit that forbids copies, a change, or an answer naming no item is
// kept; one tool's view of an item replaces another's; a credential is
// stored; a failing Brain fails or holds up the agent.

const idp = mockIdp();

/** Signing people in, connecting and granting can be slow on CI. */
const setUpTime = { timeout: 90_000 };

const budget = { tokens: 4000 };

type Person = Awaited<ReturnType<typeof signedInApi>>;
type Chat = Awaited<ReturnType<typeof chatOf>>;

/** A word nothing else holds. */
const markerOf = (): string => `cap${crypto.randomUUID().replaceAll("-", "")}`;

/** Code that calls `action` on `binding` with `input`, giving its output. */
const calling = (binding: string, action: string, input: unknown) =>
  `(await env.connections.call(${JSON.stringify(binding)}, ${JSON.stringify(action)}, ${JSON.stringify(input)})).output`;

/** A code step running `calls` in order, returning what the last gave. */
const step = (...calls: string[]) =>
  codeStep(
    `export default async (self, env) => { let last; ${calls.map((call) => `last = ${call};`).join(" ")} return last; };`
  );

/** Grants the chat's agent `actions` on `connectionId` under `binding`. */
const grant = async (
  chat: Chat,
  connectionId: string,
  binding: string,
  actions: string[]
) => {
  const admin = await signedInApi(idp, "admin");
  await requestGranted(idp, admin, {
    subject: chat.agent,
    object: { type: "connection", connectionId },
    actions,
    binding,
  });
};

/** `person`'s own connection to `provider`, as `subject` with `rights`. */
const ownConnection = async (
  person: Person,
  provider: "google" | "microsoft",
  subject: string,
  rights: string
) => {
  const { url } = await person.api.connections.start({
    provider,
    scope: "personal",
  });
  const authorization = new URL(url);
  const tenant =
    provider === "google" ? signInConfig.google.hostedDomain : acmeTenant;
  const query = new URLSearchParams({
    code: consentCode(authorization, tenant, subject, rights),
    state: authorization.searchParams.get("state") ?? "",
  });
  await routed(`/api/connections/callback?${query.toString()}`, {
    headers: { cookie: person.session },
  });
  const listed = await person.api.connections.list();
  const connection = listed.find(
    ({ accountName }) => accountName === `${subject}@acme.test`
  );
  if (connection === undefined) {
    throw new Error(`Expected ${subject}'s connection`);
  }
  return { connectionId: connection.id, mailbox: `${subject}@acme.test` };
};

/** `person`'s own Google account, their sign-in's address: its mail reaches theirs alone. */
const ownGmail = async (person: Person) =>
  await ownConnection(
    person,
    "google",
    String(person.person.email).replace(/@.*$/u, ""),
    "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/gmail.readonly"
  );

/** `person`'s own Microsoft 365 account: its mail tools reach any mailbox. */
const ownMicrosoft = async (person: Person) =>
  await ownConnection(
    person,
    "microsoft",
    String(person.person.oid),
    "openid profile email offline_access User.Read MailboxSettings.Read Mail.ReadWrite"
  );

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** Sets a world in the fake Google or Graph at `controlUrl`. */
const worldHolds = async (controlUrl: string, world: unknown) => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker");
  }
  await providers.fetch(controlUrl, {
    method: "POST",
    body: JSON.stringify(world),
  });
};

/** A message as Gmail holds it (`format=full`): `subject`, and `body`. */
const gmailMessage = (id: string, subject: string, body: string) => ({
  id,
  threadId: id,
  labelIds: ["INBOX"],
  snippet: subject,
  internalDate: String(Date.parse("2026-11-12T09:00:00Z")),
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: "Ben <ben@acme.test>" },
      { name: "Subject", value: subject },
      { name: "Message-ID", value: `<${id}@mail.gmail.com>` },
    ],
    body: {
      size: new TextEncoder().encode(body).byteLength,
      data: btoa(body)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", ""),
    },
  },
});

/** A message body whose own word is past what a list shows of it. */
const bodyWith = (word: string) => `${"Dear Ben, ".repeat(40)}${word}`;

/** A toolkit's answer naming the messages it read. */
const messagesRead = (messages: { id: string; subject: string }[]) => ({
  content: [{ type: "text", text: JSON.stringify({ messages }) }],
  structuredContent: { messages },
  _meta: { [provenanceMetaKey]: messages.map(({ id }) => id) },
});

/**
 * What `personId` recalls for `question`, each item's text and version:
 * with their own store, as their own web chat does, unless `personal` is
 * false, as an App, a workflow or the SDK asks.
 */
const recalled = async (
  personId: string,
  question: string,
  personal = true
) => {
  const { items, elsewhere } = await recallAs(env, personId, {
    personal,
    question,
    budget,
  });
  return {
    texts: items.map(({ source, version, text }) => ({
      producer: source.producer,
      version,
      text,
    })),
    elsewhere,
  };
};

/** The capture events about `connectionId`, once `count` of them are in. */
const captures = async (
  connectionId: string,
  count = 1
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
      const found = await mine();
      expect(found.length).toBeGreaterThanOrEqual(count);
    },
    { timeout: 10_000, interval: 50 }
  );
  return await mine();
};

/** An event as the tests compare it: its chat aside. */
const shown = ({ action, actor, detail }: AuditEvent) => ({
  action,
  onBehalfOf: actor.type === "agent" ? actor.onBehalfOf : null,
  detail: Object.fromEntries(
    Object.entries(detail).filter(([key]) => key !== "chat")
  ),
});

describe("what a chat's agent reads through a connection", setUpTime, () => {
  it("is kept item by item from the person's own mail, for them alone, and their recall names the connection", async () => {
    const [person, stranger] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const marker = markerOf();
    const { connectionId, mailbox } = await ownGmail(person);
    await worldHolds(stephenGoogleUrl, {
      mailbox,
      events: [],
      messages: [
        gmailMessage(`quote-${marker}`, `Quote ${marker}`, "The quote."),
        gmailMessage(`order-${marker}`, `Order ${marker}`, "The order."),
      ],
    });
    const chat = await chatOf(
      person.userId,
      step(calling("MAIL", "mail.list", { mailbox, search: marker })),
      says("Found them.")
    );
    await grant(chat, connectionId, "MAIL", ["mail.list"]);

    await chat.ask("Find the quote.");
    const events = await captures(connectionId);

    const found = await recalled(person.userId, `quote ${marker}`);
    expect({
      events: events.map(shown),
      // Each item its own source, holding that item alone.
      items: found.texts
        .map(({ producer, text }) => ({
          producer,
          quote: text.includes(`Quote ${marker}`),
          order: text.includes(`Order ${marker}`),
        }))
        .toSorted((one, other) => Number(one.quote) - Number(other.quote)),
      elsewhere: found.elsewhere,
      stranger: await recalled(stranger.userId, marker),
    }).toStrictEqual({
      events: [
        {
          action: "brain.capture.kept",
          onBehalfOf: person.userId,
          detail: { items: 2, kept: 2, failed: 0, skipped: 0 },
        },
      ],
      items: [
        { producer: "capture", quote: false, order: true },
        { producer: "capture", quote: true, order: false },
      ],
      elsewhere: [connectionId],
      stranger: { texts: [], elsewhere: [] },
    });
    expect(JSON.stringify(events)).not.toContain(marker);
  });

  it("keeps an item one tool reads again as its next version, and what another tool read of it beside it", async () => {
    const person = await signedInApi(idp, "user");
    const [marker, inBody] = [markerOf(), markerOf()];
    const { connectionId, mailbox } = await ownGmail(person);
    const id = `quote-${marker}`;
    const read = calling("MAIL", "mail.get", { mailbox, message: id });
    const chat = await chatOf(
      person.userId,
      step(read),
      says("Read it."),
      step(read),
      says("Read it again."),
      step(calling("MAIL", "mail.list", { mailbox, search: marker })),
      says("Listed it.")
    );
    await grant(chat, connectionId, "MAIL", ["mail.get", "mail.list"]);

    await worldHolds(stephenGoogleUrl, {
      mailbox,
      events: [],
      messages: [gmailMessage(id, `Quote ${marker}`, bodyWith("draft"))],
    });
    await chat.ask("Read the quote.");
    await captures(connectionId, 1);
    await worldHolds(stephenGoogleUrl, {
      mailbox,
      events: [],
      messages: [gmailMessage(id, `Quote ${marker}`, bodyWith(inBody))],
    });
    await chat.ask("Read it again.");
    await captures(connectionId, 2);
    await chat.ask("List it.");
    await captures(connectionId, 3);

    const bySubject = await recalled(person.userId, `quote ${marker}`);
    const byBody = await recalled(person.userId, inBody);
    expect({
      // The full read, at its second version, and the list's view: two
      // sources of one item, neither replacing the other.
      bySubject: bySubject.texts
        .map(({ version, text }) => ({
          version,
          full: text.includes(inBody),
        }))
        .toSorted((one, other) => Number(one.full) - Number(other.full)),
      // The full text is still found after the list read it.
      byBody: byBody.texts.map(({ version }) => version),
    }).toStrictEqual({
      bySubject: [
        { version: 1, full: false },
        { version: 2, full: true },
      ],
      byBody: [2],
    });
  });

  it("keeps nothing of a tool that reaches beyond the person's own things, counted as skipped", async () => {
    const person = await signedInApi(idp, "user");
    const marker = markerOf();
    const { connectionId, mailbox } = await ownMicrosoft(person);
    await worldHolds(stephenGraphUrl, {
      mailbox,
      events: [],
      messages: [`quote-${marker}`, `order-${marker}`].map((id) => ({
        id,
        subject: `${id} ${marker}`,
        body: { contentType: "text", content: "About it" },
        receivedDateTime: "2026-11-12T09:00:00Z",
        from: { emailAddress: { address: "ben@acme.test", name: "Ben" } },
      })),
    });
    const chat = await chatOf(
      person.userId,
      step(calling("MAIL", "mail.list", { mailbox })),
      says("Found them.")
    );
    await grant(chat, connectionId, "MAIL", ["mail.list"]);

    await chat.ask("Find them.");
    const events = await captures(connectionId);

    expect({
      events: events.map(shown),
      recalled: await recalled(person.userId, marker),
    }).toStrictEqual({
      events: [
        {
          action: "brain.capture.skipped",
          onBehalfOf: person.userId,
          detail: { reason: "reach", items: 2, kept: 0, failed: 0, skipped: 2 },
        },
      ],
      recalled: { texts: [], elsewhere: [] },
    });
  });

  it("is kept from the person's own toolkit when its server names the item, and never of a change", async () => {
    const person = await signedInApi(idp, "user");
    const [named, sent] = [markerOf(), markerOf()];
    const mail = await mailConnection([], mailWithSearch, {
      provider: "mail_own",
      owner: person.userId,
    });
    await mail.answer(
      "mail.search",
      messagesRead([{ id: `message-${named}`, subject: named }])
    );
    const chat = await chatOf(
      person.userId,
      step(
        calling("MAIL", "mail.send", { to: "ben@acme.test", subject: sent })
      ),
      says("Waiting for you."),
      step(calling("MAIL", "mail.search", { query: named })),
      says("Found it.")
    );
    await grant(chat, mail.id, "MAIL", ["mail.send", "mail.search"]);

    await chat.ask("Send it.");
    await chat.ask("Find it.");
    const events = await captures(mail.id);
    const found = await recalled(person.userId, named);

    expect({
      events: events.map(shown),
      named: found.texts.map(({ text }) => text),
      sent: await recalled(person.userId, sent),
    }).toStrictEqual({
      events: [
        {
          action: "brain.capture.kept",
          onBehalfOf: person.userId,
          detail: { items: 1, kept: 1, failed: 0, skipped: 0 },
        },
      ],
      named: [
        JSON.stringify({
          messages: [{ id: `message-${named}`, subject: named }],
        }),
      ],
      sent: { texts: [], elsewhere: [] },
    });
  });

  it("keeps nothing from a shared connection, counted as skipped, nor from a toolkit that forbids copies or an answer naming no item", async () => {
    const person = await signedInApi(idp, "user");
    const [sharedMarker, privateMarker, unnamed, witness] = [
      markerOf(),
      markerOf(),
      markerOf(),
      markerOf(),
    ];
    const shared = await mailConnection([], mailWithSearch, {
      provider: "mail_own",
    });
    const forbidden = await mailConnection([], mailWithSearch, {
      provider: "mail_private",
      owner: person.userId,
    });
    // Its search answers as the test server does, naming no item.
    const plain = await mailConnection([], mailWithSearch, {
      provider: "mail_own",
      owner: person.userId,
    });
    const own = await mailConnection([], mailWithSearch, {
      provider: "mail_own",
      owner: person.userId,
    });
    await shared.answer(
      "mail.search",
      messagesRead([{ id: `message-${sharedMarker}`, subject: sharedMarker }])
    );
    await forbidden.answer(
      "mail.search",
      messagesRead([{ id: `message-${privateMarker}`, subject: privateMarker }])
    );
    await own.answer(
      "mail.search",
      messagesRead([{ id: `message-${witness}`, subject: witness }])
    );
    const chat = await chatOf(
      person.userId,
      step(
        calling("SHARED", "mail.search", { query: sharedMarker }),
        calling("PRIVATE", "mail.search", { query: privateMarker }),
        calling("PLAIN", "mail.search", { query: unnamed }),
        calling("OWN", "mail.search", { query: witness })
      ),
      says("Found them.")
    );
    await grant(chat, shared.id, "SHARED", ["mail.search"]);
    await grant(chat, forbidden.id, "PRIVATE", ["mail.search"]);
    await grant(chat, plain.id, "PLAIN", ["mail.search"]);
    await grant(chat, own.id, "OWN", ["mail.search"]);

    await chat.ask("Find them.");
    // Each capture starts as its call answers, the others' at once: once
    // the last call's is in, the earlier ones have ended.
    const [sharedEvents] = await Promise.all([
      captures(shared.id),
      captures(own.id),
    ]);
    const quiet = await allEvents();
    const witnessed = await recalled(person.userId, witness);

    expect({
      shared: sharedEvents.map(shown),
      recalled: await Promise.all(
        [sharedMarker, privateMarker, unnamed].map(
          async (marker) => await recalled(person.userId, marker)
        )
      ),
      witness: witnessed.texts.length,
      quiet: quiet.filter(
        ({ action, target }) =>
          action.startsWith("brain.capture.") &&
          (target?.id === forbidden.id || target?.id === plain.id)
      ),
    }).toStrictEqual({
      shared: [
        {
          action: "brain.capture.skipped",
          onBehalfOf: person.userId,
          detail: {
            reason: "shared",
            items: 1,
            kept: 0,
            failed: 0,
            skipped: 1,
          },
        },
      ],
      recalled: [
        { texts: [], elsewhere: [] },
        { texts: [], elsewhere: [] },
        { texts: [], elsewhere: [] },
      ],
      witness: 1,
      quiet: [],
    });
  });

  it("keeps an item in the person's own store, credentials redacted: found by their own recall, never by an App's as them, and gone once they are erased", async () => {
    const person = await signedInApi(idp, "user");
    const marker = markerOf();
    const secret = `hunter2-${crypto.randomUUID()}`;
    const mail = await mailConnection([], mailWithSearch, {
      provider: "mail_own",
      owner: person.userId,
    });
    await mail.answer(
      "mail.search",
      messagesRead([
        {
          id: `message-${marker}`,
          subject: `Login ${marker} password: ${secret}`,
        },
      ])
    );
    const chat = await chatOf(
      person.userId,
      step(calling("MAIL", "mail.search", { query: marker })),
      says("Found it.")
    );
    await grant(chat, mail.id, "MAIL", ["mail.search"]);

    await chat.ask("Find it.");
    await captures(mail.id);
    const own = await recalled(person.userId, `login ${marker}`);
    // As an App, a workflow or the SDK asks: the shared store alone.
    const asApp = await recalled(person.userId, `login ${marker}`, false);
    await erasePerson(env, {
      personId: person.userId,
      reason: "person_erased",
    });
    const erased = await recalled(person.userId, `login ${marker}`);

    expect({
      own: own.texts.map(({ text }) => text),
      asApp,
      erased,
    }).toStrictEqual({
      own: [
        JSON.stringify({
          messages: [
            {
              id: `message-${marker}`,
              subject: `Login ${marker} password: [redacted]`,
            },
          ],
        }),
      ],
      asApp: { texts: [], elsewhere: [] },
      erased: { texts: [], elsewhere: [] },
    });
  });

  it("counts each item of a call as kept, failed or skipped, and gives the agent its answer whatever the Brain did", async () => {
    const person = await signedInApi(idp, "user");
    const marker = markerOf();
    const mail = await mailConnection([], mailWithSearch, {
      provider: "mail_own",
      owner: person.userId,
    });
    const keptId = `kept-${marker}`;
    const refusedId = `refused-${marker}`;
    const erasedId = `erased-${marker}`;
    await mail.answer(
      "mail.search",
      messagesRead([
        { id: keptId, subject: `Kept ${marker}` },
        // Past the Brain's own limit once folded for its word index: refused.
        { id: refusedId, subject: "ﷺ".repeat(35_000) },
        { id: erasedId, subject: `Erased ${marker}` },
      ])
    );
    // One item's key closed by an erasure before it is read.
    await eraseSource(env, {
      source: {
        producer: "capture",
        id: await captureIdOf(mail.id, person.userId, "mail.search", erasedId),
      },
      readers: { kind: "owner", personId: person.userId },
      reason: "deleted",
    });
    const chat = await chatOf(
      person.userId,
      step(calling("MAIL", "mail.search", { query: marker })),
      says("Found them.")
    );
    await grant(chat, mail.id, "MAIL", ["mail.search"]);

    await chat.ask("Find them.");
    const events = await captures(mail.id);
    const found = await recalled(person.userId, marker);

    expect({
      events: events.map(shown),
      kept: found.texts.map(({ text }) => text.includes(`Kept ${marker}`)),
      // The model read the answer the code got (shortened, as a long one
      // is for a model, past its first item).
      answered: JSON.stringify(chat.provider.requests.at(-1)?.body).includes(
        `Kept ${marker}`
      ),
    }).toStrictEqual({
      events: [
        {
          action: "brain.capture.kept",
          onBehalfOf: person.userId,
          detail: { items: 3, kept: 1, failed: 1, skipped: 1 },
        },
      ],
      kept: [true],
      answered: true,
    });
  });
});
