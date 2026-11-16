import { permissionErrors } from "@grasp-os/shared/permissions";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appKind } from "../src/apps.ts";
import { drainObjectOutbox } from "../src/audit-outbox.ts";
import { inertOn } from "../src/channels/inert.ts";
import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import { keepMadeInChat } from "../src/drafts.ts";
import { workspace } from "../src/durable-objects.ts";
import { maxChatsPerPerson } from "../src/workspace.ts";
import { codeStep, model, pausedReply, says } from "./agent-chat.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { fakeProvider, fakeProviderFor } from "./model-provider.ts";
import type { FakeProvider } from "./model-provider.ts";
import {
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";
import {
  member,
  memberAnsweredBy,
  mentionIn,
  messageFrom,
  newGroup,
  onGroupRoster,
  post,
  reached,
  watched,
} from "./teams-door.ts";

// A conversation with the agent in a chat app is never a chat in Grasp
// (GRA-1919, `shownInGrasp` in src/workspace.ts): through the real Teams
// door, nothing a person, an admin, Grasp staff or a guest reads in Grasp
// lists, finds or opens it, and asked for by its ID it answers exactly as
// a chat that doesn't exist; it goes on in Teams with all it was told,
// compacted as any chat; and its person deletes it, and what was kept of
// it, from Settings › Chat apps (`channelAccounts.forgetConversations`).

const idp = mockIdp();

watched();

/** Signing people in, and several turns, can be slow on CI. */
const setUpTime = { timeout: 90_000 };

/** The conversations `userId`'s Workspace keeps from chat apps, as its table holds them. */
const conversationsOf = async (userId: string): Promise<string[]> =>
  await runInDurableObject(
    workspace(env, personalWorkspaceId(userId)),
    (_instance, state) =>
      state.storage.sql
        .exec<{
          id: string;
        }>(
          "SELECT id FROM chats WHERE person_id = ? AND via <> 'web' ORDER BY created_at",
          userId
        )
        .toArray()
        .map(({ id }) => id)
  );

type Api = Awaited<ReturnType<typeof signedInApi>>["api"];

/** Every character but the white space between them, in order. */
const ink = (text: string): string => text.replaceAll(/\s/gu, "");

/** A Workspace object's env, as the test reaches into it. */
const envOf = (instance: object): object => {
  const objectEnv: unknown = Reflect.get(instance, "env");
  if (typeof objectEnv !== "object" || objectEnv === null) {
    throw new TypeError("The Workspace object has no env");
  }
  return objectEnv;
};

/**
 * `userId`'s Workspace object without connect, so a deletion fails after
 * its Brain part, until the returned function puts it back.
 */
const connectOutOfReach = async (
  userId: string
): Promise<() => Promise<void>> => {
  const stub = workspace(env, personalWorkspaceId(userId));
  const real: unknown = await runInDurableObject(stub, (instance) => {
    const objectEnv = envOf(instance);
    const was: unknown = Reflect.get(objectEnv, "CONNECT");
    Reflect.set(objectEnv, "CONNECT", {
      declineChatActions: () => {
        throw new Error("Connect is out of reach");
      },
    });
    return was;
  });
  return async () => {
    await runInDurableObject(stub, (instance) => {
      Reflect.set(envOf(instance), "CONNECT", real);
    });
  };
};

/**
 * `userId`'s Workspace object with connect answering a deletion only
 * once `until` settles: a delete under way for as long as a test needs.
 * The returned function puts connect back.
 */
const connectWaiting = async (
  userId: string,
  until: Promise<unknown>,
  onReach: () => void
): Promise<() => Promise<void>> => {
  const stub = workspace(env, personalWorkspaceId(userId));
  const real: unknown = await runInDurableObject(stub, (instance) => {
    const objectEnv = envOf(instance);
    const was: unknown = Reflect.get(objectEnv, "CONNECT");
    Reflect.set(objectEnv, "CONNECT", {
      declineChatActions: async () => {
        onReach();
        await until;
        return 0;
      },
    });
    return was;
  });
  return async () => {
    await runInDurableObject(stub, (instance) => {
      Reflect.set(envOf(instance), "CONNECT", real);
    });
  };
};

/** What `userId` was recorded deleting of their chats, oldest first. */
const deletionsBy = async (userId: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, actor }) =>
        action.startsWith("chat.") &&
        action.includes("deleted") &&
        actor.type === "person" &&
        actor.userId === userId
    )
    .map(({ action, target, detail }) => ({
      action,
      target: target?.type ?? null,
      deleted: detail.deleted ?? null,
      failed: detail.failed ?? null,
    }));
};

