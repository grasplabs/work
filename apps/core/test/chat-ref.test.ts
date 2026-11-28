import { actorOf } from "@grasp-os/shared/audit";
import { chatIdSchema } from "@grasp-os/shared/ids";
import type { ChatId, ChatRef, WorkspaceId } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import { revokedSince } from "../src/agent-scope.ts";
import { keepAudience } from "../src/chat-audiences.ts";
import type { chatRequests, decideInChat } from "../src/chat-connections.ts";
import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import type { dependencyRequests, permissions } from "../src/db/core/schema.ts";
import type { chatsWorkedOn } from "../src/drafts.ts";
import { chatWork, turnSubjects } from "../src/drafts.ts";
import type { chatSession } from "../src/durable-objects.ts";
import { workspace } from "../src/durable-objects.ts";
import type { dropHeldStarts } from "../src/held-starts.ts";
import type { chatPackageRequests } from "../src/packages/requests.ts";
import { codeStep, model, personalChatsOf, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection, mailWithSearch } from "./mail-connection.ts";
import { signedInApi } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// A chat's ID is unique only within its person's own Workspace object (a
// page names a new chat's), so whatever core keeps of a chat outside that
// object is keyed by its ref: its workspace and its ID there. The ways it
// can fail come first: a table or index that keys a chat by its ID alone,
// code that takes a bare ID where it reaches shared state, and one
// person's chat under an ID another's has that reads, counts against,
// overwrites, blocks or ends what the other's agent does there.

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

/** A permission of an agent's in chat `chat`, as core keeps one. */
const chatPermission = (
  {
    chat,
    by,
    agentId = chatAgentId,
    connectionId = "mail-1",
    status,
  }: {
    chat: ChatRef;
    by: string;
    agentId?: string;
    connectionId?: string;
    status: "requested" | "active" | "revoked";
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
    chat.workspaceId,
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

/** A checkpoint of `subjectId`'s draft its agent wrote in chat `chat`. */
const checkpoint = (chat: ChatRef, personId: string, subjectId: string) =>
  env.DB.prepare(
    `INSERT INTO draft_checkpoints (subject_kind, subject_id, number, revision, content_hash, person_id, workspace_id, chat_id, turn_id, call_id, created_at)
     VALUES ('app', ?, 1, 1, 'hash', ?, ?, ?, 'turn-1', 'call-1', ?)`
  ).bind(subjectId, personId, chat.workspaceId, chat.chatId, Date.now());

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
  it("is keyed by its workspace and its ID in every table and index of core's that names a person's chat", async () => {
    const { results } = await env.DB.prepare(
      "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE type IN ('table', 'index') AND sql IS NOT NULL"
    ).all<{ type: string; name: string; tableName: string; sql: string }>();
    const naming = results.filter(
      ({ type, tableName, sql }) =>
        type === "table" &&
        !notAPersonsChat.has(tableName) &&
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
    expect({
      tables: naming.map(({ name }) => name).toSorted(),
      withoutWorkspace: naming
        .filter(({ sql }) => !columnsIn(sql).includes("workspace_id"))
        .map(({ name }) => name),
      byIdAlone: byIdAlone.map(({ key }) => key),
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
      // Moves onto the ref in the release after this one: the release
      // before upserts on it (chat-audiences.ts `keepAudience`).
      byIdAlone: ["chat_audiences chat_id"],
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

  it("counts and turns down each person's chat's requests apart under one ID", async () => {
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
    // may, and turned the same request down.
    const anns = await chatUnder(ann, chatId, chats.agent.agentId);
    await env.DB.batch([
      ...Array.from({ length: 5 }, () =>
        chatPermission({
          chat: anns,
          by: ann.userId,
          agentId: chats.agent.agentId,
          connectionId: mail.id,
          status: "requested",
        })
      ),
      chatPermission({
        chat: anns,
        by: ann.userId,
        agentId: chats.agent.agentId,
        connectionId: mail.id,
        status: "revoked",
      }),
    ]);
    await chatUnder(ben, chatId, chats.agent.agentId);
    await chats.stub.ask(chatId, { text: "Find the invoice.", model });
    const [bens, annsWaiting] = await Promise.all([
      ben.api.chats.connectionRequests(chatId),
      ann.api.chats.connectionRequests(chatId),
    ]);
    expect({
      bens: bens.length,
      anns: annsWaiting.length,
    }).toStrictEqual({ bens: 1, anns: 5 });
  });

  it("lets each person's chat under one ID keep its own permission under one binding name and held start under one key", async () => {
    const ann = await person();
    const ben = await person();
    const chatId = crypto.randomUUID();
    const anns = await chatUnder(ann, chatId);
    const bens = await chatUnder(ben, chatId);
    const workflow = await workflowOf(ann.userId);
    // The same agent, binding and start key in each.
    await env.DB.batch([
      chatPermission({ chat: anns, by: ann.userId, status: "active" }, "MAIL"),
      chatPermission({ chat: bens, by: ben.userId, status: "active" }, "MAIL"),
      heldStart(anns, ann.userId, workflow),
      heldStart(bens, ben.userId, workflow),
    ]);
    const [annsHeld, bensHeld] = await Promise.all([
      ann.api.heldStarts.list(),
      ben.api.heldStarts.list(),
    ]);

    expect({
      owners: await env.DB.prepare(
        "SELECT requested_by AS owner FROM permissions WHERE chat_id = ? AND binding = 'MAIL' AND status = 'active'"
      )
        .bind(chatId)
        .all<{ owner: string }>()
        .then(({ results }) => results.map(({ owner }) => owner).toSorted()),
      annsHeld: annsHeld.length,
      bensHeld: bensHeld.length,
    }).toStrictEqual({
      owners: [ann.userId, ben.userId].toSorted(),
      annsHeld: 1,
      bensHeld: 1,
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
      chatPermission({ chat: anns, by: ann.userId, status: "requested" }),
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

describe("a chat's Workspace object", () => {
  it("makes a chat only for its own person, whose object it is", async () => {
    const ann = await person();
    const ben = await person();
    const anns = workspace(env, personalWorkspaceId(ann.userId));
    const by = actorOf({ userId: ben.userId, staff: false });

    expect({
      made: await anns.createChat("Ben's", ben.userId, chatAgentId).then(
        () => "made",
        (error: unknown) => (error instanceof Error ? error.message : "")
      ),
      started: await anns
        .startChat(crypto.randomUUID(), ben.userId, {
          key: crypto.randomUUID(),
          title: "Ben's",
          agentId: chatAgentId,
          by,
        })
        .then(
          () => "made",
          (error: unknown) => (error instanceof Error ? error.message : "")
        ),
      annsChats: await ann.api.chats.list(),
    }).toStrictEqual({
      made: "There's no such chat.",
      started: "There's no such chat.",
      annsChats: [],
    });
  });
});
