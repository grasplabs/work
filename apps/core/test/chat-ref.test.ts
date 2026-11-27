import { actorOf } from "@grasp-os/shared/audit";
import { chatIdSchema } from "@grasp-os/shared/ids";
import type { ChatId, ChatRef, WorkspaceId } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { z } from "zod";

import { revokedSince } from "../src/agent-scope.ts";
import { appKind } from "../src/apps.ts";
import { audienceOf, keepAudience } from "../src/chat-audiences.ts";
import type { chatRequests, decideInChat } from "../src/chat-connections.ts";
import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import type { dependencyRequests, permissions } from "../src/db/core/schema.ts";
import type { chatsWorkedOn } from "../src/drafts.ts";
import { chatWork, keepMadeInChat, turnSubjects } from "../src/drafts.ts";
import type { chatSession } from "../src/durable-objects.ts";
import { workspace } from "../src/durable-objects.ts";
import type { dropHeldStarts } from "../src/held-starts.ts";
import type { chatPackageRequests } from "../src/packages/requests.ts";
import { codeStep, model, personalChatsOf, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection, mailWithSearch } from "./mail-connection.ts";
import { signedInApi } from "./sign-in.ts";
import { connectDb, testBinding } from "./test-env.ts";

// A chat's ID is unique only within its person's own Workspace object (a
// page names a new chat's), so whatever core keeps of a chat outside that
// object is keyed by its ref: its workspace and its ID there. The ways it
// can fail come first: a table or index that keys a chat by its ID alone,
// code that takes a bare ID where it reaches shared state, and one
// person's chat under an ID another's has that reads, counts against,
// overwrites, blocks or ends what the other's agent does there.
//
// This release expands the schema and the release before still runs on
// it while this one rolls out, and after a rollback: the keys by a chat's
// ID alone stay beside the new ones, and what the release before writes
// (with no workspace where it never kept one) this release still finds,
// as its own person's, never anyone else's. The contract migration drops
// all of that, a release later.

const idp = mockIdp();

/** A member signed in on a connection of their own. */
const person = async () => await signedInApi(idp, "user");
type Person = Awaited<ReturnType<typeof person>>;

/**
 * Tables that hold a `chat_id` that isn't a person's chat: a guest chat's
 * (`guest_chats`, its own table's ID), and the undo points no release
 * writes or reads any more (`app_draft_points`, now `draft_checkpoints`).
 */
const notAPersonsChat = new Set(["guest_messages", "app_draft_points"]);

/**
 * What the release before still writes and keys on, which this release
 * neither reads nor writes: the chat a Stephen request was answered in.
 * The contract migration drops it.
 */
const unusedUntilTheContract = new Set(["stephen_requests"]);

/**
 * The keys by a chat's ID alone the release before upserts and conflicts
 * on, each beside its twin by the chat's ref until the contract.
 */
const keptForTheReleaseBefore = [
  "agent_held_starts_key",
  "chat_audiences chat_id",
  "chat_workflow_offers_chat_idx",
  "draft_checkpoints_chat",
  "permissions_live_chat_binding_idx",
];

