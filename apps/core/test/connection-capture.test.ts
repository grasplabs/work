import { personalBrainOf } from "@grasp-os/brain-next/contract";
import { provenanceMetaKey } from "@grasp-os/connector-kit/manifest";
import { auditOutboxTakeMax, createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  drainAuditOutboxes,
  drainConnectOutboxSoon,
} from "../src/audit-drains.ts";
import { brainOwnExportPath } from "../src/brain-next-exports.ts";
import {
  addSource,
  erasePerson,
  eraseSource,
  recallAs,
} from "../src/brain-next.ts";
import { chatAgentId } from "../src/chats-rpc.ts";
import { captureIdOf } from "../src/connection-capture-key.ts";
import { captureRead } from "../src/connection-capture.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { personalWorkspaceId } from "../src/personal-workspace.ts";
import { chatOf, codeStep, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents, loggedEvents } from "./audit-events.ts";
import { copyOfStore, restoreStore } from "./brain-next-store-copy.ts";
import {
  consentCode,
  stephenGoogleUrl,
  stephenGraphUrl,
} from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection, mailWithSearch } from "./mail-connection.ts";
import { acmeTenant, signInConfig } from "./sign-in-config.ts";
import { openRpc, outcome, routed, signedInApi } from "./sign-in.ts";
import { connectDb, testBinding } from "./test-env.ts";

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

