import { describe, expect, it, vi } from "vite-plus/test";

import { codeStep, model, personalChatsOf, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { answeringProvider } from "./model-provider.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// The person's chat for an App or a workflow (`chats.forSubject`), through
// `/rpc` as its page reaches it: the chat whose agent last worked on it
// with them, none before, when the next question starts one. What could
// go wrong: someone who doesn't build it gets a chat for it, or one for
// an App that is archived or isn't there; one person gets another's
// chat; the agent isn't told what a question is about, and a build asked
// there makes a second App instead of changing this one; a chat that
// drafted it elsewhere is left behind for a new one.

const idp = mockIdp();

/** The App a question's note says it is about, as the request's JSON has it. */
const aboutApp =
  /workspace of the App \\"(?<name>[^"\\]+)\\" \((?<id>[^)]+)\)/u;

/** The workflow a question's note says it is about, as the request's JSON has it. */
const aboutWorkflow =
  /page of the workflow \\"(?<name>[^"\\]+)\\" \((?<id>[^)]+)\)/u;

/** What `who`'s chat for App `id` came to: their chat, or a refusal. */
const forApp = async (
  who: Awaited<ReturnType<typeof signedInApi>>,
  id: string
) => await outcome(who.api.chats.forSubject({ kind: "app", id }));

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

describe("the chat for an App", () => {
  it("is none before a chat worked on the App, then the chat whose agent drafted it, the same each time", async () => {
    const { builder, app } = await anApp();
    const write = `export default async (self, env) => {
  await env.build.write(${JSON.stringify(app.id)}, { "notes.md": "from Chat" }, { revision: (await env.build.files(${JSON.stringify(app.id)})).revision });
};`;
    const { stub, newChat } = await personalChatsOf(
      builder.userId,
      codeStep(write),
      says("Written.")
    );
    const subject = { kind: "app", id: app.id } as const;
    const before = await builder.api.chats.forSubject(subject);
    const { chat: started } = await newChat();
    await stub.ask(started.id, { text: "Add notes to it.", model });

    const found = await builder.api.chats.forSubject(subject);
    const again = await builder.api.chats.forSubject(subject);
    const listed = await builder.api.chats.list();

    expect({
      before,
      found: found?.id,
      again: again?.id,
      // Nothing new made: the chat that drafted it is the only one.
      chats: listed.map(({ id }) => id),
    }).toStrictEqual({
      before: null,
      found: started.id,
      again: started.id,
      chats: [started.id],
    });
  });

  it("is each builder's own: another builder of the App finds none of theirs", async () => {
    const { builder, other, app } = await anApp();
    await builder.api.apps.members.add(app.id, {
      type: "person",
      id: other.userId,
      role: "builder",
    });
    const write = `export default async (self, env) => {
  await env.build.write(${JSON.stringify(app.id)}, { "notes.md": "mine" }, { revision: (await env.build.files(${JSON.stringify(app.id)})).revision });
};`;
    const { stub, newChat } = await personalChatsOf(
      builder.userId,
      codeStep(write),
      says("Written.")
    );
    const { chat } = await newChat();
    await stub.ask(chat.id, { text: "Add notes to it.", model });
    const subject = { kind: "app", id: app.id } as const;

    const mine = await builder.api.chats.forSubject(subject);

    expect({
      mine: mine?.id,
      theirs: await other.api.chats.forSubject(subject),
    }).toStrictEqual({ mine: chat.id, theirs: null });
  });

  it("is refused to someone who doesn't build the App, for an archived App, and for one that isn't there, making no chat", async () => {
    const { builder, other, user, app } = await anApp();
    await builder.api.apps.members.add(app.id, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const tried = {
      user: await forApp(user, app.id),
      stranger: await forApp(other, app.id),
      nothing: await forApp(builder, `app-${unique()}`),
    };
    await builder.api.apps.archive(app.id);
    const archived = await forApp(builder, app.id);

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

describe("the chat for a workflow", () => {
  it("is the person's chat whose agent last drafted it, none before, and refused to someone who doesn't build it", async () => {
    const [builder, user] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "user"),
    ]);
    const made = await builder.api.workflowResources.create(
      `quotes-${unique()}`
    );
    const id = JSON.stringify(made.id);
    const draft = `export default async (self, env) => {
  const draft = await env.workflowBuild.draft(${id});
  await env.workflowBuild.write(${id}, draft.source + "\\n", { revision: draft.revision });
};`;
    const { stub, newChat } = await personalChatsOf(
      builder.userId,
      codeStep(draft),
      says("Drafted.")
    );
    const subject = { kind: "workflow", id: made.id } as const;
    const before = await builder.api.chats.forSubject(subject);
    const { chat } = await newChat();
    await stub.ask(chat.id, { text: "Draft it.", model });

    const after = await builder.api.chats.forSubject(subject);
    expect({
      before,
      after: after?.id,
      refused: await outcome(user.api.chats.forSubject(subject)),
    }).toStrictEqual({
      before: null,
      after: chat.id,
      refused: "workflow.resource_unavailable",
    });
  });
});