/** What every request of the session API naming chat `chatId` answers. */
const answersFor = async (api: Api, chatId: string) => ({
  summary: await outcome(api.chats.summary(chatId)),
  watch: await outcome(
    api.chats.watch(chatId, null, () => {
      // Nothing is ever pushed for it.
    })
  ),
  send: await outcome(api.chats.send(chatId, { text: "Hello", model })),
  cancel: await outcome(api.chats.cancel(chatId)),
  rename: await outcome(api.chats.rename(chatId, "Mine now")),
  remove: await outcome(api.chats.remove(chatId)),
  attachFile: await outcome(
    api.chats.attachFile(chatId, {
      name: "notes.txt",
      bytes: new TextEncoder().encode("A note."),
    })
  ),
  removeFile: await outcome(api.chats.removeFile(chatId, "file")),
  worked: await outcome(api.chats.worked(chatId)),
  packageRequests: await outcome(api.chats.packageRequests(chatId)),
  connectionRequests: await outcome(api.chats.connectionRequests(chatId)),
  grantConnection: await outcome(
    api.chats.grantConnection(chatId, "permission")
  ),
  denyConnection: await outcome(api.chats.denyConnection(chatId, "permission")),
});

/** The titles of `api`'s person's chats, as their list shows them. */
const listedFor = async (api: Api): Promise<string[]> => {
  const listed = await api.chats.list();
  return listed.map(({ title }) => title);
};

/** The titles of `api`'s person's chats, and what a search for `word` finds. */
const shownTo = async (api: Api, word: string) => {
  const found = await api.chats.search(word);
  return {
    listed: await listedFor(api),
    found: found.map(({ chat }) => chat.title),
  };
};

/** What a guest's page is told for a link naming `token`. */
const guestOpens = async (token: string) => {
  const response = await routed("/api/guest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "open", token }),
  });
  // Its words and code: its request ID is each request's own.
  const { code, message } = z
    .object({ code: z.string(), message: z.string() })
    .parse(await response.json());
  return { status: response.status, code, message };
};

/** The model requests that answered a message saying `text`, the person's own turns only. */
const answering = (provider: FakeProvider, text: string): string[] =>
  provider.requests
    .map(({ body }) => JSON.stringify(body))
    .filter(
      (body) =>
        body.includes(text) &&
        !body.includes("You sort one message a person sent to Stephen")
    );