/** Text as Gmail's API encodes a part's data: its UTF-8 in base64url, unpadded. */
const base64Url = (text: string): string => {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

/**
 * A message as Gmail holds it (`format=full`): `subject`, and `body`, and
 * with `attachment` a text file in its part `1` too.
 */
const gmailMessage = (
  id: string,
  subject: string,
  body: string,
  attachment?: { name: string; text: string }
) => {
  const headers = [
    { name: "From", value: "Ben <ben@acme.test>" },
    { name: "Subject", value: subject },
    { name: "Message-ID", value: `<${id}@mail.gmail.com>` },
  ];
  const text = {
    mimeType: "text/plain",
    body: {
      size: new TextEncoder().encode(body).byteLength,
      data: base64Url(body),
    },
  };
  return {
    id,
    threadId: id,
    labelIds: ["INBOX"],
    snippet: subject,
    internalDate: String(Date.parse("2026-11-12T09:00:00Z")),
    payload:
      attachment === undefined
        ? { ...text, headers }
        : {
            mimeType: "multipart/mixed",
            headers,
            parts: [
              { partId: "0", ...text },
              {
                partId: "1",
                filename: attachment.name,
                mimeType: "text/plain",
                body: {
                  size: new TextEncoder().encode(attachment.text).byteLength,
                  data: base64Url(attachment.text),
                },
              },
            ],
          },
  };
};

/** A toolkit's answer naming the one item `id` it read, as `structured`. */
const oneRead = (id: string, structured: Record<string, unknown>) => ({
  content: [{ type: "text", text: JSON.stringify(structured) }],
  structuredContent: structured,
  _meta: { [provenanceMetaKey]: [id] },
});

/** A toolkit's answer naming the messages it read. */
const messagesRead = (messages: { id: string; subject: string }[]) => ({
  content: [{ type: "text", text: JSON.stringify({ messages }) }],
  structuredContent: { messages },
  _meta: { [provenanceMetaKey]: messages.map(({ id }) => id) },
});

/**
 * What `personId` recalls for `question` by its words and exact parts,
 * each item's text and version: with their own store, as their own web
 * chat does, unless `personal` is false, as an App, a workflow or the SDK
 * asks. A passage found by meaning alone is left out, so what a test
 * asserts never depends on which readable passages lie nearest the
 * question.
 */
const recalled = async (
  personId: string,
  question: string,
  personal = true
) => {
  const { items } = await recallAs(env, personId, {
    personal,
    question,
    budget,
  });
  return {
    texts: items
      .filter(({ found }) => found !== "meaning")
      .map(({ source, version, text }) => ({
        producer: source.producer,
        version,
        text,
      })),
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
  it("keeps a message the person read from their own mail, for them alone, and their recall finds it; a list, never, even of one", async () => {
    const [person, stranger] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const marker = markerOf();
    const { connectionId, mailbox } = await ownGmail(person);
    const quote = `quote-${marker}`;
    await worldHolds(stephenGoogleUrl, {
      mailbox,
      events: [],
      messages: [
        gmailMessage(quote, `Quote ${marker}`, "The quote."),
        gmailMessage(`order-${marker}`, `Order ${marker}`, "The order."),
      ],
    });
    const chat = await chatOf(
      person.userId,
      step(calling("MAIL", "mail.get", { mailbox, message: quote })),
      says("Read it."),
      // A search with exactly one hit: still a list, never kept.
      step(
        calling("MAIL", "mail.list", { mailbox, search: `order-${marker}` })
      ),
      says("Listed it.")
    );
    await grant(chat, connectionId, "MAIL", ["mail.get", "mail.list"]);

    await chat.ask("Read the quote.");
    await chat.ask("List the order.");
    const events = await captures(connectionId, 2);

    const found = await recalled(person.userId, marker);
    expect({
      events: events.map(shown),
      // The read message alone: the list kept nothing of either.
      items: found.texts.map(({ producer, text }) => ({
        producer,
        quote: text.includes(`Quote ${marker}`),
        order: text.includes(`Order ${marker}`),
      })),
      stranger: await recalled(stranger.userId, marker),
    }).toStrictEqual({
      events: [
        {
          action: "brain.capture.kept",
          onBehalfOf: person.userId,
          detail: { items: 1, kept: 1, failed: 0, skipped: 0 },
        },
        {
          action: "brain.capture.skipped",
          onBehalfOf: person.userId,
          detail: { reason: "list", items: 1, kept: 0, failed: 0, skipped: 1 },
        },
      ],
      items: [{ producer: "capture", quote: true, order: false }],
      stranger: { texts: [] },
    });
    expect(JSON.stringify(events)).not.toContain(marker);
  });

  it("keeps a message read again by the same tool as its next version", async () => {
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
      says("Read it again.")
    );
    await grant(chat, connectionId, "MAIL", ["mail.get"]);

    await worldHolds(stephenGoogleUrl, {
      mailbox,
      events: [],
      messages: [gmailMessage(id, `Quote ${marker}`, "draft")],
    });
    await chat.ask("Read the quote.");
    await captures(connectionId, 1);
    await worldHolds(stephenGoogleUrl, {
      mailbox,
      events: [],
      messages: [gmailMessage(id, `Quote ${marker}`, inBody)],
    });
    await chat.ask("Read it again.");
    await captures(connectionId, 2);

    const { texts } = await recalled(person.userId, `quote ${marker}`);
    expect(
      texts.map(({ version, text }) => ({
        version,
        latest: text.includes(inBody),
      }))
    ).toStrictEqual([{ version: 2, latest: true }]);
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
      recalled: { texts: [] },
    });
  });

  it("keeps nothing a toolkit reads, even naming one item, as no toolkit tool is marked as answering one; nor a change", async () => {
    const person = await signedInApi(idp, "user");
    const [named, sent] = [markerOf(), markerOf()];
    const mail = await mailConnection([], mailWithSearch, {
      provider: "mail_own",
      owner: person.userId,
    });
    await mail.answer("mail.search", oneRead(`message-${named}`, { named }));
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

    expect({
      events: events.map(shown),
      recalled: await Promise.all(
        [named, sent].map(
          async (marker) => await recalled(person.userId, marker)
        )
      ),
    }).toStrictEqual({
      events: [
        {
          action: "brain.capture.skipped",
          onBehalfOf: person.userId,
          detail: { reason: "list", items: 1, kept: 0, failed: 0, skipped: 1 },
        },
      ],
      recalled: [{ texts: [] }, { texts: [] }],
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
    // Its event, the last call's, in: the earlier calls' captures ended.
    const witnessed = await captures(own.id);

    expect({
      shared: sharedEvents.map(shown),
      recalled: await Promise.all(
        [sharedMarker, privateMarker, unnamed].map(
          async (marker) => await recalled(person.userId, marker)
        )
      ),
      witnessed: witnessed.map(shown),
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
      recalled: [{ texts: [] }, { texts: [] }, { texts: [] }],
      witnessed: [
        {
          action: "brain.capture.skipped",
          onBehalfOf: person.userId,
          detail: { reason: "list", items: 1, kept: 0, failed: 0, skipped: 1 },
        },
      ],
      quiet: [],
    });
  });

  it("keeps an item in the person's own store, credentials redacted and ordinary words as they were: found by their own recall, never by an App's as them, and gone once they are erased", async () => {
    const person = await signedInApi(idp, "user");
    const marker = markerOf();
    const secret = `hunter2-${crypto.randomUUID()}`;
    // A session id as a server issues one: 128 bits, as hex.
    const sessionId = crypto.randomUUID().replaceAll("-", "");
    const { connectionId, mailbox } = await ownGmail(person);
    const id = `login-${marker}`;
    await worldHolds(stephenGoogleUrl, {
      mailbox,
      events: [],
      messages: [
        gmailMessage(
          id,
          `Login ${marker}`,
          `Session: Q3 planning\nCookie: sid=${sessionId}; theme=dark\nYour password: ${secret}`
        ),
      ],
    });
    const chat = await chatOf(
      person.userId,
      step(calling("MAIL", "mail.get", { mailbox, message: id })),
      says("Read it.")
    );
    await grant(chat, connectionId, "MAIL", ["mail.get"]);

    await chat.ask("Read it.");
    await captures(connectionId);
    const own = await recalled(person.userId, `login ${marker}`);
    // As an App, a workflow or the SDK asks: the shared store alone.
    const asApp = await recalled(person.userId, `login ${marker}`, false);
    await erasePerson(env, {
      personId: person.userId,
      reason: "person_erased",
    });
    const erased = await recalled(person.userId, `login ${marker}`);

    expect({
      own: own.texts.map(({ text }) => ({
        redacted: text.includes("password: [redacted]"),
        secret: text.includes(secret),
        session: text.includes("Session: Q3 planning"),
        cookie: text.includes(sessionId),
      })),
      asApp,
      erased,
    }).toStrictEqual({
      own: [{ redacted: true, secret: false, session: true, cookie: false }],
      asApp: { texts: [] },
      erased: { texts: [] },
    });
  });

  it("counts every call as kept, failed or skipped, by what its tool answers, and gives the agent its answer whatever the Brain did", async () => {
    const person = await signedInApi(idp, "user");
    const marker = markerOf();
    const { connectionId: gmail, mailbox } = await ownGmail(person);
    const { connectionId: outlook, mailbox: outlookBox } =
      await ownMicrosoft(person);
    const large = `large-${marker}`;
    const erased = `erased-${marker}`;
    const withFile = `file-${marker}`;
    await worldHolds(stephenGoogleUrl, {
      mailbox,
      events: [],
      messages: [
        // Past the Brain's own limit once folded for its word index.
        gmailMessage(large, `Large ${marker}`, "ﷺ".repeat(35_000)),
        gmailMessage(erased, `Erased ${marker}`, "Gone."),
        gmailMessage(withFile, `File ${marker}`, "See the notes.", {
          name: "notes.txt",
          text: `Notes ${marker}`,
        }),
      ],
    });
    // One To Do list: a list still, never kept.
    await worldHolds(stephenGraphUrl, {
      mailbox: outlookBox,
      events: [],
      messages: [],
      todoLists: [
        { id: `tasks-${marker}`, displayName: "Tasks", isOwner: true },
      ],
    });
    // The erased message's key closed by an erasure before it is read.
    await eraseSource(env, {
      source: {
        producer: "capture",
        id: await captureIdOf(gmail, person.userId, "mail.get", erased),
      },
      readers: { kind: "owner", personId: person.userId },
      reason: "deleted",
    });
    const attachment = { mailbox, message: withFile, attachment: "1" };
    const calls = [
      calling("MAIL", "mail.get", { mailbox, message: large }),
      calling("MAIL", "mail.get", { mailbox, message: erased }),
      // As base64, the default: a file's bytes.
      calling("MAIL", "mail.readAttachment", attachment),
      calling("MAIL", "mail.readAttachment", { ...attachment, as: "text" }),
      calling("OUTLOOK", "todo.lists", { mailbox: outlookBox }),
    ];
    const chat = await chatOf(
      person.userId,
      ...calls.flatMap((call) => [step(call), says("Done.")])
    );
    await grant(chat, gmail, "MAIL", ["mail.get", "mail.readAttachment"]);
    await grant(chat, outlook, "OUTLOOK", ["todo.lists"]);

    for (const [index] of calls.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one turn at a time
      await chat.ask("Next.");
      // oxlint-disable-next-line no-await-in-loop -- its capture first
      await captures(
        index === calls.length - 1 ? outlook : gmail,
        index === calls.length - 1 ? 1 : index + 1
      );
    }
    const [gmailEvents, outlookEvents] = await Promise.all([
      captures(gmail, 4),
      captures(outlook),
    ]);
    const found = await recalled(person.userId, `notes ${marker}`);

    expect({
      events: [...gmailEvents, ...outlookEvents].map(shown),
      kept: found.texts.map(({ text }) => text.includes(`Notes ${marker}`)),
      // The model read the answer of the read the Brain refused.
      answered: JSON.stringify(chat.provider.requests[1]?.body).includes(
        `Large ${marker}`
      ),
    }).toStrictEqual({
      events: [
        {
          action: "brain.capture.failed",
          items: 1,
          kept: 0,
          failed: 1,
          skipped: 0,
        },
        {
          action: "brain.capture.skipped",
          reason: "erased",
          items: 1,
          kept: 0,
          failed: 0,
          skipped: 1,
        },
        {
          action: "brain.capture.skipped",
          reason: "file",
          items: 1,
          kept: 0,
          failed: 0,
          skipped: 1,
        },
        {
          action: "brain.capture.kept",
          items: 1,
          kept: 1,
          failed: 0,
          skipped: 0,
        },
        {
          action: "brain.capture.skipped",
          reason: "list",
          items: 1,
          kept: 0,
          failed: 0,
          skipped: 1,
        },
      ].map(({ action, ...detail }) => ({
        action,
        onBehalfOf: person.userId,
        detail,
      })),
      kept: [true],
      answered: true,
    });
  });

  it("keeps the later read current when an earlier read's capture lands after it", async () => {
    const person = await signedInApi(idp, "user");
    const marker = markerOf();
    const { connectionId, mailbox } = await ownGmail(person);
    const chat = await chatOf(person.userId);
    const scope = {
      workspaceId: chat.id,
      agentId: chat.agent.agentId,
      chatId: chat.chat.id,
      personId: person.userId,
      runId: crypto.randomUUID(),
    };
    const id = `quote-${marker}`;
    // Two reads of one message, as connect answered them, a second apart.
    const readOf = (subject: string, at: number) => ({
      result: {
        output: JSON.stringify({ message: { id, subject } }),
        provenance: [id],
        keep: true as const,
      },
      readAt: new Date(at),
    });
    const at = Date.now();
    const capture = async (read: ReturnType<typeof readOf>) => {
      await captureRead(
        env,
        scope,
        connectionId,
        "mail.get",
        { mailbox, message: id },
        read
      );
    };

    // The earlier read's capture is held: the later one lands first, then
    // the earlier one is let go.
    await capture(readOf(`Quote ${marker} later`, at + 1000));
    await capture(readOf(`Quote ${marker} earlier`, at));
    const events = await captures(connectionId, 2);
    const { texts } = await recalled(person.userId, `quote ${marker}`);

    expect({
      current: texts.map(({ version, text }) => ({
        version,
        later: text.includes("later"),
      })),
      events: events.map(shown),
    }).toStrictEqual({
      current: [{ version: 1, later: true }],
      events: [
        {
          action: "brain.capture.kept",
          onBehalfOf: person.userId,
          detail: { items: 1, kept: 1, failed: 0, skipped: 0 },
        },
        {
          action: "brain.capture.skipped",
          onBehalfOf: person.userId,
          detail: { reason: "stale", items: 1, kept: 0, failed: 0, skipped: 1 },
        },
      ],
    });
  });

  it("is refused unless one person alone reads it, so it never reaches the shared store or code's recall", async () => {
    const marker = markerOf();
    const added = async (readers: Parameters<typeof addSource>[1]["readers"]) =>
      await addSource(env, {
        source: { producer: "capture", id: `connection-x/${marker}` },
        change: crypto.randomUUID(),
        text: `Captured ${marker}`,
        readers,
      }).then(() => "added", String);

    await expect(
      Promise.all([
        added({ kind: "team", teamId: crypto.randomUUID() }),
        added({ kind: "none" }),
      ])
    ).resolves.toStrictEqual([
      "Error: Refused: a capture is for one person alone",
      "Error: Refused: a capture is for one person alone",
    ]);
  });
});

