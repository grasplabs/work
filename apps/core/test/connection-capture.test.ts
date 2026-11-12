import { provenanceMetaKey } from "@grasp-os/connector-kit/manifest";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { eraseSource, recallAs } from "../src/brain-next.ts";
import { captureIdOf } from "../src/connection-capture-key.ts";
import { captureBytesMax } from "../src/connection-capture.ts";
import { chatOf, codeStep, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { consentCode, stephenGraphUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection, mailWithSearch } from "./mail-connection.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { routed, signedInApi } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// Capture (GRA-1730, src/connection-capture.ts): what a chat's agent reads
// through its person's own connection is kept in the Brain, an item a
// source, for that person alone. These start from the ways it can fail
// (the threat model and decisions on GRA-1730): someone else recalls what
// was read in another's chat; a shared connection's read outlives the
// person's access; a toolkit that forbids copies, a change, or an answer
// naming no item is kept; overlapping reads pile up copies of one item; a
// credential is stored; a failing Brain fails or holds up the agent.

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

/** What the Microsoft 365 connection's reads need. */
const rights =
  "openid profile email offline_access User.Read MailboxSettings.Read Mail.ReadWrite";

/**
 * `person`'s own Microsoft 365 connection, to the account they sign in
 * with, and its mailbox.
 */
const ownMicrosoft = async (person: Person) => {
  const subject = String(person.person.oid);
  const { url } = await person.api.connections.start({
    provider: "microsoft",
    scope: "personal",
  });
  const authorization = new URL(url);
  const query = new URLSearchParams({
    code: consentCode(authorization, acmeTenant, subject, rights),
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

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** Sets the messages of `mailbox` in the fake Graph. */
const mailboxHolds = async (
  mailbox: string,
  messages: { id: string; subject: string }[]
) => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker");
  }
  await providers.fetch(stephenGraphUrl, {
    method: "POST",
    body: JSON.stringify({
      mailbox,
      events: [],
      messages: messages.map(({ id, subject }) => ({
        id,
        subject,
        body: { contentType: "text", content: `About ${subject}` },
        receivedDateTime: "2026-11-12T09:00:00Z",
        from: { emailAddress: { address: "ben@acme.test", name: "Ben" } },
      })),
    }),
  });
};

/** A Composio answer naming the one message it read. */
const messageRead = (id: string, subject: string) => ({
  content: [{ type: "text", text: JSON.stringify({ id, subject }) }],
  structuredContent: { id, subject },
  _meta: { [provenanceMetaKey]: [id] },
});

/** What `personId` recalls for `question`: each item's text and version. */
const recalled = async (personId: string, question: string) => {
  const { items, elsewhere } = await recallAs(env, personId, {
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
  it("is kept item by item from the person's own native connection, for them alone, and their recall names it", async () => {
    const [person, stranger] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const marker = markerOf();
    const { connectionId, mailbox } = await ownMicrosoft(person);
    await mailboxHolds(mailbox, [
      { id: `quote-${marker}`, subject: `Quote ${marker}` },
      { id: `order-${marker}`, subject: `Order ${marker}` },
    ]);
    const chat = await chatOf(
      person.userId,
      step(calling("MAIL", "mail.list", { mailbox })),
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
          detail: { items: 2, kept: 2, tooLarge: 0 },
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

  it("keeps an item read again, alone or among others, as its next version, never a second copy", async () => {
    const person = await signedInApi(idp, "user");
    const marker = markerOf();
    const { connectionId, mailbox } = await ownMicrosoft(person);
    const list = calling("MAIL", "mail.list", { mailbox });
    const chat = await chatOf(
      person.userId,
      step(list),
      says("Found it."),
      step(list),
      says("Found them.")
    );
    await grant(chat, connectionId, "MAIL", ["mail.list"]);

    await mailboxHolds(mailbox, [
      { id: `quote-${marker}`, subject: `Quote ${marker} draft` },
    ]);
    await chat.ask("Find the quote.");
    await captures(connectionId, 1);
    await mailboxHolds(mailbox, [
      { id: `quote-${marker}`, subject: `Quote ${marker} final` },
      { id: `order-${marker}`, subject: `Order ${marker}` },
    ]);
    await chat.ask("Find it again.");
    await captures(connectionId, 2);

    const { texts } = await recalled(person.userId, `quote ${marker}`);
    expect(
      texts
        .filter(({ text }) => text.includes(`quote-${marker}`))
        .map(({ version, text }) => ({
          version,
          final: text.includes("final"),
        }))
    ).toStrictEqual([{ version: 2, final: true }]);
  });

  it("is kept from the person's own Composio toolkit when its server names the item, and never of a change", async () => {
    const person = await signedInApi(idp, "user");
    const [named, sent] = [markerOf(), markerOf()];
    const mail = await mailConnection([], mailWithSearch, {
      owner: person.userId,
    });
    await mail.answer("mail.search", messageRead(`message-${named}`, named));
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
          detail: { items: 1, kept: 1, tooLarge: 0 },
        },
      ],
      named: [JSON.stringify({ id: `message-${named}`, subject: named })],
      sent: { texts: [], elsewhere: [] },
    });
  });

  it("keeps nothing from a shared connection, audited as skipped, nor from a toolkit that forbids copies or an answer naming no item", async () => {
    const person = await signedInApi(idp, "user");
    const [sharedMarker, privateMarker, unnamed, witness] = [
      markerOf(),
      markerOf(),
      markerOf(),
      markerOf(),
    ];
    const shared = await mailConnection([], mailWithSearch);
    const forbidden = await mailConnection([], mailWithSearch, {
      provider: "mail_private",
      owner: person.userId,
    });
    // Its search answers as the test server does, naming no item.
    const plain = await mailConnection([], mailWithSearch, {
      owner: person.userId,
    });
    const own = await mailConnection([], mailWithSearch, {
      owner: person.userId,
    });
    await shared.answer(
      "mail.search",
      messageRead(`message-${sharedMarker}`, sharedMarker)
    );
    await forbidden.answer(
      "mail.search",
      messageRead(`message-${privateMarker}`, privateMarker)
    );
    await own.answer("mail.search", messageRead(`message-${witness}`, witness));
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
          detail: { reason: "shared" },
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

  it("redacts a credential before it is kept, and skips an item too large to keep whole", async () => {
    const person = await signedInApi(idp, "user");
    const [marker, large] = [markerOf(), markerOf()];
    const secret = `hunter2-${crypto.randomUUID()}`;
    const mail = await mailConnection([], mailWithSearch, {
      owner: person.userId,
    });
    const bigMail = await mailConnection([], mailWithSearch, {
      owner: person.userId,
    });
    await mail.answer(
      "mail.search",
      messageRead(`message-${marker}`, `Login ${marker} password: ${secret}`)
    );
    await bigMail.answer(
      "mail.search",
      messageRead(`message-${large}`, `${large} ${"x".repeat(captureBytesMax)}`)
    );
    const chat = await chatOf(
      person.userId,
      step(
        calling("MAIL", "mail.search", { query: marker }),
        calling("BIG", "mail.search", { query: large })
      ),
      says("Found them.")
    );
    await grant(chat, mail.id, "MAIL", ["mail.search"]);
    await grant(chat, bigMail.id, "BIG", ["mail.search"]);

    await chat.ask("Find them.");
    const [, bigEvents] = await Promise.all([
      captures(mail.id),
      captures(bigMail.id),
    ]);

    const { texts } = await recalled(person.userId, `login ${marker}`);
    expect({
      kept: texts.map(({ text }) => text),
      big: bigEvents.map(shown),
      large: await recalled(person.userId, large),
    }).toStrictEqual({
      kept: [
        JSON.stringify({
          id: `message-${marker}`,
          subject: `Login ${marker} password: [redacted]`,
        }),
      ],
      big: [
        {
          action: "brain.capture.skipped",
          onBehalfOf: person.userId,
          detail: { reason: "too_large", items: 1 },
        },
      ],
      large: { texts: [], elsewhere: [] },
    });
  });

  it("gives the agent its answer when the Brain refuses to keep it, audited as failed", async () => {
    const person = await signedInApi(idp, "user");
    const marker = markerOf();
    const mail = await mailConnection([], mailWithSearch, {
      owner: person.userId,
    });
    const itemId = `message-${marker}`;
    await mail.answer("mail.search", messageRead(itemId, marker));
    // The item's key erased before it is read: the Brain refuses any add.
    await eraseSource(env, {
      source: {
        producer: "capture",
        id: await captureIdOf(mail.id, person.userId, itemId),
      },
      reason: "deleted",
    });
    const chat = await chatOf(
      person.userId,
      step(calling("MAIL", "mail.search", { query: marker })),
      says("Found it.")
    );
    await grant(chat, mail.id, "MAIL", ["mail.search"]);

    await chat.ask("Find it.");
    const events = await captures(mail.id);

    expect({
      events: events.map(shown),
      // The model read the answer the code got.
      answered: JSON.stringify(chat.provider.requests.at(-1)?.body).includes(
        marker
      ),
    }).toStrictEqual({
      events: [
        {
          action: "brain.capture.failed",
          onBehalfOf: person.userId,
          detail: { items: 1 },
        },
      ],
      answered: true,
    });
  });
});
