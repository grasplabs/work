import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { inTeams } from "../src/channels/inert.ts";
import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { keptAnswersOf, pausedReply, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { attacks, ordinary } from "./inert-answers.ts";
import { fakeProvider } from "./model-provider.ts";
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

// A member's Teams message answered by the organization's agent in their
// own Teams chat in Grasp (src/channels/answer.ts): the turn runs in their
// own Workspace object, with the model provider faked behind connect, and the
// answer goes back through connect to the fake Bot Connector
// (test/bot-connector-fake.ts) on one card, the model's words as written,
// with every link form Teams reads broken (src/channels/inert.ts).

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
  return (
    activities
      .filter(({ type }) => type === "message")
      .map((activity) => JSON.stringify(activity))
      // Not the card offering their own Microsoft 365 (connect-own.ts).
      .filter((activity) => !activity.includes("/connect-microsoft"))
  );
};

describe("a member's question", setUpTime, () => {
  it("is answered in their own Teams chat, labelled as made by AI", async () => {
    const { userId, teams } = await member(
      idp,
      says("Leave lasts sixteen weeks.")
    );

    await post(messageFrom(teams, { text: "How long is parental leave?" }));

    const chats = await chatsOf(userId);
    expect(chats).toMatchObject([{ title: "Microsoft Teams", via: "teams" }]);
    // The answer, on its card.
    const answers = await answersIn(teams.conversation);
    const answer = answers.join("\n");
    expect({
      answered: answer.includes("Leave lasts sixteen weeks"),
      // Labelled as made by AI, as Teams shows it.
      aiLabel: answer.includes("AIGeneratedContent"),
    }).toStrictEqual({
      answered: true,
      aiLabel: true,
    });
  });

  it("goes on in the same chat, and another person's stays apart", async () => {
    const provider = await fakeProvider(
      says("Hi, Ann."),
      says("Hi, Bo."),
      says("Still here.")
    );
    const ann = await memberAnsweredBy(idp, provider);
    const bo = await memberAnsweredBy(idp, provider);

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
    // Each answer, by its words: not the thumbs that follow a streamed one.
    const said = async (conversation: string) => {
      const answers = await answersIn(conversation);
      return answers.flatMap((answer) =>
        ["Hi, Ann.", "Hi, Bo.", "Still here."].filter((text) =>
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
    const { teams, provider } = await member(idp);

    await post(messageFrom(teams, { text: "" }));

    const { lines } = await reached(teams.conversation);
    expect(lines).toStrictEqual([
      "I can only read text for now. Type your question, and I'll answer it.",
    ]);
    expect(provider.requests).toHaveLength(0);
  });
});

/** What a Teams activity carries that these tests read. */
const activitySchema = z
  .object({
    text: z.string().optional(),
    attachments: z
      .array(
        z
          .object({
            content: z
              .object({
                body: z
                  .array(z.object({ text: z.string().optional() }).loose())
                  .optional(),
              })
              .loose()
              .optional(),
          })
          .loose()
      )
      .optional(),
    entities: z
      .array(z.object({ streamType: z.string().optional() }).loose())
      .optional(),
  })
  .loose();

/** What Teams was sent in `conversation`, each activity as read here. */
const activitiesIn = async (conversation: string) => {
  const { activities } = await reached(conversation);
  return activities.map((activity) => activitySchema.parse(activity));
};

/** The first `TextBlock` of each card Teams was sent in `conversation`. */
const cardTextsIn = async (conversation: string): Promise<string[]> => {
  const activities = await activitiesIn(conversation);
  return activities.flatMap(({ attachments = [] }) =>
    attachments.flatMap(({ content }) => {
      const text = content?.body?.[0]?.text;
      return text === undefined ? [] : [text];
    })
  );
};

/** Where a card's text would still read as an inline link or a definition. */
const linkForm = /\]\(|\]:/u;

describe("a member's answer with links the model wrote", setUpTime, () => {
  it("is only ever a card showing them as written, every link form broken, in a private chat and a group chat, and kept as written", async () => {
    const ann = await member(idp, says(attacks), says(attacks));
    const group = newGroup();
    await onGroupRoster(group, [{ person: ann.teams }]);

    await post(messageFrom(ann.teams, { text: "How does leave work?" }));
    await post(mentionIn(ann.teams, group, "How does leave work?"));

    const answers = async (conversation: string) => {
      const texts = await cardTextsIn(conversation);
      return texts.filter((text) => text.startsWith("Read"));
    };
    const [inPrivate, inGroup] = [
      await answers(ann.teams.conversation),
      await answers(group),
    ];
    const activities = [
      ...(await activitiesIn(ann.teams.conversation)),
      ...(await activitiesIn(group)),
    ];
    expect({
      // Never Teams' own stream, nor message text, which renders HTML,
      // images and links: only the card's `TextBlock`, which reads no
      // HTML or images.
      streamed: activities.some(({ entities = [] }) =>
        entities.some(({ streamType }) => streamType !== undefined)
      ),
      inText: activities.some(
        ({ text }) => text?.includes("evil.com") === true
      ),
      // The card as it ends: the model's words, each link form broken.
      cards: [inPrivate.at(-1), inGroup.at(-1)],
      // Nothing posted, the cards updated while written included, holds
      // a form a card reads as a link.
      linkForms: [...inPrivate, ...inGroup].filter((text) =>
        linkForm.test(text)
      ),
      kept: await keptAnswersOf(ann.userId),
    }).toStrictEqual({
      streamed: false,
      inText: false,
      cards: [inTeams(attacks), inTeams(attacks)],
      linkForms: [],
      kept: [[attacks], [attacks]],
    });
  });

  it("keeps an ordinary answer's words and formatting, nothing escaped", async () => {
    const { teams } = await member(idp, says(ordinary));

    await post(messageFrom(teams, { text: "How does leave work?" }));

    const cards = await cardTextsIn(teams.conversation);
    expect(cards.findLast((text) => text.includes("Leave"))).toBe(ordinary);
  });
});