// Disconnecting a connection (GRA-1827; the threat model and decisions are
// on the issue): connect stops it first, whatever the Brain does; core
// then erases its captures from its person's own store at once, in one
// call that closes the connection's group (connections.ts
// `eraseCapturesSoon`), and the drain of connect's audit outbox erases them
// before the disconnect's event leaves it and records the erasure
// (capture-erasures.ts). Each way it can fail: a capture stays, or lands
// after; the Brain holds the disconnect up; a failed erasure is never
// tried again, or holds the drain up for good; a restore of an older copy
// of the store brings one back; an export taken before still serves one;
// someone else's disconnect erases what is not theirs; a reconnect sees
// what was erased; the erasure is recorded more than once, or not at all.

/** A chat's agent of `personId`, as capture records whose read it kept. */
const scopeOf = (personId: string) => ({
  workspaceId: personalWorkspaceId(personId),
  agentId: chatAgentId,
  chatId: chatIdSchema.parse(crypto.randomUUID()),
  personId,
  runId: crypto.randomUUID(),
});

/**
 * Captures the message `id` (`subject`) read with `mail.get` through
 * `connectionId` for `personId`, as connect answered it, through `withEnv`:
 * the key of the source it is kept as, if it is.
 */
const capturedRead = async (
  personId: string,
  connectionId: string,
  mailbox: string,
  id: string,
  subject: string,
  withEnv: Env = env
): Promise<string> => {
  await captureRead(
    withEnv,
    scopeOf(personId),
    connectionId,
    "mail.get",
    { mailbox, message: id },
    {
      result: {
        output: JSON.stringify({ message: { id, subject } }),
        provenance: [id],
        keep: true,
      },
      readAt: new Date(),
    }
  );
  return `capture:${await captureIdOf(connectionId, personId, "mail.get", id)}`;
};

