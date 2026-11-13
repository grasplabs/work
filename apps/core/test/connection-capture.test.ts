import { provenanceMetaKey } from "@grasp-os/connector-kit/manifest";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { erasePerson, eraseSource, recallAs } from "../src/brain-next.ts";
import { captureIdOf } from "../src/connection-capture-key.ts";
import { captureRead } from "../src/connection-capture.ts";
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

  it("keeps an item in the person's own store, credentials redacted: found by their own recall, never by an App's as them, and gone once they are erased", async () => {
    const person = await signedInApi(idp, "user");
    const marker = markerOf();
    const secret = `hunter2-${crypto.randomUUID()}`;
    const { connectionId, mailbox } = await ownGmail(person);
    const id = `login-${marker}`;
    await worldHolds(stephenGoogleUrl, {
      mailbox,
      events: [],
      messages: [
        gmailMessage(id, `Login ${marker}`, `Your password: ${secret}`),
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
      })),
      asApp,
      erased,
    }).toStrictEqual({
      own: [{ redacted: true, secret: false }],
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
});
