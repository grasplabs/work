import type { ChatMention, ChatQuestion } from "@grasp-os/shared/chat";
import { chatMentionsMax } from "@grasp-os/shared/chat";
import { describe, expect, it, vi } from "vite-plus/test";

import { model, personalChatsOf, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { answeringProvider } from "./model-provider.ts";
import type { SentRequest } from "./model-provider.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// What a question mentions (`ChatQuestion.mentions`), through `/rpc` as
// the composer sends it: what the person picked with `@`, told to the
// agent by name and ID beside their words. What could go wrong: the agent
// isn't told, or told a name the page made up; a mention of an App or
// workflow the person has no role in, or of someone who isn't a member,
// lets them learn its name from the answer; a member's role and teams
// reach someone the member list doesn't show them to; the note is lost
// once the chat moves on.

const idp = mockIdp();

const notePrefix = "The person mentions these";

/** Every text a model request carries, wherever it sits in its body. */
const textsOf = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap(textsOf);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, inner]) =>
    key === "text" && typeof inner === "string" ? [inner] : textsOf(inner)
  );
};

/** The mention notes a request carries, each as its lines after the first. */
const mentionNotes = (request: SentRequest | undefined): string[][] =>
  textsOf(request?.body)
    .filter((text) => text.startsWith(notePrefix))
    .map((text) => text.split("\n").slice(1));

type Api = Awaited<ReturnType<typeof signedInApi>>["api"];

/** Sends `question` in `chatId` and waits for its turn to end. */
const asked = async (api: Api, chatId: string, question: ChatQuestion) => {
  await api.chats.send(chatId, question);
  await vi.waitFor(
    async () => {
      const chats = await api.chats.list();
      expect(chats.find(({ id }) => id === chatId)?.running).toBeFalsy();
    },
    { timeout: 20_000 }
  );
};

/** A model that answers every request, keeping what each sent. */
const listeningModel = async () => {
  const sent: SentRequest[] = [];
  await answeringProvider((requests) => {
    const last = requests.at(-1);
    if (last !== undefined) {
      sent.push(last);
    }
    return says("Noted.");
  });
  return sent;
};

describe("a question's mentions", () => {
  it("tell the agent each App, workflow and member by name and ID, a member's role and teams to an admin, and stay with the question", async () => {
    const [admin, member] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "builder"),
    ]);
    const appName = `Invoices ${unique()}`;
    const app = await admin.api.apps.create({ name: appName });
    const workflowName = `month-end-${unique()}`;
    const workflow = await admin.api.workflowResources.create(workflowName);
    const teamId = await newTeam(admin, [member]);
    const teams = await admin.api.members.teams();
    const team = teams.find(({ id }) => id === teamId);
    const { newChat } = await personalChatsOf(admin.userId);
    const sent = await listeningModel();
    const { chat } = await newChat();

    await asked(admin.api, chat.id, {
      text: "Ask the member to run the workflow for the App.",
      model,
      mentions: [
        { kind: "app", id: app.id },
        { kind: "workflow", id: workflow.id },
        { kind: "person", id: member.userId },
      ],
    });
    await asked(admin.api, chat.id, { text: "And again tomorrow.", model });

    const told = [
      `- the App ${JSON.stringify(appName)} (${app.id})`,
      `- the workflow ${JSON.stringify(workflowName)} (${workflow.id})`,
      `- the member ${JSON.stringify(member.person.name)} (${member.userId}), builder, in ${JSON.stringify(team?.name)}`,
    ];
    expect({
      first: mentionNotes(sent.at(0)),
      // The next question mentions nothing: the note it reads is the
      // first's, kept with it.
      next: mentionNotes(sent.at(-1)),
    }).toStrictEqual({ first: [told], next: [told] });
  });

  it("tell someone who isn't an admin a member by name and ID alone", async () => {
    const [asker, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "builder"),
    ]);
    const { newChat } = await personalChatsOf(asker.userId);
    const sent = await listeningModel();
    const { chat } = await newChat();

    await asked(asker.api, chat.id, {
      text: "What does this person work on?",
      model,
      mentions: [{ kind: "person", id: member.userId }],
    });

    expect(mentionNotes(sent.at(0))).toStrictEqual([
      [`- the member ${JSON.stringify(member.person.name)} (${member.userId})`],
    ]);
  });

  it("refuse a question mentioning an App or workflow the person has no role in, or someone who isn't a member, or too many or twice, taking no turn", async () => {
    const [owner, asker] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
    ]);
    const app = await owner.api.apps.create({ name: `Payroll ${unique()}` });
    const workflow = await owner.api.workflowResources.create(
      `salaries-${unique()}`
    );
    const { newChat } = await personalChatsOf(asker.userId);
    const sent = await listeningModel();
    const { chat } = await newChat();
    const ask = async (mentions: ChatMention[]) =>
      await outcome(
        asker.api.chats.send(chat.id, { text: "Who is this?", model, mentions })
      );
    const self = { kind: "person" as const, id: asker.userId };

    expect({
      app: await ask([self, { kind: "app", id: app.id }]),
      workflow: await ask([self, { kind: "workflow", id: workflow.id }]),
      person: await ask([{ kind: "person", id: `user-${unique()}` }]),
      twice: await ask([self, self]),
      tooMany: await ask(
        Array.from({ length: chatMentionsMax + 1 }, () => ({
          kind: "app" as const,
          id: `app-${unique()}`,
        }))
      ),
      turns: sent.length,
      untouched: await asker.api.chats
        .summary(chat.id)
        .then(({ lastAt, createdAt }) => lastAt === createdAt),
    }).toStrictEqual({
      app: "app.not_found",
      workflow: "workflow.resource_unavailable",
      person: "member.not_found",
      twice: "agent.invalid_question",
      tooMany: "agent.invalid_question",
      turns: 0,
      untouched: true,
    });
  });

  it("are picked from every member by name, with each one's role for an admin alone", async () => {
    const [admin, asker, member] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
      signedInApi(idp, "builder"),
    ]);
    const [seenByAdmin, seenByAsker] = await Promise.all([
      admin.api.chats.people(),
      asker.api.chats.people(),
    ]);

    expect({
      admin: seenByAdmin.find(({ id }) => id === member.userId),
      asker: seenByAsker.find(({ id }) => id === member.userId),
    }).toStrictEqual({
      admin: { id: member.userId, name: member.person.name, role: "builder" },
      asker: { id: member.userId, name: member.person.name },
    });
  });
});