/** The keys of the sources `personId`'s own chat recalls for `question`. */
const recalledKeys = async (
  personId: string,
  question: string
): Promise<Set<string>> => {
  const { items } = await recallAs(env, personId, {
    personal: true,
    question,
    budget,
  });
  return new Set(items.map(({ source }) => `${source.producer}:${source.id}`));
};

/** What `personId`'s own store says of each of `keys`. */
const ownKeyStates = async (
  personId: string,
  keys: readonly string[]
): Promise<string[]> => {
  const store = personalBrainOf(inJurisdiction(env, env.BRAIN_STORE), personId);
  return await Promise.all(keys.map(async (key) => await store.keyState(key)));
};

/**
 * Once the erasure core runs in the background after a disconnect has
 * closed every one of `keys` in `personId`'s own store, within a bound.
 */
const erasedSoon = async (
  personId: string,
  keys: readonly string[]
): Promise<void> => {
  await vi.waitFor(
    async () => {
      await expect(ownKeyStates(personId, keys)).resolves.toStrictEqual(
        keys.map(() => "erased")
      );
    },
    { timeout: 10_000, interval: 50 }
  );
};

/** The events of `action` about `connectionId` in `events`. */
const about = (
  events: readonly AuditEvent[],
  action: string,
  connectionId: string
): AuditEvent[] =>
  events.filter(
    (event) => event.action === action && event.target?.id === connectionId
  );

/** The events of `action` about `connectionId`, every outbox drained. */
const eventsOf = async (
  action: string,
  connectionId: string
): Promise<AuditEvent[]> => about(await allEvents(), action, connectionId);

/**
 * Core's env with `personId`'s own Brain store's `method` replaced by
 * `instead`, given the store's own; every other call reaches the store.
 */
const ownStoreWith = (
  personId: string,
  method: string,
  instead: (
    real: (...args: unknown[]) => Promise<unknown>,
    args: unknown[]
  ) => Promise<unknown>
): Env => {
  const binding = env.BRAIN_STORE;
  const getByName = (name: string) => {
    const stub = binding.getByName(name);
    if (name !== `person:${personId}`) {
      return stub;
    }
    return new Proxy(stub, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        const real = async (...args: unknown[]): Promise<unknown> => {
          const answered: unknown = await Reflect.apply(value, target, args);
          return answered;
        };
        return property === method
          ? async (...args: unknown[]) => await instead(real, args)
          : real;
      },
    });
  };
  return {
    ...env,
    BRAIN_STORE: new Proxy(binding, {
      get: (target, property): unknown =>
        property === "getByName" ? getByName : Reflect.get(target, property),
    }),
  };
};

/** Core's env with `personId`'s own store failing every erasure. */
const ownEraseFailing = (personId: string): Env =>
  ownStoreWith(personId, "eraseSource", async () => {
    await Promise.resolve();
    throw new Error("Out of reach, for the test");
  });

/**
 * Core's env with `personId`'s own store holding each call of `method`
 * until `release`, and `reached` once one waits.
 */