describe("a conversation with the agent in Teams", setUpTime, () => {
  it("is no chat in Grasp for its person: no list or search shows it, and every address answers as for a chat that doesn't exist", async () => {
    const word = `zebrafish${unique()}`;
    const { api, userId, teams } = await member(idp, says("Noted."));
    await api.chats.create("Leave plans");

    await post(messageFrom(teams, { text: `Remember ${word}, please.` }));

    const [conversation] = await conversationsOf(userId);
    if (conversation === undefined) {
      throw new Error("Expected the Teams conversation to be kept");
    }
    const hidden = await answersFor(api, conversation);
    const shown = await shownTo(api, word);
    expect({
      ...shown,
      summary: hidden.summary,
      hidden,
    }).toStrictEqual({
      listed: ["Leave plans"],
      found: [],
      summary: "agent.chat_not_found",
      hidden: await answersFor(api, crypto.randomUUID()),
    });
    // Nothing of it was changed by any of that: it is still there, once.
    await expect(conversationsOf(userId)).resolves.toStrictEqual([
      conversation,
    ]);
  });

  it("is no chat in Grasp for an admin or Grasp staff either, nor anything a guest's link opens", async () => {
    const word = `narwhal${unique()}`;
    const { userId, teams } = await member(idp, says("Noted."));
    const admin = await signedInApi(idp, "admin");
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(staffSession);
    const staff = core.authenticate();

    await post(messageFrom(teams, { text: `Remember ${word}, please.` }));

    const [conversation] = await conversationsOf(userId);
    if (conversation === undefined) {
      throw new Error("Expected the Teams conversation to be kept");
    }
    const missing = crypto.randomUUID();
    expect({
      admin: {
        ...(await shownTo(admin.api, word)),
        hidden: await answersFor(admin.api, conversation),
      },
      staff: {
        found: await outcome(staff.chats.search(word)),
        hidden: await answersFor(staff, conversation),
        forget: await outcome(staff.channelAccounts.forgetConversations()),
      },
      guest: await guestOpens(conversation),
    }).toStrictEqual({
      admin: {
        listed: [],
        found: [],
        hidden: await answersFor(admin.api, missing),
      },
      staff: {
        found: await outcome(staff.chats.search(`${word}-nothing`)),
        hidden: await answersFor(staff, missing),
        forget: "role.forbidden",
      },
      guest: await guestOpens(missing),
    });
  });

  it("goes on with what was said before, and once its person deletes it from Settings, starts afresh, their chats in Grasp kept", async () => {
    const badge = `badge-${unique()}`;
    const question = `What is my badge? ${unique()}`;
    const { api, userId, teams, provider } = await member(
      idp,
      says("Noted."),
      says(`It's ${badge}.`),
      says("I don't know it.")
    );
    await api.chats.create("Leave plans");

    await post(messageFrom(teams, { text: `My badge is ${badge}.` }));
    await post(messageFrom(teams, { text: question }));
    const [first] = await conversationsOf(userId);
    const remembered = answering(provider, question).every((body) =>
      body.includes(badge)
    );
    const forgot = await api.channelAccounts.forgetConversations();
    const before = answering(provider, question).length;
    await post(messageFrom(teams, { text: question }));
    const afterwards = answering(provider, question).slice(before);
    const now = await conversationsOf(userId);

    expect({
      remembered,
      forgot,
      // Asked again after: the model is told nothing of what went.
      askedAfter: afterwards.length > 0,
      toldAfter: afterwards.some((body) => body.includes(badge)),
      conversations: now.length,
      anew: now[0] !== first,
      listed: await listedFor(api),
      again: await api.channelAccounts.forgetConversations(),
      left: await conversationsOf(userId),
    }).toStrictEqual({
      remembered: true,
      forgot: 1,
      askedAfter: true,
      toldAfter: false,
      conversations: 1,
      anew: true,
      listed: ["Leave plans"],
      again: 1,
      left: [],
    });
  });

  it("gets an answer too long for one message whole and inert, over several, and no message links to a chat in Grasp", async () => {
    // Posted whole where nothing streams: a group chat's thread. Full of
    // what a card would read as a link, which each piece breaks.
    const sentence =
      "Tom & Jerry's <b>invoices</b> are at [the list](https://e.test). ";
    const answer = Array.from(
      { length: 30 },
      (_, at) => `${at}. ${sentence.repeat(40).trim()}`
    ).join("\n\n");
    const { teams } = await member(idp, says(answer));
    const group = newGroup();
    await onGroupRoster(group, [{ person: teams }]);

    await post(mentionIn(teams, group, "Tell me about the invoices."));

    const { activities } = await reached(group);
    const messages = activities.filter(({ type }) => type === "message");
    const said = JSON.stringify(messages);
    const shown = messages
      .flatMap(
        (message) =>
          JSON.stringify(message).match(/"text":"(?:[^"\\]|\\.)*"/gu) ?? []
      )
      .map(
        (field) =>
          z.object({ text: z.string() }).parse(JSON.parse(`{${field}}`)).text
      )
      .join("");
    expect({
      several: messages.length > 1,
      whole: ink(shown).includes(ink(inertOn("teams")(answer))),
      linkForm: shown.includes("]("),
      linksToChat: said.includes("?chat="),
    }).toStrictEqual({
      several: true,
      whole: true,
      linkForm: false,
      linksToChat: false,
    });
  });

  it("counts toward no cap on chats: a person with as many chat-app conversations as the cap still starts a chat in Grasp, and is answered in Teams", async () => {
    const { api, userId, teams } = await member(idp, says("Still here."));
    // As many group chats' conversations as the cap allows chats, kept as
    // the door keeps them.
    await runInDurableObject(
      workspace(env, personalWorkspaceId(userId)),
      (_instance, state) => {
        for (let at = 0; at < maxChatsPerPerson; at += 1) {
          state.storage.sql.exec(
            "INSERT INTO chats (id, title, created_at, last_at, person_id, agent_id, via, thread) VALUES (?, 'Microsoft Teams group chat', ?, ?, ?, ?, 'teams', ?)",
            crypto.randomUUID(),
            Date.now(),
            Date.now(),
            userId,
            chatAgentId,
            `19:${at}@thread.v2`
          );
        }
      }
    );

    const started = await outcome(api.chats.create("Leave plans"));
    await post(messageFrom(teams, { text: "Are you there?" }));

    const { activities } = await reached(teams.conversation);
    expect({
      started,
      answered: JSON.stringify(activities).includes("Still here."),
    }).toStrictEqual({ started: "ok", answered: true });
  });

  it("is deleted from Settings with every other in one action, recorded once with how many went, and a second click is an action of its own", async () => {
    const { api, userId, teams } = await member(
      idp,
      says("Noted."),
      says("Noted in the group.")
    );
    const group = newGroup();
    await onGroupRoster(group, [{ person: teams }]);
    await post(messageFrom(teams, { text: "Hello." }));
    await post(mentionIn(teams, group, "Hello, group."));
    await api.chats.create("Leave plans");

    const counts = [
      await api.channelAccounts.forgetConversations(),
      await api.channelAccounts.forgetConversations(),
    ];

    await vi.waitFor(
      async () => {
        await expect(deletionsBy(userId)).resolves.toHaveLength(2);
      },
      { timeout: 15_000, interval: 200 }
    );
    expect({
      counts,
      left: await conversationsOf(userId),
      recorded: await deletionsBy(userId),
    }).toStrictEqual({
      counts: [2, 0],
      left: [],
      recorded: [
        {
          action: "chat.apps_deleted",
          target: "person",
          deleted: 2,
          failed: 0,
        },
        {
          action: "chat.apps_deleted",
          target: "person",
          deleted: 0,
          failed: 0,
        },
      ],
    });
  });

  it("stays when a step after its Brain part fails, and the next click deletes it", async () => {
    const { api, userId, teams } = await member(idp, says("Noted."));
    await post(messageFrom(teams, { text: "Hello." }));
    const putBack = await connectOutOfReach(userId);

    const refused = await outcome(api.channelAccounts.forgetConversations());
    const stayed = await conversationsOf(userId);
    await putBack();
    const again = await api.channelAccounts.forgetConversations();

    await vi.waitFor(
      async () => {
        await expect(deletionsBy(userId)).resolves.toHaveLength(2);
      },
      { timeout: 15_000, interval: 200 }
    );
    const recorded = await deletionsBy(userId);
    expect({
      refused: refused === "ok" ? "deleted" : "refused",
      stayed: stayed.length,
      again,
      left: await conversationsOf(userId),
      recorded: recorded.map(({ deleted, failed }) => ({ deleted, failed })),
    }).toStrictEqual({
      refused: "refused",
      stayed: 1,
      again: 1,
      left: [],
      recorded: [
        { deleted: 0, failed: 1 },
        { deleted: 1, failed: 0 },
      ],
    });
  });

  it("is deleted once when asked again while its delete is under way, which says so, and recorded once", async () => {
    const { api, userId, teams } = await member(idp, says("Noted."));
    await post(messageFrom(teams, { text: "Hello." }));
    const gate = Promise.withResolvers<boolean>();
    // Set inside the Workspace object, read here: plain memory, no I/O.
    const at = { connect: false };
    const putBack = await connectWaiting(userId, gate.promise, () => {
      at.connect = true;
    });

    const first = api.channelAccounts.forgetConversations();
    // The first is at connect, past the Brain, before the second asks.
    await vi.waitFor(
      () => {
        expect(at.connect).toBeTruthy();
      },
      { timeout: 15_000, interval: 20 }
    );
    const second = await outcome(api.channelAccounts.forgetConversations());
    gate.resolve(true);
    const deleted = await first;
    await putBack();

    // Everything the Workspace noted delivered first: a stray second event
    // would be in the log by now.
    await runInDurableObject(
      workspace(env, personalWorkspaceId(userId)),
      async (_instance, state) => {
        await drainObjectOutbox(env, state.storage.sql, 0);
      }
    );
    const recorded = await deletionsBy(userId);
    expect({ second, deleted, recorded }).toStrictEqual({
      second: "agent.delete_under_way",
      deleted: 1,
      recorded: [
        {
          action: "chat.apps_deleted",
          target: "person",
          deleted: 1,
          failed: 0,
        },
      ],
    });
  });

  it("isn't deleted while it is being answered, and says it is still being answered", async () => {
    const held = pausedReply(says("Almost."), 2);
    const { api, userId, teams, provider } = await member(idp, held.reply);

    const asked = post(messageFrom(teams, { text: "Hello." }));
    await vi.waitFor(
      () => {
        expect(provider.requests.length).toBeGreaterThan(0);
      },
      { timeout: 15_000, interval: 50 }
    );
    const refused = await outcome(api.channelAccounts.forgetConversations());
    held.release();
    await asked;
    const left = await conversationsOf(userId);

    expect({ refused, left: left.length }).toStrictEqual({
      refused: "agent.conversation_answering",
      left: 1,
    });
  });

  it("asks for no connection of the person's own, which only a chat in Grasp can grant, and tells them where", async () => {
    const provider = await fakeProvider(
      codeStep(
        `export default async (self, env) => { const own = (await env.connections.available()).find(({ scope }) => scope === "personal"); return await env.connections.request({ connectionId: own?.connectionId ?? "", actions: ["mail.search"], binding: "MINE", reason: "To find the invoice." }).then(({ binding }) => binding, (error) => error.message); };`
      ),
      says("I can't ask for that here.")
    );
    const { userId, teams } = await memberAnsweredBy(idp, provider);
    await mailConnection([], ["mail.search"], { owner: userId });

    await post(messageFrom(teams, { text: "Find the invoice in my mail." }));

    const told = permissionErrors.create("permission.own_in_chat_app").message;
    const { results } = await env.DB.prepare(
      "SELECT count(*) AS waiting FROM permissions WHERE requested_by = ? AND status = 'requested'"
    )
      .bind(userId)
      .all<{ waiting: number }>();
    expect({
      waiting: results[0]?.waiting,
      toldModel: provider.requests.some((request) =>
        JSON.stringify(request.body).includes(told)
      ),
      says: told,
    }).toStrictEqual({
      waiting: 0,
      toldModel: true,
      says: "A connection of the person's own can be granted only in a chat in Grasp, not in a chat app, and a grant there holds in that chat alone. Tell them to ask you in a chat in Grasp (Chat, in Grasp's sidebar), grant it there, and have the work done in that chat.",
    });
  });

  it("is never an App's chat, though it worked on the App last", async () => {
    const { api, userId, teams } = await memberAnsweredBy(
      idp,
      await fakeProvider(says("Noted.")),
      "builder"
    );
    const { id: appId } = await api.apps.create({ name: `Desk ${unique()}` });
    await post(messageFrom(teams, { text: "Hello." }));
    const [conversation] = await conversationsOf(userId);
    if (conversation === undefined) {
      throw new Error("Expected the Teams conversation to be kept");
    }
    // As Build it, or its agent's write, keeps the chat that worked on it.
    await keepMadeInChat(env, appKind, appId, userId, {
      chatId: conversation,
      turnId: null,
      callId: null,
    });

    await expect(
      api.chats.forSubject({ kind: "app", id: appId })
    ).resolves.toBeNull();
  });

  it("is compacted when it outgrows the model's window, and goes on answering", async () => {
    // The deployment's default model, which Teams asks, has a small window.
    const smallModel = "mistral/voxtral-small-latest";
    const provider = await fakeProviderFor(
      [smallModel, model],
      ...Array.from({ length: 12 }, () => says("Noted."))
    );
    const { teams } = await memberAnsweredBy(idp, provider);

    for (let turn = 0; turn < 6; turn += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one turn after another
      await post(
        messageFrom(teams, {
          text: `Turn ${turn}: ${"long words ".repeat(2600)}`,
        })
      );
    }

    const { activities } = await reached(teams.conversation);
    expect({
      compacted: provider.requests.some(({ body }) =>
        JSON.stringify(body).includes("context summarization assistant")
      ),
      // Each answer, posted whole as a message of its own.
      answered: activities.filter(
        (activity) =>
          activity.type === "message" &&
          JSON.stringify(activity).includes("Noted.")
      ).length,
    }).toStrictEqual({ compacted: true, answered: 6 });
  });
});
