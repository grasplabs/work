import { brainOf, recallBudgetMax } from "@grasp-os/brain-next/contract";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { drainAuditOutboxes } from "../src/audit-drains.ts";
import { recallAs } from "../src/brain-next.ts";
import { chatAgentId } from "../src/chats-rpc.ts";
import { sharedReadHashOf } from "../src/connection-capture-key.ts";
import { captureRead } from "../src/connection-capture.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { personalWorkspaceId } from "../src/personal-workspace.ts";
import { completeOwedErasures, keptOf } from "../src/shared-reads.ts";
import { chatOf, codeStep, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { chooseAudience } from "./brain-audiences.ts";
import { newTeam } from "./brain-next-leaks-harness.ts";
import { afterFirstRead } from "./d1-after-first-read.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { signedInApi, signedInWithRole, unique } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// What agents read through a shared connection, kept in the shared Brain
// for the audience an admin chose for it (GRA-1831, src/connection-
// capture.ts, its shared lane). From the threat model on the issue: a
// record kept while nobody is the audience, or for a wider audience than
// the one held; one kept during an erasure or after a disconnect; a read
// of others' things kept; the same record kept twice, once per member;
// someone who made an agent read it reading it back from outside the
// audience. Through the real connect for a chat, with only the toolkit's
// MCP server faked; races through the capture itself, with the
// competing change landing between its claim and its add.

const idp = mockIdp();

/** Signing people in, connecting and granting can be slow on CI. */
const setUpTime = { timeout: 90_000 };

type Chat = Awaited<ReturnType<typeof chatOf>>;

/** A word nothing else holds. */
const markerOf = (): string => `shr${crypto.randomUUID().replaceAll("-", "")}`;

/** Code that calls `action` on `binding` with `input`, giving its output. */
const calling = (binding: string, action: string, input: unknown) =>
  `(await env.connections.call(${JSON.stringify(binding)}, ${JSON.stringify(action)}, ${JSON.stringify(input)})).output`;

/** A code step running `calls` in order, returning what the last gave. */
const step = (...calls: string[]) =>
  codeStep(
    `export default async (self, env) => { let last; ${calls.map((call) => `last = ${call};`).join(" ")} return last; };`
  );

/** The toolkit's tools: a read of the company's deals, and one of others' mail. */
const listed = [
  {
    name: "mail.search",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
    },
  },
  {
    name: "mail.others",
    inputSchema: {
      type: "object",
      properties: { mailbox: { type: "string" } },
    },
  },
];

/**
 * Both marked as reads by the admin. Under the toolkit `mail_own`,
 * connect's review classes the search a read of the connected account's
 * own things and `mail.others` a read of others' things.
 */
const allowed = [
  { name: "mail.search", read: true },
  { name: "mail.others", read: true },
];

/** A toolkit's answer as structured content, its text beside it. */
const structured = (content: Record<string, unknown>) => ({
  content: [{ type: "text", text: JSON.stringify(content) }],
  structuredContent: content,
});

/** Grants the chat's agent `actions` on `connectionId` under `binding`. */
const grant = async (
  chat: Chat,
  connectionId: string,
  binding: string,
  actions: string[]
): Promise<void> => {
  const admin = await signedInApi(idp, "admin");
  await requestGranted(idp, admin, {
    subject: chat.agent,
    object: { type: "connection", connectionId },
    actions,
    binding,
  });
};

/** What `personId` recalls holding `marker`, as themselves: each item's source and version. */
const recalled = async (personId: string, marker: string) => {
  const { items } = await recallAs(env, personId, {
    personal: true,
    question: marker,
    budget: { tokens: recallBudgetMax },
  });
  return items
    .filter(({ text }) => text.includes(marker))
    .map(({ source, version }) => `${source.producer}:${source.id}@${version}`);
};

/** Whether `personId` finds `marker` in anything the Brain kept. */
const finds = async (personId: string, marker: string): Promise<boolean> => {
  const found = await recalled(personId, marker);
  return found.length > 0;
};