const ownHeld = (personId: string, method: "addSource" | "eraseSource") => {
  const gate = Promise.withResolvers<true>();
  const reached = Promise.withResolvers<true>();
  const withEnv = ownStoreWith(personId, method, async (real, args) => {
    reached.resolve(true);
    await gate.promise;
    return await real(...args);
  });
  return {
    withEnv,
    reached: reached.promise,
    release: () => {
      gate.resolve(true);
    },
  };
};

/** The state of `cookie`'s person's own export, once written: its id and state. */
const ownExportOf = async (cookie: string) => {
  const response = await routed(brainOwnExportPath, {
    headers: { cookie, "sec-fetch-site": "same-origin" },
  });
  const { export: own } = z
    .object({
      export: z.object({ id: z.uuid(), state: z.string() }).nullable(),
    })
    .parse(await response.json());
  return own;
};

/** Starts `person`'s own export and lets their store write it: its id. */
const ownExported = async (person: Person): Promise<string> => {
  const started = await routed(brainOwnExportPath, {
    method: "POST",
    headers: { cookie: person.session, "sec-fetch-site": "same-origin" },
  });
  const { id } = z.object({ id: z.uuid() }).parse(await started.json());
  const store = inJurisdiction(env, env.BRAIN_STORE).getByName(
    `person:${person.userId}`
  );
  for (let alarms = 0; alarms < 10; alarms += 1) {
    // oxlint-disable-next-line no-await-in-loop -- an alarm at a time
    const own = await ownExportOf(person.session);
    if (own?.state !== "writing") {
      break;
    }
    // oxlint-disable-next-line no-await-in-loop -- an alarm at a time
    await runDurableObjectAlarm(store);
  }
  return id;
};

/** Which of the events `ids` are still in connect's audit outbox. */
const inConnectOutbox = async (ids: readonly string[]): Promise<string[]> => {
  const { results } = await connectDb()
    .prepare(
      "SELECT id FROM audit_outbox WHERE id IN (SELECT value FROM json_each(?)) ORDER BY rowid"
    )
    .bind(JSON.stringify(ids))
    .all<{ id: string }>();
  return results.map(({ id }) => id);
};

/**
 * `count` disconnects of `connectionId` that stopped it, as connect
 * records one, put in its audit outbox: their event IDs.
 */
const forgedDisconnects = async (
  connectionId: string,
  count: number
): Promise<string[]> => {
  const events = Array.from({ length: count }, () =>
    createAuditEvent(
      {
        actor: { type: "system" },
        action: "connection.disconnect",
        target: { type: "connection", id: connectionId },
        detail: { outcome: "ok" },
      },
      "connect"
    )
  );
  const db = connectDb();
  await db.batch(
    events.map((event) =>
      db
        .prepare(
          "INSERT INTO audit_outbox (id, event, created_at) VALUES (?, ?, ?)"
        )
        .bind(event.id, JSON.stringify(event), Date.now())
    )
  );
  return events.map(({ id }) => id);
};

/** An erasure's event as the tests compare it: who, and how many. */
const erasure = ({ actor, detail }: AuditEvent) => ({ actor, detail });