/** The columns `create`, a table's or an index's SQL, lists, in order. */
const columnsIn = (create: string): string[] =>
  [...create.matchAll(/[`"](?<name>\w+)[`"]/gu)].map(
    ({ groups }) => groups?.name ?? ""
  );

/** `person`'s chat under ID `chatId`, as a page starts one. */
const chatUnder = async (
  someone: Person,
  chatId: string,
  agentId = chatAgentId
): Promise<ChatRef> => {
  await workspace(env, personalWorkspaceId(someone.userId)).startChat(
    chatId,
    someone.userId,
    {
      key: crypto.randomUUID(),
      title: "Under one ID",
      agentId,
      by: actorOf({ userId: someone.userId, staff: false }),
    }
  );
  return {
    workspaceId: personalWorkspaceId(someone.userId),
    chatId: chatIdSchema.parse(chatId),
  };
};

/**
 * A permission of an agent's in chat `chat`, as this release keeps one;
 * `asBefore`, as the release before does, with the chat's ID alone.
 */
const chatPermission = (
  {
    chat,
    by,
    agentId = chatAgentId,
    connectionId = "mail-1",
    status,
    asBefore = false,
  }: {
    chat: ChatRef;
    by: string;
    agentId?: string;
    connectionId?: string;
    status: "requested" | "active" | "revoked";
    asBefore?: boolean;
  },
  binding = `MAIL_${crypto.randomUUID().slice(0, 6)}`
) =>
  env.DB.prepare(
    `INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id, actions, binding, status, requested_by, requested_at, granted_at, revoked_at, workspace_id, chat_id, personal)
     VALUES (?, 'agent', ?, 'connection', ?, '["mail.search"]', ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  ).bind(
    crypto.randomUUID(),
    agentId,
    connectionId,
    binding,
    status,
    by,
    Date.now(),
    Date.now(),
    status === "revoked" ? Date.now() : null,
    asBefore ? null : chat.workspaceId,
    chat.chatId
  );

/** A held start of the chat's agent in chat `chat`, under key `key`. */
const heldStart = (
  chat: ChatRef,
  personId: string,
  workflow: string,
  key = "start-1"
) =>
  env.DB.prepare(
    `INSERT INTO agent_held_starts (id, workspace_id, chat_id, agent_id, person_id, workflow_resource_id, input, input_hash, key, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', 'hash', ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    chat.workspaceId,
    chat.chatId,
    chatAgentId,
    personId,
    workflow,
    key,
    Date.now(),
    Date.now() + 86_400_000
  );

/**
 * A checkpoint of `subjectId`'s draft its agent wrote in chat `chat`;
 * `asBefore`, as the release before keeps one, with the chat's ID alone.
 */
const checkpoint = (
  chat: ChatRef,
  personId: string,
  subjectId: string,
  asBefore = false
) =>
  env.DB.prepare(
    `INSERT INTO draft_checkpoints (subject_kind, subject_id, number, revision, content_hash, person_id, workspace_id, chat_id, turn_id, call_id, created_at)
     VALUES ('app', ?, 1, 1, 'hash', ?, ?, ?, 'turn-1', 'call-1', ?)`
  ).bind(
    subjectId,
    personId,
    asBefore ? null : chat.workspaceId,
    chat.chatId,
    Date.now()
  );

/** What chat `chat` worked on, by subject ID (`chatWork`). */
const workOf = async (chat: ChatRef): Promise<string[]> => {
  const work = await chatWork(env, chat);
  return work.map(({ id }) => id);
};

/** A workflow resource of `ownerId`'s, for a held start to name. */
const workflowOf = async (ownerId: string): Promise<string> => {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO workflow_resources (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(id, `held-${id.slice(0, 6)}`, ownerId, Date.now())
    .run();
  return id;
};

/** The statuses of chat `chat`'s permissions, however they were written. */
const statusesIn = async (chatId: ChatId, by: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    "SELECT status FROM permissions WHERE chat_id = ? AND requested_by = ? ORDER BY status"
  )
    .bind(chatId, by)
    .all<{ status: string }>();
  return results.map(({ status }) => status);
};

describe("a chat outside its Workspace object", () => {
  it("is keyed by its workspace and its ID in every table and index of core's that names a person's chat, beside the keys the release before still uses", async () => {
    const { results } = await env.DB.prepare(
      "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE type IN ('table', 'index') AND sql IS NOT NULL"
    ).all<{ type: string; name: string; tableName: string; sql: string }>();
    const naming = results.filter(
      ({ type, tableName, sql }) =>
        type === "table" &&
        !notAPersonsChat.has(tableName) &&
        !unusedUntilTheContract.has(tableName) &&
        columnsIn(sql).includes("chat_id")
    );
    // Each key that holds the chat: its primary key, and its indexes.
    const keys = [
      ...naming.flatMap(({ name, sql }) => {
        const primary = /PRIMARY KEY\s*\((?<columns>[^)]*)\)/u.exec(sql)?.groups
          ?.columns;
        return [
          ...(primary === undefined
            ? []
            : [
                {
                  table: name,
                  key: `${name} primary key`,
                  unique: true,
                  columns: columnsIn(primary),
                },
              ]),
          // The chat's ID its whole key, on its column itself.
          ...(/[`"]chat_id[`"][^,]*(?:PRIMARY KEY|UNIQUE)/u.test(sql)
            ? [
                {
                  table: name,
                  key: `${name} chat_id`,
                  unique: true,
                  columns: ["chat_id"],
                },
              ]
            : []),
        ];
      }),
      ...results
        .filter(
          ({ type, tableName }) =>
            type === "index" && naming.some(({ name }) => name === tableName)
        )
        .map(({ name, tableName, sql }) => ({
          table: tableName,
          key: name,
          unique: sql.startsWith("CREATE UNIQUE"),
          columns: columnsIn(sql.slice(sql.indexOf("("), sql.indexOf(")"))),
        })),
    ].filter(({ columns }) => columns.includes("chat_id"));
    const byIdAlone = keys.filter(
      ({ columns }) =>
        columns[columns.indexOf("chat_id") - 1] !== "workspace_id"
    );
    // Each of them has its twin by the chat's ref, as unique as it is.
    const withoutTwin = byIdAlone.filter(({ table, unique, columns }) => {
      const at = columns.indexOf("chat_id");
      const twin = [
        ...columns.slice(0, at),
        "workspace_id",
        ...columns.slice(at),
      ].join(",");
      return !keys.some(
        (other) =>
          other.table === table &&
          other.columns.join(",") === twin &&
          (other.unique || !unique)
      );
    });

    expect({
      tables: naming.map(({ name }) => name).toSorted(),
      withoutWorkspace: naming
        .filter(({ sql }) => !columnsIn(sql).includes("workspace_id"))
        .map(({ name }) => name),
      byIdAlone: byIdAlone.map(({ key }) => key).toSorted(),
      withoutTwin: withoutTwin.map(({ key }) => key),
    }).toStrictEqual({
      tables: [
        "agent_held_starts",
        "agent_wakes",
        "chat_audiences",
        "chat_turns",
        "chat_workflow_offers",
        "draft_checkpoints",
        "permissions",
        "run_chat_sources",
      ],
      withoutWorkspace: [],
      byIdAlone: keptForTheReleaseBefore,
      withoutTwin: [],
    });
    // A chat kept in JSON keeps both halves of its ref, and every read of
    // one matches both (`chatPackageRequests`): an agent's request names
    // its chat by `AgentProposer`. Connect's held actions keep a chat's
    // `WorkContext`, whose chat form is `chatRefSchema`'s by its schema.
    interface Halves {
      workspaceId: string;
      chatId: string;
    }
    expectTypeOf<
      NonNullable<(typeof permissions.$inferSelect)["requestedVia"]>
    >().toExtend<Halves>();
    expectTypeOf<
      NonNullable<(typeof dependencyRequests.$inferSelect)["requestedVia"]>
    >().toExtend<Halves>();
    expectTypeOf<
      NonNullable<
        (typeof dependencyRequests.$inferSelect)["requestedIn"]
      >[number]
    >().toExtend<Halves>();
  });

  it("is taken by its ref alone where code reaches what is kept of it outside its object, never by a bare ID or the halves the release before passed", () => {
    // What each took before, by the chat's ID or by unbranded strings, is
    // refused now: each line fails against those signatures.
    interface Halves {
      workspaceId: string;
      chatId: string;
    }
    expectTypeOf<ChatId>().not.toExtend<ChatRef>();
    expectTypeOf<Halves>().not.toExtend<ChatRef>();
    expectTypeOf<string>().not.toExtend<Parameters<typeof chatWork>[1]>();
    expectTypeOf<string>().not.toExtend<Parameters<typeof turnSubjects>[1]>();
    expectTypeOf<ChatId>().not.toExtend<Parameters<typeof chatRequests>[2]>();
    expectTypeOf<ChatId>().not.toExtend<Parameters<typeof decideInChat>[2]>();
    expectTypeOf<Halves>().not.toExtend<Parameters<typeof keepAudience>[1]>();
    expectTypeOf<string>().not.toExtend<
      Parameters<typeof chatPackageRequests>[1]
    >();
    expectTypeOf<WorkspaceId>().not.toExtend<
      Parameters<typeof chatSession>[1]
    >();
    expectTypeOf<Halves>().not.toExtend<Parameters<typeof dropHeldStarts>[1]>();
    expectTypeOf<{
      agentId: string;
      chatId: ChatId;
      personId: string;
    }>().not.toExtend<Parameters<typeof revokedSince>[1]>();
    expectTypeOf<string>().not.toExtend<Parameters<typeof chatsWorkedOn>[2]>();
  });

  it("keeps each person's chat's work, a turn's subjects and the revocations that end its runs apart under one ID", async () => {
    const ann = await person();
    const ben = await person();
    const chatId = crypto.randomUUID();
    const anns = await chatUnder(ann, chatId);
    const bens = await chatUnder(ben, chatId);
    const since = Date.now() - 1000;
    const annsApp = `anns-${crypto.randomUUID()}`;
    const bensApp = `bens-${crypto.randomUUID()}`;
    await env.DB.batch([
      checkpoint(anns, ann.userId, annsApp),
      checkpoint(bens, ben.userId, bensApp),
      chatPermission({ chat: anns, by: ann.userId, status: "revoked" }),
    ]);

    expect({
      annsWork: await workOf(anns),
      bensWork: await workOf(bens),
      annsTurn: await turnSubjects(env, anns, "turn-1"),
      bensTurn: await turnSubjects(env, bens, "turn-1"),
      annsRunsEnd: await revokedSince(
        env,
        { agentId: chatAgentId, ...anns },
        since
      ),
      bensRunsEnd: await revokedSince(
        env,
        { agentId: chatAgentId, ...bens },
        since
      ),
    }).toStrictEqual({
      annsWork: [annsApp],
      bensWork: [bensApp],
      annsTurn: [{ kind: "app", id: annsApp }],
      bensTurn: [{ kind: "app", id: bensApp }],
      annsRunsEnd: true,
      bensRunsEnd: false,
    });
  });

  it("counts and turns down each person's chat's requests apart under one ID, and keeps a request where the release before reads it", async () => {
    const ann = await person();
    const ben = await person();
    const mail = await mailConnection([], mailWithSearch);
    await connectDb()
      .prepare(
        "UPDATE connections SET scope = 'personal', owner_user_id = ? WHERE id = ?"
      )
      .bind(ben.userId, mail.id)
      .run();
    const chatId = crypto.randomUUID();
    const chats = await personalChatsOf(
      ben.userId,
      codeStep(
        `export default async (self, env) => await env.connections.request({ connectionId: ${JSON.stringify(mail.id)}, actions: ["mail.search"], binding: "MAIL", reason: "To find it." }).then(({ binding }) => binding, (error) => error.message);`
      ),
      says("Asked.")
    );
    // Ann's chat under the ID holds as many waiting requests as a chat
    // may, and turned the same request down: some as this release keeps
    // them, some as the release before did.
    const anns = await chatUnder(ann, chatId, chats.agent.agentId);
    await env.DB.batch([
      ...Array.from({ length: 5 }, (_, at) =>
        chatPermission({
          chat: anns,
          by: ann.userId,
          agentId: chats.agent.agentId,
          connectionId: mail.id,
          status: "requested",
          asBefore: at % 2 === 0,
        })
      ),
      chatPermission({
        chat: anns,
        by: ann.userId,
        agentId: chats.agent.agentId,
        connectionId: mail.id,
        status: "revoked",
        asBefore: true,
      }),
    ]);
    await chatUnder(ben, chatId, chats.agent.agentId);
    await chats.stub.ask(chatId, { text: "Find the invoice.", model });
    const [bens, annsWaiting] = await Promise.all([
      ben.api.chats.connectionRequests(chatId),
      ann.api.chats.connectionRequests(chatId),
    ]);
    // The release before lists a chat's waiting requests by its ID and
    // person (chat-connections.ts on main).
    const { results: bensAsBefore } = await env.DB.prepare(
      "SELECT id FROM permissions WHERE chat_id = ? AND status = 'requested' AND requested_by = ?"
    )
      .bind(chatId, ben.userId)
      .all<{ id: string }>();

    expect({
      bens: bens.length,
      anns: annsWaiting.length,
      bensAsBefore: bensAsBefore.map(({ id }) => id),
    }).toStrictEqual({
      bens: 1,
      anns: 5,
      bensAsBefore: bens.map(({ id }) => id),
    });
  });

  it("never lets one person's chat under an ID read or overwrite another's audience, permissions or held starts", async () => {
    const ann = await person();
    const ben = await person();
    const chatId = crypto.randomUUID();
    const anns = await chatUnder(ann, chatId);
    const bens = await chatUnder(ben, chatId);
    const workflow = await workflowOf(ann.userId);
    await env.DB.batch([
      chatPermission({ chat: anns, by: ann.userId, status: "active" }, "ANNS"),
      chatPermission({ chat: bens, by: ben.userId, status: "active" }, "BENS"),
      heldStart(anns, ann.userId, workflow, "anns"),
      heldStart(bens, ben.userId, workflow, "bens"),
    ]);
    await keepAudience(env, anns, ann.userId, {
      members: ["ann-colleague"],
      outsiders: false,
    });
    // Until the contract the audience's key is the chat's ID alone, as
    // the release before upserts on it: Ben's chat keeps none rather than
    // take Ann's, and his agent reads nothing at all.
    await keepAudience(env, bens, ben.userId, {
      members: [],
      outsiders: true,
    });
    const [annsHeld, bensHeld] = await Promise.all([
      ann.api.heldStarts.list(),
      ben.api.heldStarts.list(),
    ]);

    expect({
      annsHeld: annsHeld.map(({ chatId: chat }) => chat),
      bensHeld: bensHeld.map(({ chatId: chat }) => chat),
      annsBindings: await env.DB.prepare(
        "SELECT binding FROM permissions WHERE workspace_id = ? AND chat_id = ?"
      )
        .bind(anns.workspaceId, anns.chatId)
        .all<{ binding: string }>()
        .then(({ results }) => results.map(({ binding }) => binding)),
      annsAudience: await audienceOf(env, { type: "chat", ...anns }),
      bensAudience: await audienceOf(env, { type: "chat", ...bens }),
    }).toStrictEqual({
      annsHeld: [chatId],
      bensHeld: [chatId],
      annsBindings: ["ANNS"],
      annsAudience: {
        members: [ann.userId, "ann-colleague"],
        outsiders: false,
      },
      bensAudience: undefined,
    });
  });

  it("leaves everything of another person's chat under the same ID as it was when one is started and deleted, and both chats work", async () => {
    const ann = await person();
    const ben = await person();
    const chatId = crypto.randomUUID();
    const anns = await chatUnder(ann, chatId);
    const workflow = await workflowOf(ann.userId);
    const annsApp = `anns-${crypto.randomUUID()}`;
    await env.DB.batch([
      chatPermission({ chat: anns, by: ann.userId, status: "active" }),
      // As the release before keeps one: Ann's all the same.
      chatPermission({
        chat: anns,
        by: ann.userId,
        status: "requested",
        asBefore: true,
      }),
      heldStart(anns, ann.userId, workflow),
      checkpoint(anns, ann.userId, annsApp),
    ]);
    await keepAudience(env, anns, ann.userId, {
      members: ["ann-colleague"],
      outsiders: false,
    });
    const annsRows = async () => {
      const [held, audience] = await Promise.all([
        env.DB.prepare(
          "SELECT key FROM agent_held_starts WHERE workspace_id = ? AND chat_id = ?"
        )
          .bind(anns.workspaceId, anns.chatId)
          .all<{ key: string }>(),
        env.DB.prepare(
          "SELECT members FROM chat_audiences WHERE workspace_id = ? AND chat_id = ?"
        )
          .bind(anns.workspaceId, anns.chatId)
          .all<{ members: string }>(),
      ]);
      return {
        granted: await statusesIn(anns.chatId, ann.userId),
        held: held.results,
        audience: audience.results,
        work: await workOf(anns),
      };
    };
    const before = await annsRows();
    // Ben starts a chat of his own under that ID, then deletes it.
    await ben.api.chats.attachFile(
      chatId,
      { name: "b.txt", bytes: new TextEncoder().encode("B") },
      crypto.randomUUID(),
      { key: crypto.randomUUID(), title: "Ben's under the same ID" }
    );
    const bensBefore = await ben.api.chats.summary(chatId);
    await ben.api.chats.remove(chatId);

    expect({
      before,
      after: await annsRows(),
      annsChat: await ann.api.chats.summary(chatId).then(({ title }) => title),
      annsRequests: await ann.api.chats
        .connectionRequests(chatId)
        .then((requests) => requests.length),
      bensBefore: bensBefore.title,
      bensAfter: await ben.api.chats.summary(chatId).then(
        () => "there",
        () => "gone"
      ),
    }).toStrictEqual({
      before: {
        granted: ["active", "requested"],
        held: [{ key: "start-1" }],
        audience: [{ members: JSON.stringify([ann.userId, "ann-colleague"]) }],
        work: [annsApp],
      },
      after: {
        granted: ["active", "requested"],
        held: [{ key: "start-1" }],
        audience: [{ members: JSON.stringify([ann.userId, "ann-colleague"]) }],
        work: [annsApp],
      },
      annsChat: "Under one ID",
      annsRequests: 1,
      bensBefore: "Ben's under the same ID",
      bensAfter: "gone",
    });
  });
});

describe("a chat across the release before", () => {
  it("takes every write the release before makes on this schema", async () => {
    const ann = await person();
    const chatId = crypto.randomUUID();
    const workspaceId = personalWorkspaceId(ann.userId);
    const now = Date.now();
    const wake = `wake-${crypto.randomUUID()}`;
    const request = `teams:${crypto.randomUUID()}`;
    const workflow = await workflowOf(ann.userId);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO agent_wakes (id, agent_id, cron, time_zone, person_id, opening, state, next_at, retry_at, chat_id, last_at, last_outcome, made_by, made_at, changed_by, changed_at) VALUES (?, ?, '0 9 * * *', 'UTC', ?, 'Hi', 'on', NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)"
      ).bind(wake, chatAgentId, ann.userId, ann.userId, now, ann.userId, now),
      env.DB.prepare(
        "INSERT INTO stephen_requests (id, day, place, person_id, kind, outcome, tools, missing) VALUES (?, '2026-11-27', 'teams', ?, 'answered', 'stopped', '[]', '[]')"
      ).bind(request, ann.userId),
    ]);
    // Each statement as origin/main's code makes it, by its own columns.
    const statements = {
      // chat-ids.ts `takeChatId`: every new chat, from a page, a chat app
      // or a wake-up.
      takeChatId: env.DB.prepare(
        "INSERT INTO chat_ids (id, person_id, request_key, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET id = id RETURNING person_id AS personId, request_key AS key"
      ).bind(chatId, ann.userId, crypto.randomUUID(), now),
      // chat-audiences.ts `keepAudience`, made and then kept again.
      keepAudience: env.DB.prepare(
        "INSERT INTO chat_audiences (chat_id, workspace_id, members, outsiders, updated_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT (chat_id) DO UPDATE SET members = excluded.members, outsiders = excluded.outsiders, updated_at = excluded.updated_at"
      ).bind(chatId, workspaceId, JSON.stringify([ann.userId]), now),
      keepAudienceAgain: env.DB.prepare(
        "INSERT INTO chat_audiences (chat_id, workspace_id, members, outsiders, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT (chat_id) DO UPDATE SET members = excluded.members, outsiders = excluded.outsiders, updated_at = excluded.updated_at"
      ).bind(chatId, workspaceId, JSON.stringify([ann.userId, "guest"]), now),
      // chat-connections.ts `askInChat`: every column it had, no workspace.
      askInChat: env.DB.prepare(
        `INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id, resource, actions, binding, status, requested_by, requested_at, granted_by, granted_at, revoked_by, revoked_at, requested_via, chat_id, reason, personal, teams)
         SELECT ?, 'agent', ?, 'connection', 'mail-1', NULL, '["mail.search"]', 'MAIL', 'requested', ?, ?, NULL, NULL, NULL, NULL, ?, ?, 'To find it.', 1, NULL WHERE 1`
      ).bind(
        crypto.randomUUID(),
        chatAgentId,
        ann.userId,
        now,
        JSON.stringify({
          type: "agent",
          agentId: chatAgentId,
          onBehalfOf: ann.userId,
          workspaceId,
          chatId,
        }),
        chatId
      ),
      // drafts.ts `keepCheckpoint`, a chat's agent's write.
      keepCheckpoint: env.DB.prepare(
        `INSERT INTO draft_checkpoints (subject_kind, subject_id, number, revision, base, definition, content_hash, person_id, chat_id, turn_id, call_id, restored_from, created_at)
         VALUES ('app', ?, 1, 1, NULL, NULL, 'hash', ?, ?, 'turn-1', 'call-1', NULL, ?)`
      ).bind(`app-${crypto.randomUUID()}`, ann.userId, chatId, now),
      // agent-wakes.ts `startTurn`, the wake-up's first chat.
      wakeChat: env.DB.prepare(
        "UPDATE agent_wakes SET chat_id = ? WHERE id = ?"
      ).bind(chatId, wake),
      // turn-records.ts `recordTurn`.
      recordTurn: env.DB.prepare(
        `INSERT INTO chat_turns (id, chat_id, surface, model, effort, sent_at, first_request_ms, first_token_ms, first_text_ms, done_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, tools, retries, fallbacks, rate_limit_waits, rate_limit_wait_ms, stop_reason, outcome, code, compacted, queued, resumed)
         VALUES (?, ?, 'web', 'openai/gpt-5', NULL, ?, 1, 2, 3, 4, 0, 0, 0, 0, 0, '{}', 0, 0, 0, 0, 'stop', 'answered', NULL, 0, 0, 0) ON CONFLICT DO NOTHING`
      ).bind(crypto.randomUUID(), chatId, now),
      // channels/stephen-requests.ts `settleRequest`.
      settleRequest: env.DB.prepare(
        "UPDATE stephen_requests SET chat_id = ?, kind = 'answered', outcome = 'done' WHERE id = ?"
      ).bind(chatId, request),
      // held-starts.ts `holdStart`.
      holdStart: env.DB.prepare(
        `INSERT INTO agent_held_starts (id, workspace_id, chat_id, agent_id, person_id, workflow_resource_id, input, input_hash, key, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, '{}', 'hash', 'start-1', ?, ?) ON CONFLICT DO NOTHING`
      ).bind(
        crypto.randomUUID(),
        workspaceId,
        chatId,
        chatAgentId,
        ann.userId,
        workflow,
        now,
        now + 86_400_000
      ),
    };
    const outcomes: Record<string, string> = {};
    for (const [name, statement] of Object.entries(statements)) {
      // oxlint-disable-next-line no-await-in-loop -- in the order a chat's life writes them
      outcomes[name] = await statement
        .run()
        .then(({ meta }) => (meta.changes > 0 ? "written" : "nothing"), String);
    }

    expect(outcomes).toStrictEqual({
      takeChatId: "written",
      keepAudience: "written",
      keepAudienceAgain: "written",
      askInChat: "written",
      keepCheckpoint: "written",
      wakeChat: "written",
      recordTurn: "written",
      settleRequest: "written",
      holdStart: "written",
    });
  });

  it("finds what the release before wrote as its own person's, never another's, and goes with the chat", async () => {
    const ann = await person();
    const ben = await person();
    const chatId = crypto.randomUUID();
    const anns = await chatUnder(ann, chatId);
    const bens = await chatUnder(ben, chatId);
    const annsApp = `anns-${crypto.randomUUID()}`;
    await env.DB.batch([
      chatPermission({
        chat: anns,
        by: ann.userId,
        status: "requested",
        asBefore: true,
      }),
      checkpoint(anns, ann.userId, annsApp, true),
    ]);
    const [annsRequests, bensRequests] = await Promise.all([
      ann.api.chats.connectionRequests(chatId),
      ben.api.chats.connectionRequests(chatId),
    ]);
    const found = {
      annsRequests: annsRequests.length,
      bensRequests: bensRequests.length,
      annsWork: await workOf(anns),
      bensWork: await workOf(bens),
    };
    await ann.api.chats.remove(chatId);

    expect({
      found,
      afterDelete: await statusesIn(anns.chatId, ann.userId),
    }).toStrictEqual({
      found: {
        annsRequests: 1,
        bensRequests: 0,
        annsWork: [annsApp],
        bensWork: [],
      },
      afterDelete: ["revoked"],
    });
  });

  it("writes where the release before reads: an audience by its chat's ID, a chat's work by its person", async () => {
    const ann = await signedInApi(idp, "builder");
    const chatId = crypto.randomUUID();
    const anns = await chatUnder(ann, chatId);
    await keepAudience(env, anns, ann.userId, {
      members: ["ann-colleague"],
      outsiders: false,
    });
    const app = await ann.api.apps.create({ name: `Desk ${chatId}` });
    await keepMadeInChat(env, appKind, app.id, ann.userId, {
      ...anns,
      turnId: null,
      callId: null,
    });
    // As origin/main's chat-audiences.ts `audienceOf` and drafts.ts
    // `chatWork` read them.
    const audience = await env.DB.prepare(
      "SELECT workspace_id AS workspaceId, outsiders FROM chat_audiences WHERE chat_id = ? LIMIT 1"
    )
      .bind(chatId)
      .first<{ workspaceId: string; outsiders: number }>();
    const { results: work } = await env.DB.prepare(
      `SELECT subject_id AS id FROM draft_checkpoints
       WHERE person_id = ? AND chat_id = ?
         AND number = (SELECT MAX(number) FROM draft_checkpoints AS own WHERE own.subject_kind = draft_checkpoints.subject_kind AND own.subject_id = draft_checkpoints.subject_id AND own.chat_id = ? AND own.person_id = ?)`
    )
      .bind(ann.userId, chatId, chatId, ann.userId)
      .all<{ id: string }>();

    expect({ audience, work: work.map(({ id }) => id) }).toStrictEqual({
      audience: { workspaceId: anns.workspaceId, outsiders: 0 },
      work: [app.id],
    });
  });

  it("gives each row the release before wrote its workspace as the migration fills it, from the person it names", async () => {
    const ann = await person();
    const chatId = chatIdSchema.parse(crypto.randomUUID());
    const ref = { workspaceId: personalWorkspaceId(ann.userId), chatId };
    const elsewhere = {
      workspaceId: personalWorkspaceId(`elsewhere-${crypto.randomUUID()}`),
      chatId,
    };
    const now = Date.now();
    const wake = `wake-${crypto.randomUUID()}`;
    const app = `app-${crypto.randomUUID()}`;
    await env.DB.batch([
      chatPermission({
        chat: ref,
        by: ann.userId,
        status: "active",
        asBefore: true,
      }),
      // Kept by this release: left as it is.
      chatPermission({ chat: elsewhere, by: ann.userId, status: "requested" }),
      env.DB.prepare(
        "INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id, actions, binding, status, requested_by, requested_at) VALUES (?, 'agent', ?, 'connection', 'mail-1', '[]', ?, 'active', ?, ?)"
      ).bind(
        crypto.randomUUID(),
        chatAgentId,
        `ANYWHERE_${crypto.randomUUID().slice(0, 6)}`,
        ann.userId,
        now
      ),
      checkpoint(ref, ann.userId, app, true),
      env.DB.prepare(
        "INSERT INTO draft_checkpoints (subject_kind, subject_id, number, revision, content_hash, person_id, created_at) VALUES ('app', ?, 2, 2, 'hash', ?, ?)"
      ).bind(app, ann.userId, now),
      env.DB.prepare(
        "INSERT INTO agent_wakes (id, agent_id, cron, time_zone, person_id, opening, state, chat_id, made_by, made_at, changed_by, changed_at) VALUES (?, ?, '0 9 * * *', 'UTC', ?, 'Hi', 'on', ?, ?, ?, ?, ?)"
      ).bind(
        wake,
        chatAgentId,
        ann.userId,
        chatId,
        ann.userId,
        now,
        ann.userId,
        now
      ),
    ]);
    const fills = z
      .array(z.object({ name: z.string(), queries: z.array(z.string()) }))
      .parse(testBinding("CORE_MIGRATIONS"))
      .find(({ name }) => name.includes("_chats_by_ref"))
      ?.queries.filter((query) => /^UPDATE\b/mu.test(query));
    if (fills === undefined || fills.length === 0) {
      throw new Error("The migration fills nothing");
    }
    await env.DB.batch(fills.map((query) => env.DB.prepare(query)));
    /** Each row's chat as `workspace/chat`, in one order. */
    const workspaces = async (sql: string) =>
      await env.DB.prepare(sql)
        .bind(ann.userId)
        .all<{ workspaceId: string | null; chatId: string | null }>()
        .then(({ results }) =>
          results
            .map(({ workspaceId, chatId: id }) => `${workspaceId}/${id}`)
            .toSorted()
        );

    expect({
      permissions: await workspaces(
        "SELECT workspace_id AS workspaceId, chat_id AS chatId FROM permissions WHERE requested_by = ?"
      ),
      checkpoints: await workspaces(
        "SELECT workspace_id AS workspaceId, chat_id AS chatId FROM draft_checkpoints WHERE person_id = ?"
      ),
      wakes: await workspaces(
        "SELECT workspace_id AS workspaceId, chat_id AS chatId FROM agent_wakes WHERE person_id = ?"
      ),
    }).toStrictEqual({
      permissions: [
        `${elsewhere.workspaceId}/${chatId}`,
        `${ref.workspaceId}/${chatId}`,
        "null/null",
      ].toSorted(),
      checkpoints: [`${ref.workspaceId}/${chatId}`, "null/null"].toSorted(),
      wakes: [`${ref.workspaceId}/${chatId}`],
    });
  });
});
