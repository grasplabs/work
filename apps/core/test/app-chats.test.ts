import { describe, expect, it, vi } from "vite-plus/test";

import {
  codeResults,
  codeStep,
  model,
  personalChatsOf,
  says,
} from "./agent-chat.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { answeringProvider } from "./model-provider.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// A chat bound to an App (`chats.forApp`), through `/rpc` as the App's
// page reaches it and from the chat's code: the person's chat where Grasp
// changes the App with them. What could go wrong: someone who doesn't
// build the App gets a chat for it, or one for an App that is archived or
// isn't there; two asks make two chats; one person gets another's chat;
// the binding goes unrecorded; the chat's agent isn't told the App, and a
// build asked there makes a second App instead of changing this one; a
// chat that drafted the App elsewhere is left behind for a new one.

const idp = mockIdp();

/** The App a question's note says it is about, as the request's JSON has it. */
const aboutApp =
  /workspace of the App \\"(?<name>[^"\\]+)\\" \((?<id>[^)]+)\)/u;

/** The workflow a question's note says it is about, as the request's JSON has it. */
const aboutWorkflow =
  /page of the workflow \\"(?<name>[^"\\]+)\\" \((?<id>[^)]+)\)/u;

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

  it("is the chat that last worked on the App: one started on Chat that drafted it, rather than one of its own", async () => {
    const { builder, app } = await anApp();
    const write = `export default async (self, env) => {
  await env.build.write(${JSON.stringify(app.id)}, { "notes.md": "from Chat" }, { revision: (await env.build.files(${JSON.stringify(app.id)})).revision });
};`;
    const { stub, newChat } = await personalChatsOf(
      builder.userId,
      codeStep(write),
      says("Written.")
    );
    const own = await builder.api.chats.forApp(app.id);
    const { chat: started } = await newChat();
    await stub.ask(started.id, { text: "Add notes to it.", model });

    const again = await builder.api.chats.forApp(app.id);
    const listed = await builder.api.chats.list();

    expect({
      carriesOn: again.id === started.id,
      // Nothing new made: the App's first chat stays in the list.
      chats: listed.map(({ id }) => id).toSorted(),
    }).toStrictEqual({
      carriesOn: true,
      chats: [own.id, started.id].toSorted(),
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

  it("tells the agent, with a question asked on the App's workspace, which App it is about, and its build changes that one, in any chat", async () => {
    const { builder, app, name } = await anApp();
    const { newChat } = await personalChatsOf(builder.userId);
    // A model that knows only what the question told it: the App it is
    // about, as the note beside it names it. Its code writes to that App.
    const told: (string | undefined)[] = [];
    await answeringProvider((requests) => {
      if (requests.length > 1) {
        return says("Built it.");
      }
      const asked = JSON.stringify(requests.at(-1)?.body);
      const named = aboutApp.exec(asked)?.groups;
      told.push(named?.name, named?.id);
      return codeStep(`export default async (self, env) => {
  await env.build.write(${JSON.stringify(named?.id)}, { "src/routes/index.tsx": "import { createFileRoute } from \\"@tanstack/react-router\\";\\nconst Page = () => null;\\n\\nexport const Route = createFileRoute(\\"/\\")({ component: Page });\\n" }, { revision: (await env.build.files(${JSON.stringify(named?.id)})).revision });
};`);
    });
    // An ordinary chat, as one started on Chat: no App of its own.
    const { chat } = await newChat();

    await builder.api.chats.send(chat.id, {
      text: "Build a list of open invoices.",
      model,
      subject: { kind: "app", id: app.id },
    });
    await vi.waitFor(
      async () => {
        const chats = await builder.api.chats.list();
        expect(chats.find(({ id }) => id === chat.id)?.running).toBeFalsy();
      },
      { timeout: 20_000 }
    );
    const worked = await builder.api.chats.worked(chat.id);

    expect({
      told,
      drafted: worked.map(({ id }) => id),
    }).toStrictEqual({ told: [name, app.id], drafted: [app.id] });
  });

  it("tells the agent the App with every question in a chat made for it, named or not", async () => {
    const { builder, app } = await anApp();
    const told: (string | undefined)[] = [];
    await answeringProvider((requests) => {
      told.push(
        aboutApp.exec(JSON.stringify(requests.at(-1)?.body))?.groups?.id
      );
      return says("Noted.");
    });
    const chat = await builder.api.chats.forApp(app.id);

    await builder.api.chats.send(chat.id, { text: "Make it blue.", model });
    await vi.waitFor(
      async () => {
        const chats = await builder.api.chats.list();
        expect(chats.find(({ id }) => id === chat.id)?.running).toBeFalsy();
      },
      { timeout: 20_000 }
    );

    expect(told).toStrictEqual([app.id]);
  });

  it("refuses a question about an App the person doesn't build, or one archived, taking no turn", async () => {
    const { builder, other, app } = await anApp();
    const { newChat } = await personalChatsOf(other.userId);
    const { chat } = await newChat();
    const theirs = await outcome(
      other.api.chats.send(chat.id, {
        text: "Change it.",
        model,
        subject: { kind: "app", id: app.id },
      })
    );
    await builder.api.apps.archive(app.id);
    const mine = await personalChatsOf(builder.userId);
    const { chat: own } = await mine.newChat();
    const archived = await outcome(
      builder.api.chats.send(own.id, {
        text: "Change it.",
        model,
        subject: { kind: "app", id: app.id },
      })
    );

    expect({ theirs, archived }).toStrictEqual({
      theirs: "app.not_found",
      archived: "app.archived",
    });
  });

  it("tells the agent, with a question asked on a workflow's page, which workflow it is about; refuses one the person doesn't build", async () => {
    const { builder, other } = await anApp();
    const workflow = await builder.api.workflowResources.create(
      `intake-${unique()}`
    );
    // Both people's chats first: the model, as it answers, after them.
    const { newChat } = await personalChatsOf(builder.userId);
    const { chat } = await newChat();
    const theirs = await personalChatsOf(other.userId);
    const { chat: others } = await theirs.newChat();

    const told: (string | undefined)[] = [];
    await answeringProvider((requests) => {
      const named = aboutWorkflow.exec(
        JSON.stringify(requests.at(-1)?.body)
      )?.groups;
      told.push(named?.name, named?.id);
      return says("Noted.");
    });
    await builder.api.chats.send(chat.id, {
      text: "Add an approval step.",
      model,
      subject: { kind: "workflow", id: workflow.id },
    });
    await vi.waitFor(
      () => {
        expect(told).not.toHaveLength(0);
      },
      { timeout: 20_000 }
    );
    const refused = await outcome(
      other.api.chats.send(others.id, {
        text: "Change it.",
        model,
        subject: { kind: "workflow", id: workflow.id },
      })
    );

    expect({ told, refused }).toStrictEqual({
      told: [workflow.name, workflow.id],
      refused: "workflow.resource_unavailable",
    });
  });
});