describe("a disconnected connection", setUpTime, () => {
  it("takes every capture of it from its person's own store at once, refuses an add held past it, and is recorded once, with how many", async () => {
    const person = await signedInApi(idp, "user");
    const marker = markerOf();
    const { connectionId, mailbox } = await ownGmail(person);
    const kept = [
      await capturedRead(
        person.userId,
        connectionId,
        mailbox,
        `quote-${marker}`,
        `Quote ${marker}`
      ),
      await capturedRead(
        person.userId,
        connectionId,
        mailbox,
        `order-${marker}`,
        `Order ${marker}`
      ),
    ];
    const before = await recalledKeys(person.userId, marker);
    // A read connect answered before the disconnect, its add held until
    // after it.
    const held = ownHeld(person.userId, "addSource");
    const late = capturedRead(
      person.userId,
      connectionId,
      mailbox,
      `late-${marker}`,
      `Late ${marker}`,
      held.withEnv
    );
    await held.reached;

    await person.api.connections.disconnect(connectionId);
    // At once, in the background, before any drain of connect's outbox.
    await erasedSoon(person.userId, kept);
    const atOnce = await recalledKeys(person.userId, marker);
    held.release();
    const lateKey = await late;
    const events = await allEvents();

    expect({
      before: kept.map((key) => before.has(key)),
      atOnce: kept.map((key) => atOnce.has(key)),
      states: await ownKeyStates(person.userId, [...kept, lateKey]),
      late: about(events, "brain.capture.skipped", connectionId).map(shown),
      erased: about(events, "brain.capture.erased", connectionId).map(erasure),
    }).toStrictEqual({
      before: [true, true],
      atOnce: [false, false],
      states: ["erased", "erased", "erased"],
      late: [
        {
          action: "brain.capture.skipped",
          onBehalfOf: person.userId,
          detail: {
            reason: "erased",
            items: 1,
            kept: 0,
            failed: 0,
            skipped: 1,
          },
        },
      ],
      erased: [
        {
          actor: { type: "person", userId: person.userId },
          detail: { sources: 2 },
        },
      ],
    });
    expect(
      JSON.stringify(about(events, "brain.capture.erased", connectionId))
    ).not.toContain(marker);
  });

  it("answers the disconnect before its erasure runs, and a read landing meanwhile goes with the connection's captures", async () => {
    const person = await signedInApi(idp, "user");
    const marker = markerOf();
    const { connectionId, mailbox } = await ownGmail(person);
    const first = await capturedRead(
      person.userId,
      connectionId,
      mailbox,
      `quote-${marker}`,
      `Quote ${marker}`
    );
    const held = ownHeld(person.userId, "eraseSource");
    const { core } = await openRpc(person.session, { coreEnv: held.withEnv });

    // Answered while the erasure waits.
    const disconnected = await outcome(
      core.authenticate().connections.disconnect(connectionId)
    );
    await held.reached;
    // Read before the disconnect, captured before its erasure ran.
    const second = await capturedRead(
      person.userId,
      connectionId,
      mailbox,
      `order-${marker}`,
      `Order ${marker}`
    );
    const meanwhile = await recalledKeys(person.userId, marker);
    held.release();
    await erasedSoon(person.userId, [first, second]);
    const after = await recalledKeys(person.userId, marker);

    expect({
      disconnected,
      meanwhile: [first, second].map((key) => meanwhile.has(key)),
      after: [first, second].map((key) => after.has(key)),
    }).toStrictEqual({
      disconnected: "ok",
      meanwhile: [true, true],
      after: [false, false],
    });
  });

  it("disconnects whatever the Brain does, and erases what was kept, also what landed meanwhile, once connect's outbox drains", async () => {
    const person = await signedInApi(idp, "user");
    const marker = markerOf();
    const { connectionId, mailbox } = await ownGmail(person);
    const first = await capturedRead(
      person.userId,
      connectionId,
      mailbox,
      `quote-${marker}`,
      `Quote ${marker}`
    );
    const failing = ownEraseFailing(person.userId);
    const { core } = await openRpc(person.session, { coreEnv: failing });

    const disconnected = await outcome(
      core.authenticate().connections.disconnect(connectionId)
    );
    const listed = await person.api.connections.list();
    // Read before the disconnect, captured after it, before any erasure.
    const second = await capturedRead(
      person.userId,
      connectionId,
      mailbox,
      `order-${marker}`,
      `Order ${marker}`
    );
    const meanwhile = await recalledKeys(person.userId, marker);
    // The Brain still out of reach as connect's outbox drains: its batch,
    // logged, stays in it.
    await drainAuditOutboxes(failing);
    const logged = await loggedEvents();
    const kept = await recalledKeys(person.userId, marker);
    // Once it can be reached, the next drain erases them.
    const drained = await allEvents();
    const after = await recalledKeys(person.userId, marker);
    const again = await allEvents();

    expect({
      disconnected,
      connected: listed.some(({ id }) => id === connectionId),
      meanwhile: [first, second].map((key) => meanwhile.has(key)),
      logged: {
        stopped: about(logged, "connection.disconnect", connectionId).length,
        erased: about(logged, "brain.capture.erased", connectionId).length,
      },
      kept: [first, second].map((key) => kept.has(key)),
      after: [first, second].map((key) => after.has(key)),
      states: await ownKeyStates(person.userId, [first, second]),
      erased: about(drained, "brain.capture.erased", connectionId).map(erasure),
      again: about(again, "brain.capture.erased", connectionId).length,
    }).toStrictEqual({
      disconnected: "ok",
      connected: false,
      meanwhile: [true, true],
      logged: { stopped: 1, erased: 0 },
      kept: [true, true],
      after: [false, false],
      states: ["erased", "erased"],
      erased: [
        {
          actor: { type: "person", userId: person.userId },
          detail: { sources: 2 },
        },
      ],
      again: 1,
    });
  });

  it("erases nothing, records nothing, and lets the disconnect go, for a person whose own store was erased whole", async () => {
    const person = await signedInApi(idp, "user");
    const marker = markerOf();
    const { connectionId, mailbox } = await ownGmail(person);
    const kept = await capturedRead(
      person.userId,
      connectionId,
      mailbox,
      `quote-${marker}`,
      `Quote ${marker}`
    );
    await erasePerson(env, {
      personId: person.userId,
      reason: "person_erased",
    });

    await person.api.connections.disconnect(connectionId);
    const stopped = await eventsOf("connection.disconnect", connectionId);
    const erased = await eventsOf("brain.capture.erased", connectionId);
    const found = await recalledKeys(person.userId, marker);

    expect({
      found: found.has(kept),
      erased: erased.length,
      left: await inConnectOutbox(stopped.map(({ id }) => id)),
    }).toStrictEqual({ found: false, erased: 0, left: [] });
  });

  it("holds only the disconnect whose person's store stays out of reach, while everyone else's events reach the log in order, and erases it once that store is back", async () => {
    const [held, other, newcomer] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const marker = markerOf();
    const heldConnection = await ownGmail(held);
    const otherConnection = await ownGmail(other);
    const heldKey = await capturedRead(
      held.userId,
      heldConnection.connectionId,
      heldConnection.mailbox,
      `quote-${marker}`,
      `Quote ${marker}`
    );
    const otherKey = await capturedRead(
      other.userId,
      otherConnection.connectionId,
      otherConnection.mailbox,
      `order-${marker}`,
      `Order ${marker}`
    );
    const failing = ownEraseFailing(held.userId);
    const { core } = await openRpc(held.session, { coreEnv: failing });

    await core
      .authenticate()
      .connections.disconnect(heldConnection.connectionId);
    await drainAuditOutboxes(failing);
    // Newer than the held disconnect: another disconnect, then a connect.
    await other.api.connections.disconnect(otherConnection.connectionId);
    const newConnection = await ownGmail(newcomer);
    await drainAuditOutboxes(failing);
    await drainAuditOutboxes(failing);
    const logged = await loggedEvents();
    const position = (action: string, connectionId: string): number =>
      logged.findIndex(
        (event) => event.action === action && event.target?.id === connectionId
      );
    const heldStop = about(
      logged,
      "connection.disconnect",
      heldConnection.connectionId
    );
    const heldRecalled = await recalledKeys(held.userId, marker);
    const whileHeld = {
      heldErased: about(
        logged,
        "brain.capture.erased",
        heldConnection.connectionId
      ).length,
      otherErased: about(
        logged,
        "brain.capture.erased",
        otherConnection.connectionId
      ).map(erasure),
      inOrder:
        position("connection.disconnect", otherConnection.connectionId) <
        position("connection.connect", newConnection.connectionId),
      left: await inConnectOutbox(heldStop.map(({ id }) => id)),
      heldFound: heldRecalled.has(heldKey),
    };
    // The store back: the next drain erases it, and the one after changes
    // nothing.
    await allEvents();
    const after = await eventsOf(
      "brain.capture.erased",
      heldConnection.connectionId
    );

    expect({
      whileHeld,
      heldStops: heldStop.length,
      after: after.map(erasure),
      left: await inConnectOutbox(heldStop.map(({ id }) => id)),
      states: [
        ...(await ownKeyStates(held.userId, [heldKey])),
        ...(await ownKeyStates(other.userId, [otherKey])),
      ],
    }).toStrictEqual({
      whileHeld: {
        heldErased: 0,
        otherErased: [
          {
            actor: { type: "person", userId: other.userId },
            detail: { sources: 1 },
          },
        ],
        inOrder: true,
        left: heldStop.map(({ id }) => id),
        heldFound: true,
      },
      heldStops: 1,
      after: [
        {
          actor: { type: "person", userId: held.userId },
          detail: { sources: 1 },
        },
      ],
      left: [],
      states: ["erased", "erased"],
    });
  });

  it("lets newer events through past more held disconnects than a drain takes at once", async () => {
    const [held, other] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const marker = markerOf();
    const heldConnection = await ownGmail(held);
    const otherConnection = await ownGmail(other);
    const heldKey = await capturedRead(
      held.userId,
      heldConnection.connectionId,
      heldConnection.mailbox,
      `quote-${marker}`,
      `Quote ${marker}`
    );
    await allEvents();
    // A full batch of disconnects and one more, all of one connection
    // whose person's store is out of reach, ahead of a newer one.
    const forged = await forgedDisconnects(
      heldConnection.connectionId,
      auditOutboxTakeMax + 1
    );
    const failing = ownEraseFailing(held.userId);

    await other.api.connections.disconnect(otherConnection.connectionId);
    await drainAuditOutboxes(failing);
    const logged = await loggedEvents();
    const stillHeld = await inConnectOutbox(forged);
    const whileHeld = {
      other: about(
        logged,
        "connection.disconnect",
        otherConnection.connectionId
      ).length,
      left: stillHeld.length,
    };
    await allEvents();

    expect({
      whileHeld,
      left: await inConnectOutbox(forged),
      state: await ownKeyStates(held.userId, [heldKey]),
    }).toStrictEqual({
      whileHeld: { other: 1, left: forged.length },
      left: [],
      state: ["erased"],
    });
  });

  it("keeps connect's events in the order they were stored when another drain settles a held one mid-way", async () => {
    const held = await signedInApi(idp, "user");
    const { connectionId } = await ownGmail(held);
    await allEvents();
    // One disconnect whose person's store fails for this drain, then more
    // events than a batch, of a connection nobody holds captures through.
    const [heldId] = await forgedDisconnects(connectionId, 1);
    const after = await forgedDisconnects(
      `connection-${crypto.randomUUID()}`,
      auditOutboxTakeMax + auditOutboxTakeMax / 2
    );
    // As this drain's erasure fails, another drain (one batch, its store
    // in reach) takes the same rows and settles them, the held one with
    // them.
    const meanwhile = ownStoreWith(held.userId, "eraseSource", async () => {
      drainConnectOutboxSoon(env);
      await vi.waitFor(
        async () => {
          await expect(inConnectOutbox([heldId ?? ""])).resolves.toStrictEqual(
            []
          );
        },
        { timeout: 10_000, interval: 50 }
      );
      throw new Error("Out of reach, for the test");
    });

    await drainAuditOutboxes(meanwhile);
    const logged = await allEvents();
    const positions = after.map((id) =>
      logged.findIndex((event) => event.id === id)
    );

    expect({
      missing: positions.filter((at) => at === -1).length,
      inOrder: positions.every(
        (at, index) => index === 0 || at > (positions[index - 1] ?? at)
      ),
    }).toStrictEqual({ missing: 0, inOrder: true });
  });

  it("passes a disconnect the Brain could never have kept a capture under, so it holds nothing up", async () => {
    const owner = await signedInApi(idp, "user");
    const now = Date.now();
    // Forged: an id holding "/", and an owner the Brain refuses as a person.
    const withSlash = `connection/${crypto.randomUUID()}`;
    const longOwned = crypto.randomUUID();
    await connectDb()
      .prepare(
        "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, created_at, updated_at) VALUES (?, 'google', 'personal', ?, 'disconnected', 'native', 'google-workspace', ?, ?), (?, 'google', 'personal', ?, 'disconnected', 'native', 'google-workspace', ?, ?)"
      )
      .bind(
        withSlash,
        owner.userId,
        now,
        now,
        longOwned,
        "x".repeat(1000),
        now,
        now
      )
      .run();
    const forged = [
      ...(await forgedDisconnects(withSlash, 1)),
      ...(await forgedDisconnects(longOwned, 1)),
    ];

    const events = await allEvents();

    expect({
      left: await inConnectOutbox(forged),
      erased: [withSlash, longOwned].flatMap((id) =>
        about(events, "brain.capture.erased", id)
      ),
    }).toStrictEqual({ left: [], erased: [] });
  });

  it("keeps its captures erased after a restore of an older copy of its person's store, and an export taken before serves none", async () => {
    const person = await signedInApi(idp, "user");
    const marker = markerOf();
    const { connectionId, mailbox } = await ownGmail(person);
    const kept = await capturedRead(
      person.userId,
      connectionId,
      mailbox,
      `quote-${marker}`,
      `Quote ${marker}`
    );
    const exported = await ownExported(person);
    const before = await ownExportOf(person.session);
    const copy = await copyOfStore(`person:${person.userId}`);

    await person.api.connections.disconnect(connectionId);
    await erasedSoon(person.userId, [kept]);
    const stale = await ownExportOf(person.session);
    await restoreStore(copy, `person:${person.userId}`);
    // The restored copy held the capture and knew no erasure of it.
    const late = await capturedRead(
      person.userId,
      connectionId,
      mailbox,
      `late-${marker}`,
      `Late ${marker}`
    );
    const restored = await recalledKeys(person.userId, marker);

    expect({
      export: [before?.state, stale?.id === exported, stale?.state],
      restored: [kept, late].map((key) => restored.has(key)),
      states: await ownKeyStates(person.userId, [kept, late]),
    }).toStrictEqual({
      export: ["done", true, "erased"],
      restored: [false, false],
      states: ["erased", "erased"],
    });
  });

  it("is stopped and its captures' erasure recorded once, however many disconnects ask, at once or after", async () => {
    const person = await signedInApi(idp, "user");
    const marker = markerOf();
    const { connectionId, mailbox } = await ownGmail(person);
    const kept = await capturedRead(
      person.userId,
      connectionId,
      mailbox,
      `quote-${marker}`,
      `Quote ${marker}`
    );

    const outcomes = await Promise.all([
      outcome(person.api.connections.disconnect(connectionId)),
      outcome(person.api.connections.disconnect(connectionId)),
    ]);
    outcomes.push(
      await outcome(person.api.connections.disconnect(connectionId))
    );
    const events = await allEvents();
    const found = await recalledKeys(person.userId, marker);

    expect({
      outcomes,
      found: found.has(kept),
      states: await ownKeyStates(person.userId, [kept]),
      stopped: about(events, "connection.disconnect", connectionId).filter(
        ({ detail }) => detail.outcome === "ok"
      ).length,
      erased: about(events, "brain.capture.erased", connectionId).map(erasure),
    }).toStrictEqual({
      outcomes: ["ok", "ok", "ok"],
      found: false,
      states: ["erased"],
      stopped: 1,
      erased: [
        {
          actor: { type: "person", userId: person.userId },
          detail: { sources: 1 },
        },
      ],
    });
  });

  it("takes a removed member's captures with the connections their removal disconnects", async () => {
    const [person, admin] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const marker = markerOf();
    const { connectionId, mailbox } = await ownGmail(person);
    const kept = await capturedRead(
      person.userId,
      connectionId,
      mailbox,
      `quote-${marker}`,
      `Quote ${marker}`
    );

    await admin.api.members.remove(person.userId);
    const erased = await eventsOf("brain.capture.erased", connectionId);

    expect({
      states: await ownKeyStates(person.userId, [kept]),
      erased: erased.map(erasure),
    }).toStrictEqual({
      states: ["erased"],
      erased: [
        {
          actor: { type: "person", userId: admin.userId },
          detail: { sources: 1 },
        },
      ],
    });
  });

  it("captures afresh when the same account is connected again, and brings nothing erased back", async () => {
    const person = await signedInApi(idp, "user");
    const marker = markerOf();
    const old = await ownGmail(person);
    const message = `quote-${marker}`;
    const erased = await capturedRead(
      person.userId,
      old.connectionId,
      old.mailbox,
      message,
      `Quote ${marker}`
    );
    await person.api.connections.disconnect(old.connectionId);
    await erasedSoon(person.userId, [erased]);

    const again = await ownGmail(person);
    const fresh = await capturedRead(
      person.userId,
      again.connectionId,
      again.mailbox,
      message,
      `Quote ${marker} again`
    );
    const found = await recalledKeys(person.userId, marker);

    expect({
      newConnection: again.connectionId !== old.connectionId,
      found: [erased, fresh].map((key) => found.has(key)),
      states: await ownKeyStates(person.userId, [erased, fresh]),
    }).toStrictEqual({
      newConnection: true,
      found: [false, true],
      states: ["erased", "held"],
    });
  });

  it("erases nothing of a person's when someone else tries to disconnect their connection", async () => {
    const [person, stranger, admin] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const marker = markerOf();
    const { connectionId, mailbox } = await ownGmail(person);
    const kept = await capturedRead(
      person.userId,
      connectionId,
      mailbox,
      `quote-${marker}`,
      `Quote ${marker}`
    );

    const refused = await Promise.all([
      outcome(stranger.api.connections.disconnect(connectionId)),
      outcome(admin.api.connections.disconnect(connectionId)),
    ]);
    const found = await recalledKeys(person.userId, marker);
    const erased = await eventsOf("brain.capture.erased", connectionId);

    expect({
      refused,
      found: found.has(kept),
      erased: erased.length,
    }).toStrictEqual({
      refused: ["connect.not_owner", "connect.not_owner"],
      found: true,
      erased: 0,
    });
  });
});
