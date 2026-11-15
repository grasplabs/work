import type { ChatUpdate } from "@grasp-os/shared/chat";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { keptAnswersOf, pausedReply, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
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
// (test/bot-connector-fake.ts) on one card, without the links, images and
// HTML the model wrote (src/channels/without-links.ts).

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

/** An answer the model was steered into writing links, an image and HTML in. */
const linked = [
  'Read [the policy](https://evil.com/p?d=secret "t"), ![chart](https://evil.com/c.png) and <a href="https://evil.com/a">here</a>.',
  "Code: `[x](https://evil.com/x)`; ask hr@acme.example or see www.acme.example.",
].join("\n\n");

/** `linked` as Grasp keeps it: links as their words, the image as its alt. */
const kept = [
  "Read the policy, chart and here.",
  "Code: `[x](https://evil.com/x)`; ask hr@acme.example or see www.acme.example.",
].join("\n\n");

/** What a Teams activity carries that these tests read. */
const activitySchema = z
  .object({
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

/** The stream kinds Teams was sent in `conversation`, if any. */
const streamedIn = async (conversation: string): Promise<string[]> => {
  const activities = await activitiesIn(conversation);
  return activities.flatMap(({ entities = [] }) =>
    entities.flatMap(({ streamType }) =>
      streamType === undefined ? [] : [streamType]
    )
  );
};

describe("a member's answer with links the model wrote", setUpTime, () => {
  it("ends on one card, never in Teams' own stream, without them, in a private chat and a group chat, as Grasp keeps it", async () => {
    const ann = await member(idp, says(linked), says(linked));
    const group = newGroup();
    await onGroupRoster(group, [{ person: ann.teams }]);

    await post(messageFrom(ann.teams, { text: "How does leave work?" }));
    await post(mentionIn(ann.teams, group, "How does leave work?"));

    const all = JSON.stringify([
      await reached(ann.teams.conversation),
      await reached(group),
    ]);
    const answers = async (conversation: string) => {
      const texts = await cardTextsIn(conversation);
      return texts.filter((text) => text.startsWith("Read"));
    };
    const [inPrivate, inGroup] = [
      await answers(ann.teams.conversation),
      await answers(group),
    ];
    expect({
      // No stream of Teams' own.
      streamed: [
        ...(await streamedIn(ann.teams.conversation)),
        ...(await streamedIn(group)),
      ],
      // Its card as it ends: in the private chat, it was written into it
      // as the model wrote, every update cleaned too (channels-stream).
      cards: [inPrivate.at(-1), inGroup.at(-1)],
      inertWhileWritten: [...inPrivate, ...inGroup].every(
        (text) => !text.includes("](") && !text.includes("evil.com/p")
      ),
      // Nothing the model linked, showed or marked up, in any form Teams
      // reads; the code's own words stay, with no link form left.
      linked: ["evil.com/p", "c.png", "evil.com/a", "<a ", "]("].filter(
        (found) => all.includes(found)
      ),
      kept: await keptAnswersOf(ann.userId),
    }).toStrictEqual({
      streamed: [],
      cards: [kept.replace("](", "] ("), kept.replace("](", "] (")],
      inertWhileWritten: true,
      linked: [],
      kept: [[kept], [kept]],
    });
  });

  it("is kept and posted as the same words when the answer starts indented, which would be code until trimmed", async () => {
    const { userId, teams } = await member(
      idp,
      says("    [the form](https://evil.example/?d=1) is due Friday.")
    );

    await post(messageFrom(teams, { text: "When is the form due?" }));

    const shown = "the form is due Friday.";
    const cards = await cardTextsIn(teams.conversation);
    expect({
      card: cards.findLast((text) => text.includes("Friday")),
      kept: await keptAnswersOf(userId),
    }).toStrictEqual({ card: shown, kept: [[shown]] });
  });

  it("shows in Grasp's own view of the chat, while the model still writes, only what it keeps", async () => {
    // Paused once the paragraph with the link, the image and the HTML is
    // written, before the next.
    const { reply, release } = pausedReply(
      says(linked),
      linked.indexOf("\n\nCode")
    );
    const { userId, teams } = await member(idp, reply);
    const posting = post(messageFrom(teams, { text: "How does leave work?" }));
    await expect
      .poll(async () => await chatsOf(userId), { timeout: 15_000 })
      .toHaveLength(1);
    const [chat] = await chatsOf(userId);
    const shown = Promise.withResolvers<string>();
    await workspace(env, personalWorkspaceId(userId)).watch(
      chat?.id,
      userId,
      null,
      async (update: ChatUpdate) => {
        if ((update.partial?.text ?? "") !== "") {
          shown.resolve(update.partial?.text ?? "");
        }
        await Promise.resolve();
      }
    );
    const partial = await shown.promise;
    release();
    await posting;
    expect({
      partial,
      streamed: await streamedIn(teams.conversation),
    }).toStrictEqual({
      partial: "Read the policy, chart and here.",
      streamed: [],
    });
  });
});