/** The capture events about `connectionId`, once `count` of them are in. */
const captures = async (
  connectionId: string,
  count: number
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
      await expect(mine()).resolves.toHaveLength(count);
    },
    { timeout: 10_000, interval: 50 }
  );
  return await mine();
};

/** An event as the tests compare it: who it was for, and its detail. */
const shown = ({ action, actor, detail }: AuditEvent) => ({
  action,
  onBehalfOf: actor.type === "agent" ? actor.onBehalfOf : null,
  reason: detail.reason ?? null,
});

/** The key a shared read of `mail.search` for `query` is kept under. */
const keyOf = async (connectionId: string, query: string): Promise<string> =>
  `connected:${connectionId}/0/${await sharedReadHashOf("mail.search", {
    input: { query },
  })}`;

/** The shared store's state of `key`: free, held or erased. */
const keyState = async (key: string): Promise<string> =>
  await brainOf(inJurisdiction(env, env.BRAIN_STORE)).keyState(key);

/** A shared toolkit connection in connect's registry, its search a read the admin allowed. */
const sharedMail = async (): Promise<string> => {
  const id = `connection-mail-${unique()}`;
  const now = Date.now();
  await connectDb()
    .prepare(
      "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, tools, created_at, updated_at) VALUES (?, 'mail', 'shared', NULL, 'active', 'composio', 'https://mail.test/mcp', ?, ?, ?)"
    )
    .bind(id, JSON.stringify([{ name: "mail.search", read: true }]), now, now)
    .run();
  return id;
};

/**
 * `reader`'s chat's agent's search of `connectionId` for `marker`,
 * captured with `between` landing right after the record was named
 * (`claimSharedRead`) and before the Brain is given it.
 */
const capturedWith = async (
  reader: string,
  connectionId: string,
  marker: string,
  between: () => Promise<void>,
  readAt = new Date()
): Promise<void> => {
  const racing: Env = {
    ...env,
    DB: afterFirstRead(env.DB, 'insert into "connection_brain_reads"', between),
  };
  await captureRead(
    racing,
    {
      workspaceId: personalWorkspaceId(reader),
      agentId: chatAgentId,
      chatId: chatIdSchema.parse(crypto.randomUUID()),
      personId: reader,
      runId: crypto.randomUUID(),
    },
    connectionId,
    "mail.search",
    { query: marker },
    {
      result: {
        output: JSON.stringify(`Deal ${marker}`),
        provenance: [],
        keep: true,
      },
      readAt,
    }
  );
};

/** Nothing landing between a capture's naming and its add. */
const nothing = async (): Promise<void> => {
  await Promise.resolve();
};

/** Every erasure under way taken to its end, as the clock would. */
const erasuresEnded = async (): Promise<void> => {
  for (let run = 0; run < 5; run += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one run at a time
    await completeOwedErasures(env);
  }
};

/** An admin, two members of a new team, and a shared connection open to it. */
const openToTeam = async () => {
  const [admin, member, other] = await Promise.all([
    signedInApi(idp, "admin"),
    signedInWithRole(idp, "user"),
    signedInWithRole(idp, "user"),
  ]);
  const team = await newTeam(member.userId);
  const connectionId = await sharedMail();
  await chooseAudience(admin.api, connectionId, { kind: "team", teamId: team });
  return {
    admin,
    member: member.userId,
    other: other.userId,
    team,
    connectionId,
  };
};

