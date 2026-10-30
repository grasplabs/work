import { describe, expect, it } from "vite-plus/test";

import {
  codeResults,
  codeStep,
  model,
  personalChatsOf,
  says,
} from "./agent-chat.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// A chat bound to an App (`chats.forApp`), through `/rpc` as the App's
// page reaches it and from the chat's code: the person's chat where Grasp
// changes the App with them. What could go wrong: someone who doesn't
// build the App gets a chat for it, or one for an App that is archived or
// isn't there; two asks make two chats; one person gets another's chat;
// the binding goes unrecorded; the chat's agent isn't told the App.

const idp = mockIdp();

/** A builder's App, and the people around it. */
const anApp = async () => {
  const [builder, other, user] = await Promise.all([
    signedInApi(idp, "builder"),
    signedInApi(idp, "builder"),
    signedInApi(idp, "user"),
  ]);
  const name = `Invoices ${unique()}`;
  const app = await builder.api.apps.create({ name });
  return { builder, other, user, app, name };
};

describe("a chat for an App", () => {
  it("is the builder's own, named after the App, the same one each time, and recorded with the App", async () => {
    const { builder, app, name } = await anApp();

    const first = await builder.api.chats.forApp(app.id);
    const again = await builder.api.chats.forApp(app.id);
    const listed = await builder.api.chats.list();
    const events = await allEvents();
    const created = events.find(
      ({ action, target }) =>
        action === "chat.created" && target?.id === first.id
    );

    expect({
      title: first.title,
      app: first.appId,
      again: again.id === first.id,
      listed: listed.find(({ id }) => id === first.id)?.appId,
      recorded: { actor: created?.actor, app: created?.detail.app },
    }).toStrictEqual({
      title: name,
      app: app.id,
      again: true,
      listed: app.id,
      recorded: {
        actor: { type: "person", userId: builder.userId },
        app: app.id,
      },
    });
  });

  it("is each builder's own: another builder of the App gets a chat of their own", async () => {
    const { builder, other, app } = await anApp();
    await builder.api.apps.members.add(app.id, {
      type: "person",
      id: other.userId,
      role: "builder",
    });

    const mine = await builder.api.chats.forApp(app.id);
    const theirs = await other.api.chats.forApp(app.id);
    const theirChats = await other.api.chats.list();

    expect({
      apart: mine.id !== theirs.id,
      theirsListed: theirChats.map(({ id }) => id),
    }).toStrictEqual({ apart: true, theirsListed: [theirs.id] });
  });

  it("says whose App it is for when read on its own, as a chat past the list's end is, and only to its own person", async () => {
    const { builder, other, app } = await anApp();
    const chat = await builder.api.chats.forApp(app.id);

    expect({
      own: await builder.api.chats.summary(chat.id),
      another: await outcome(other.api.chats.summary(chat.id)),
      none: await outcome(builder.api.chats.summary(crypto.randomUUID())),
    }).toStrictEqual({
      own: { ...chat, running: false },
      another: "agent.chat_not_found",
      none: "agent.chat_not_found",
    });
  });

  it("is refused to someone who doesn't build the App, for an archived App, and for one that isn't there, making no chat", async () => {
    const { builder, other, user, app } = await anApp();
    await builder.api.apps.members.add(app.id, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const tried = {
      user: await outcome(user.api.chats.forApp(app.id)),
      stranger: await outcome(other.api.chats.forApp(app.id)),
      nothing: await outcome(builder.api.chats.forApp(`app-${unique()}`)),
    };
    await builder.api.apps.archive(app.id);
    const archived = await outcome(builder.api.chats.forApp(app.id));

    expect({
      ...tried,
      archived,
      chats: {
        user: await user.api.chats.list(),
        stranger: await other.api.chats.list(),
        builder: await builder.api.chats.list(),
      },
    }).toStrictEqual({
      // Not one they may build: as if it weren't there.
      user: "app.not_found",
      stranger: "app.not_found",
      nothing: "app.not_found",
      archived: "app.archived",
      chats: { user: [], stranger: [], builder: [] },
    });
  });

  it("tells its agent which App it is for, and another chat none", async () => {
    const { builder, app } = await anApp();
    const info =
      "export default async (self, env) => (await env.chat.info()).app;";
    const { stub, newChat } = await personalChatsOf(
      builder.userId,
      codeStep(info),
      says("It is for the App."),
      codeStep(info),
      says("It is for nothing in particular.")
    );
    const bound = await builder.api.chats.forApp(app.id);
    await stub.ask(bound.id, { text: "Which App?", model });
    const { chat } = await newChat();
    await stub.ask(chat.id, { text: "Which App?", model });

    expect({
      bound: await codeResults(stub, bound.id),
      other: await codeResults(stub, chat.id),
    }).toStrictEqual({
      bound: [{ isError: false, text: `Returned:\n${app.id}` }],
      other: [{ isError: false, text: "Returned:\nnull" }],
    });
  });
});
