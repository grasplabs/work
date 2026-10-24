import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { codeStep, pausedReply, says } from "./agent-chat.ts";
import { fakeGateway } from "./ai-gateway.ts";
import { requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { readCollection } from "./knowledge.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { signedInApi, unique } from "./sign-in.ts";
import {
  member,
  memberAnsweredBy,
  messageFrom,
  post,
  reached,
  watched,
} from "./teams-door.ts";

// A member's Teams message answered by the organization's agent in their
// own Teams chat in Grasp (src/channels/answer.ts): the turn runs in their
// own Workspace object, with the model gateway faked behind it, and the
// answer, with its sources, goes back through connect to the fake Bot
// Connector (test/bot-connector-fake.ts).

const idp = mockIdp();

watched();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** The person's chats, as their Workspace keeps them, with their channel. */
const chatsOf = async (userId: string) =>
  await runInDurableObject(
    workspace(env, personalWorkspaceId(userId)),
    (_instance, state) =>
      state.storage.sql
        .exec<{
          id: string;
          title: string;
          via: string;
        }>("SELECT id, title, via FROM chats WHERE person_id = ?", userId)
        .toArray()
  );

/** The answers posted in `conversation`: each message's whole activity, as JSON. */
const answersIn = async (conversation: string): Promise<string[]> => {
  const { activities } = await reached(conversation);
  return activities
    .filter(({ type }) => type === "message")
    .map((activity) => JSON.stringify(activity));
};

describe("a member's question", setUpTime, () => {
  it("is answered in their own Teams chat, with the documents it cites", async () => {
    const admin = await signedInApi(idp, "admin");
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    const saved = await admin.api.knowledge.saveDocument({
      collectionId,
      path: "leave.md",
      text: "# Parental leave\n\nParental leave lasts sixteen weeks.",
      ifVersion: 0,
    });
    await requestGranted(
      idp,
      admin,
      readCollection(
        { type: "agent", agentId: chatAgentId },
        collectionId,
        `H${unique()}`.toUpperCase()
      )
    );
    const { userId, teams } = await member(
      idp,
      codeStep(
        `export default async (self, env) => (await env.knowledge.read(${JSON.stringify(saved.id)})).text;`
      ),
      says(
        `Leave lasts sixteen weeks [Parental leave](grasp:note/${saved.id}).`
      )
    );

    await post(messageFrom(teams, { text: "How long is parental leave?" }));

    const chats = await chatsOf(userId);
    expect(chats).toMatchObject([{ title: "Microsoft Teams", via: "teams" }]);
    const [answer] = await answersIn(teams.conversation);
    expect(answer).toContain("Leave lasts sixteen weeks");
    expect(answer).toContain("1. Parental leave");
    expect(answer).toContain(
      `${clientOrigin}/knowledge/${collectionId}?doc=${saved.id}`
    );
    // Labelled as made by AI, as Teams shows it.
    expect(answer).toContain("AIGeneratedContent");
  });

  it("goes on in the same chat, and another person's stays apart", async () => {
    const gateway = fakeGateway(
      says("Hi, Ann."),
      says("Hi, Bo."),
      says("Still here.")
    );
    const ann = await memberAnsweredBy(idp, gateway);
    const bo = await memberAnsweredBy(idp, gateway);

    await post(messageFrom(ann.teams, { text: "Hello" }));
    await post(messageFrom(bo.teams, { text: "Hello" }));
    await post(messageFrom(ann.teams, { text: "Are you there?" }));

    const [annChats, boChats] = await Promise.all([
      chatsOf(ann.userId),
      chatsOf(bo.userId),
    ]);
    expect(annChats).toHaveLength(1);
    expect(boChats).toHaveLength(1);
    expect(annChats[0]?.id).not.toBe(boChats[0]?.id);
    const said = async (conversation: string) => {
      const answers = await answersIn(conversation);
      return answers.map((answer) =>
        ["Hi, Ann.", "Hi, Bo.", "Still here."].find((text) =>
          answer.includes(text)
        )
      );
    };
    await expect(said(ann.teams.conversation)).resolves.toStrictEqual([
      "Hi, Ann.",
      "Still here.",
    ]);
    await expect(said(bo.teams.conversation)).resolves.toStrictEqual([
      "Hi, Bo.",
    ]);
  });

  it("shows Stephen typing while the turn runs, before the answer", async () => {
    const { reply, release } = pausedReply(says("All done."), 3);
    const { teams } = await member(idp, reply);

    const posting = post(messageFrom(teams));
    // Typing is shown at once, and again every few seconds.
    await expect
      .poll(
        async () => {
          const { activities } = await reached(teams.conversation);
          return activities;
        },
        {
          timeout: 10_000,
        }
      )
      .toContainEqual(expect.objectContaining({ type: "typing" }));
    release();
    await posting;

    const { activities } = await reached(teams.conversation);
    const types = activities.map(({ type }) => type);
    expect(types.at(-1)).toBe("message");
    expect(types.indexOf("typing")).toBeLessThan(types.indexOf("message"));
  });
});

describe("a turn that can't answer", setUpTime, () => {
  it("ends in Stephen's line, in the language the question was asked in", async () => {
    const { teams } = await member(idp, {
      status: 500,
      errorType: "api_error",
    });

    await post(
      messageFrom(teams, { text: "Wat staat er morgen in mijn agenda?" })
    );

    const { lines } = await reached(teams.conversation);
    expect(lines).toStrictEqual([
      "Er ging iets mis en ik kon niet antwoorden. Probeer het zo opnieuw.",
    ]);
  });

  it("asks for text when a message has none", async () => {
    const { teams, gateway } = await member(idp);

    await post(messageFrom(teams, { text: "" }));

    const { lines } = await reached(teams.conversation);
    expect(lines).toStrictEqual([
      "I can only read text for now. Type your question, and I'll answer it.",
    ]);
    expect(gateway.requests).toHaveLength(0);
  });
});
