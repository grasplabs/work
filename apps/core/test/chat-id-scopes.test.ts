import { actorOf } from "@grasp-os/shared/audit";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { revokedSince } from "../src/agent-scope.ts";
import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import { chatWork, turnSubjects } from "../src/drafts.ts";
import { workspace } from "../src/durable-objects.ts";
import { codeStep, model, personalChatsOf, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection, mailWithSearch } from "./mail-connection.ts";
import { signedInApi } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// What core keeps of a chat outside its person's object is the chat's
// person's, never its ID's alone: a page names a chat's ID (#2836), and a
// chat from before IDs were taken company-wide has none taken, so another
// person can make a chat of their own under it. The ways it can fail come
// first: one person's chat under the ID reads, counts against, blocks or
// ends what the other's agent does there.

const idp = mockIdp();

/** A member signed in on a connection of their own. */
const person = async () => await signedInApi(idp, "user");
type Person = Awaited<ReturnType<typeof person>>;

/**
 * A chat of `someone`'s under ID `chatId`, with agent `agentId`, its ID
 * left untaken company-wide, as a chat from before IDs were taken is.
 */
const chatUnder = async (
  someone: Person,
  chatId: string,
  agentId = chatAgentId
) => {
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
  await env.DB.prepare("DELETE FROM chat_ids WHERE id = ?").bind(chatId).run();
};

/** A permission of an agent's in a chat, as core keeps one. */
const chatPermission = (
  {
    chatId,
    by,
    agentId = chatAgentId,
    connectionId = "mail-1",
    status,
  }: {
    chatId: string;
    by: string;
    agentId?: string;
    connectionId?: string;
    status: "requested" | "active" | "revoked";
  },
  binding = `MAIL_${crypto.randomUUID().slice(0, 6)}`
) =>
  env.DB.prepare(
    `INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id, actions, binding, status, requested_by, requested_at, granted_at, revoked_at, chat_id, personal)
     VALUES (?, 'agent', ?, 'connection', ?, '["mail.search"]', ?, ?, ?, ?, ?, ?, ?, 1)`
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
    chatId
  );

describe("what core keeps of a chat outside its object", () => {
  it("is read by the chat's person: its work, a turn's subjects, and the revocations that end its runs", async () => {
    const ann = await person();
    const ben = await person();
    const chatId = chatIdSchema.parse(crypto.randomUUID());
    const since = Date.now() - 1000;
    const workOf = async (personId: string) => {
      const work = await chatWork(env, personId, chatId);
      return work.map(({ id }) => id);
    };
    const checkpoint = (personId: string, subjectId: string) =>
      env.DB.prepare(
        `INSERT INTO draft_checkpoints (subject_kind, subject_id, number, revision, content_hash, person_id, chat_id, turn_id, call_id, created_at)
         VALUES ('app', ?, 1, 1, 'hash', ?, ?, 'turn-1', 'call-1', ?)`
      ).bind(subjectId, personId, chatId, Date.now());
    await env.DB.batch([
      checkpoint(ann.userId, "anns-app"),
      checkpoint(ben.userId, "bens-app"),
      chatPermission({ chatId, by: ann.userId, status: "revoked" }),
    ]);

    expect({
      annsWork: await workOf(ann.userId),
      bensWork: await workOf(ben.userId),
      annsTurn: await turnSubjects(env, ann.userId, chatId, "turn-1"),
      bensTurn: await turnSubjects(env, ben.userId, chatId, "turn-1"),
      annsRunsEnd: await revokedSince(
        env,
        { agentId: chatAgentId, chatId, personId: ann.userId },
        since
      ),
      bensRunsEnd: await revokedSince(
        env,
        { agentId: chatAgentId, chatId, personId: ben.userId },
        since
      ),
    }).toStrictEqual({
      annsWork: ["anns-app"],
      bensWork: ["bens-app"],
      annsTurn: [{ kind: "app", id: "anns-app" }],
      bensTurn: [{ kind: "app", id: "bens-app" }],
      annsRunsEnd: true,
      bensRunsEnd: false,
    });
  });

  it("counts and turns down a chat's requests for its person alone", async () => {
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
    await chatUnder(ann, chatId);
    await env.DB.batch([
      ...Array.from({ length: 5 }, () =>
        chatPermission({
          chatId,
          by: ann.userId,
          agentId: chats.agent.agentId,
          connectionId: mail.id,
          status: "requested",
        })
      ),
      chatPermission({
        chatId,
        by: ann.userId,
        agentId: chats.agent.agentId,
        connectionId: mail.id,
        status: "revoked",
      }),
    ]);
    await chatUnder(ben, chatId, chats.agent.agentId);
    await chats.stub.ask(chatId, { text: "Find the invoice.", model });
    const [bens, anns] = await Promise.all([
      ben.api.chats.connectionRequests(chatId),
      ann.api.chats.connectionRequests(chatId),
    ]);

    expect({ bens: bens.length, anns: anns.length }).toStrictEqual({
      bens: 1,
      anns: 5,
    });
  });

  it("lets two people's chats under one ID each hold a permission and a held start under the same name", async () => {
    const ann = await person();
    const ben = await person();
    const chatId = crypto.randomUUID();
    const workflow = crypto.randomUUID();
    const held = (someone: Person) =>
      env.DB.prepare(
        `INSERT INTO agent_held_starts (id, workspace_id, chat_id, agent_id, person_id, workflow_resource_id, input, input_hash, key, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, '{}', 'hash', 'start-1', ?, ?)`
      ).bind(
        crypto.randomUUID(),
        personalWorkspaceId(someone.userId),
        chatId,
        chatAgentId,
        someone.userId,
        workflow,
        Date.now(),
        Date.now() + 86_400_000
      );
    await env.DB.prepare(
      "INSERT INTO workflow_resources (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(workflow, `held-${workflow.slice(0, 6)}`, ann.userId, Date.now())
      .run();
    // The same chat ID, agent, binding and start key, each person's own.
    await env.DB.batch([
      chatPermission({ chatId, by: ann.userId, status: "active" }, "MAIL"),
      chatPermission({ chatId, by: ben.userId, status: "active" }, "MAIL"),
      held(ann),
      held(ben),
    ]);
    const owners = await env.DB.prepare(
      "SELECT requested_by AS owner FROM permissions WHERE chat_id = ? AND binding = 'MAIL' AND status = 'active' ORDER BY owner"
    )
      .bind(chatId)
      .all<{ owner: string }>();
    const [annsHeld, bensHeld] = await Promise.all([
      ann.api.heldStarts.list(),
      ben.api.heldStarts.list(),
    ]);

    expect({
      owners: owners.results.map(({ owner }) => owner),
      annsHeld: annsHeld.length,
      bensHeld: bensHeld.length,
    }).toStrictEqual({
      owners: [ann.userId, ben.userId].toSorted(),
      annsHeld: 1,
      bensHeld: 1,
    });
  });
});