describe("what agents read through a shared connection", setUpTime, () => {
  it("keeps one record for the connection's audience, whoever read it, and nothing of others' things, so a reader outside the audience never reads it back", async () => {
    const [admin, ann, bea, dana, carl] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const sales = await newTeam(ann.userId, bea.userId, dana.userId);
    const [deal, others] = [markerOf(), markerOf()];
    const company = await mailConnection([], allowed, {
      provider: "mail_own",
    });
    await company.serves(listed);
    await company.answers({
      "mail.search": structured({ deals: [`Deal ${deal}`] }),
      "mail.others": structured({ messages: [`Others ${others}`] }),
    });
    await chooseAudience(admin.api, company.id, {
      kind: "team",
      teamId: sales,
    });
    // Agents may read others' things here, so that read runs, and only
    // its capture is in question.
    await env.DB.prepare(
      "INSERT OR REPLACE INTO tool_class_settings (tool_class, who, teams, changed_by, changed_at) VALUES ('read-others', 'everyone', '[]', 'test-admin', ?)"
    )
      .bind(Date.now())
      .run();
    // Ann reads the deal and someone's mail; Bea reads the same deal;
    // Carl, outside the audience, has his agent read it too. One chat at
    // a time: the tests' model answers whichever asks.
    const search = calling("MAIL", "mail.search", { query: deal });
    for (const [person, code, actions] of [
      [
        ann,
        step(search, calling("MAIL", "mail.others", { mailbox: others })),
        ["mail.search", "mail.others"],
      ],
      [bea, step(search), ["mail.search"]],
      [carl, step(search), ["mail.search"]],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one chat at a time
      const chat = await chatOf(person.userId, code, says("Read it."));
      // oxlint-disable-next-line no-await-in-loop -- one chat at a time
      await grant(chat, company.id, "MAIL", [...actions]);
      // oxlint-disable-next-line no-await-in-loop -- one chat at a time
      await chat.ask("Read it.");
    }
    const events = await captures(company.id, 4);
    const kept = `${await keyOf(company.id, deal)}@1`;

    expect({
      events: events.map(shown),
      ann: await recalled(ann.userId, deal),
      bea: await recalled(bea.userId, deal),
      // In the audience, though their agent never read it.
      dana: await recalled(dana.userId, deal),
      // His agent read it: he reads it at the source, never from the Brain.
      carl: await recalled(carl.userId, deal),
      othersByAnn: await finds(ann.userId, others),
      othersByDana: await finds(dana.userId, others),
    }).toStrictEqual({
      events: [
        { action: "brain.capture.kept", onBehalfOf: ann.userId, reason: null },
        {
          action: "brain.capture.skipped",
          onBehalfOf: ann.userId,
          reason: "reach",
        },
        { action: "brain.capture.kept", onBehalfOf: bea.userId, reason: null },
        { action: "brain.capture.kept", onBehalfOf: carl.userId, reason: null },
      ],
      // One record, its one version: the same answer read again adds only
      // its read time.
      ann: [kept],
      bea: [kept],
      dana: [kept],
      carl: [],
      othersByAnn: false,
      othersByDana: false,
    });
  });

  it("gives the connection's last read as the latest read of a record read again, while it has an audience", async () => {
    const { admin, member, team, connectionId } = await openToTeam();
    const marker = markerOf();
    const day = 24 * 60 * 60 * 1000;
    const first = new Date(Date.now() - 2 * day);
    const again = new Date(Date.now() - day);
    const lastRead = async () => {
      const [row] = await keptOf(env, [connectionId]);
      return row === undefined
        ? undefined
        : { records: row.records, lastReadAt: row.lastReadAt };
    };
    await capturedWith(member, connectionId, marker, nothing, first);
    await capturedWith(member, connectionId, marker, nothing, again);
    const readAgain = await lastRead();
    // A read older than the latest, landing after it, moves nothing back.
    await capturedWith(member, connectionId, marker, nothing, first);
    const lateOlder = await lastRead();
    // With no audience the read is not named, so it moves nothing either.
    await chooseAudience(admin.api, connectionId, { kind: "nobody" });
    await capturedWith(member, connectionId, marker, nothing);
    await chooseAudience(admin.api, connectionId, {
      kind: "team",
      teamId: team,
    });

    expect({ readAgain, lateOlder, closed: await lastRead() }).toStrictEqual({
      readAgain: { records: 1, lastReadAt: again },
      lateOlder: { records: 1, lastReadAt: again },
      closed: { records: 1, lastReadAt: again },
    });
  });

  it("keeps a record whose audience narrowed to nobody, or to another team, between its naming and its add, for the audience held now alone", async () => {
    const { admin, member, other, team, connectionId } = await openToTeam();
    const [toNobody, toOther] = [markerOf(), markerOf()];
    await capturedWith(member, connectionId, toNobody, async () => {
      await chooseAudience(admin.api, connectionId, { kind: "nobody" });
    });
    const whileNobody = {
      member: await finds(member, toNobody),
      other: await finds(other, toNobody),
    };
    // Open to the team again, then narrowed to another team: its member
    // reads both, the first team's nothing.
    await chooseAudience(admin.api, connectionId, {
      kind: "team",
      teamId: team,
    });
    const otherTeam = await newTeam(other);
    await capturedWith(member, connectionId, toOther, async () => {
      await chooseAudience(admin.api, connectionId, {
        kind: "team",
        teamId: otherTeam,
      });
    });
    const events = await captures(connectionId, 2);

    expect({
      events: events.map(({ action }) => action),
      whileNobody,
      member: [await finds(member, toNobody), await finds(member, toOther)],
      other: [await finds(other, toNobody), await finds(other, toOther)],
    }).toStrictEqual({
      events: ["brain.capture.kept", "brain.capture.kept"],
      whileNobody: { member: false, other: false },
      member: [false, false],
      other: [true, true],
    });
  });

  it("leaves nothing readable of a record named before an admin's erase started, whether its add lands before the erasure's step or after it ended", async () => {
    const { admin, member, connectionId } = await openToTeam();
    const [before, after] = [markerOf(), markerOf()];
    // The erase starts between the naming and the add: the add lands, and
    // the erasure's step erases it.
    await capturedWith(member, connectionId, before, async () => {
      await admin.api.connections.eraseBrainReads(connectionId);
    });
    const meanwhile = await finds(member, before);
    await erasuresEnded();
    // Named again under the new generation once an audience is chosen;
    // this time the erase starts and ends before the add, which the
    // ledger refuses.
    const team = await newTeam(member);
    await chooseAudience(admin.api, connectionId, {
      kind: "team",
      teamId: team,
    });
    await capturedWith(member, connectionId, after, async () => {
      await admin.api.connections.eraseBrainReads(connectionId);
      await erasuresEnded();
    });
    const events = await captures(connectionId, 2);
    await chooseAudience(admin.api, connectionId, {
      kind: "team",
      teamId: team,
    });

    expect({
      events: events.map(({ action, detail }) => [
        action,
        detail.reason ?? null,
      ]),
      meanwhile,
      found: [await finds(member, before), await finds(member, after)],
      keys: [
        await keyState(await keyOf(connectionId, before)),
        await keyState(
          `connected:${connectionId}/1/${await sharedReadHashOf("mail.search", {
            input: { query: after },
          })}`
        ),
      ],
    }).toStrictEqual({
      events: [
        ["brain.capture.kept", null],
        ["brain.capture.skipped", "erased"],
      ],
      meanwhile: false,
      found: [false, false],
      keys: ["erased", "erased"],
    });
  });

  it("leaves nothing readable of a record named before its connection was disconnected, and erases it", async () => {
    const { admin, member, connectionId } = await openToTeam();
    const marker = markerOf();
    await capturedWith(member, connectionId, marker, async () => {
      await admin.api.connections.disconnect(connectionId);
    });
    const meanwhile = await finds(member, marker);
    await drainAuditOutboxes(env);
    await erasuresEnded();
    const events = await captures(connectionId, 1);

    expect({
      events: events.map(({ action }) => action),
      meanwhile,
      after: await finds(member, marker),
      key: await keyState(await keyOf(connectionId, marker)),
    }).toStrictEqual({
      events: ["brain.capture.kept"],
      meanwhile: false,
      after: false,
      key: "erased",
    });
  });
});
