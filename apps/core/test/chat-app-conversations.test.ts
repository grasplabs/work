import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { model, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { fakeProviderFor } from "./model-provider.ts";
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
  messageFrom,
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
