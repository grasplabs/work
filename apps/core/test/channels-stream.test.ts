import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { keptAnswersOf, says } from "./agent-chat.ts";
import { botConnectorEditsUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import type { ProviderReply } from "./model-provider.ts";
import {
  member,
  messageFrom,
  post,
  providers,
  reached,
  watched,
} from "./teams-door.ts";

// An answer written into a member's private Teams chat as the model
// writes its words (src/channels/answer.ts): one Adaptive Card, posted
// once there are words to show and then updated in place, never a second
// message and never Teams' own stream. Every update is the answer so far
// cleaned as the whole answer is (src/channels/without-links.ts), so no
// update holds a link, an image or HTML the model wrote, wherever a chunk
// ends; the last is the whole answer, as Grasp keeps it. An update Teams
// refuses leaves the card as it was; a turn that fails ends the card as
// Stephen's line.

const idp = mockIdp();

watched();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

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

/**
 * The messages Teams was sent in `conversation`, in order: each one's id,
 * the id it updated if it is an update, and the words it shows (its
 * card's first text, or its own text).
 */
const messagesIn = async (conversation: string) => {
  const { sent } = await reached(conversation);
  return sent.flatMap(({ activity, id, editOf }) => {
    const {
      attachments,
      text,
      entities = [],
      ...rest
    } = activitySchema.parse(activity);
    if (rest.type !== "message" && editOf === undefined) {
      return [];
    }
    return [
      {
        id,
        editOf,
        words: attachments?.[0]?.content?.body?.[0]?.text ?? text ?? "",
        streamed: entities.some(({ streamType }) => streamType !== undefined),
      },
    ];
  });
};

/** Each pause of a reply, and a way to wait for it and let it go. */
const pausesAt = (points: readonly number[]) =>
  points.map((at) => {
    const got = Promise.withResolvers<boolean>();
    const until = Promise.withResolvers<boolean>();
    return {
      pause: {
        at,
        until: until.promise,
        reached: () => {
          got.resolve(true);
        },
      },
      reached: got.promise,
      release: () => {
        until.resolve(true);
      },
    };
  });

/** Waits long enough for the card to take the words before a pause. */
const anUpdateLater = async (): Promise<void> => {
  await scheduler.wait(1200);
};

/** Where an address, a link form the card reads, or HTML would show. */
const linking = /evil\.com|\]\(|<a |<img|!\[/u;

describe("an answer written into its card", setUpTime, () => {
  it("is one card updated in place, no update holding a link, image or HTML, wherever a chunk ends, the last one whole and as Grasp keeps it", async () => {
    const answer = [
      'Leave lasts [sixteen weeks](https://evil.com/leave?d=secret "t") in all. ![chart](https://evil.com/c.png) and <a href="https://evil.com/a">the form</a>.',
      "Ask [your lead] first.",
      "[your lead]: https://evil.com/lead",
    ].join("\n\n");
    const kept =
      "Leave lasts sixteen weeks in all. chart and the form.\n\nAsk your lead first.";
    // Mid-label, mid-address, mid-image, mid-tag, and before a reference's
    // late definition.
    const pauses = pausesAt([
      answer.indexOf("weeks]"),
      answer.indexOf("evil.com/leave"),
      answer.indexOf("](https://evil.com/c.png"),
      answer.indexOf('evil.com/a">'),
      answer.indexOf("[your lead]:"),
    ]);
    const reply: ProviderReply = {
      ...says(answer),
      pause: pauses.map(({ pause }) => pause),
    };
    const { userId, teams } = await member(idp, reply);

    const posting = post(messageFrom(teams, { text: "How does leave work?" }));
    for (const { reached: there, release } of pauses) {
      // oxlint-disable-next-line no-await-in-loop -- chunk by chunk
      await there;
      // oxlint-disable-next-line no-await-in-loop -- chunk by chunk
      await anUpdateLater();
      release();
    }
    await posting;

    const messages = await messagesIn(teams.conversation);
    const ofAnswer = messages.filter(
      ({ id, editOf }) =>
        editOf !== undefined || messages.some((other) => other.editOf === id)
    );
    const [card] = ofAnswer;
    expect({
      // Its first post, then updates of that card alone.
      posts: ofAnswer.filter(({ editOf }) => editOf === undefined).length,
      updatesOfIt: ofAnswer.slice(1).every(({ editOf }) => editOf === card?.id),
      updates: ofAnswer.length > 2,
      streamed: messages.some(({ streamed }) => streamed),
      linking: ofAnswer.filter(({ words }) => linking.test(words)),
      last: ofAnswer.at(-1)?.words,
      kept: await keptAnswersOf(userId),
    }).toStrictEqual({
      posts: 1,
      updatesOfIt: true,
      updates: true,
      streamed: false,
      linking: [],
      last: kept,
      kept: [[kept]],
    });
  });

  it("keeps its card as it was when Teams refuses an update, and still ends it whole", async () => {
    const answer =
      "Parental leave lasts sixteen weeks. You take it in one go, or in two parts.";
    const [pause] = pausesAt([answer.indexOf("You take")]);
    const { userId, teams } = await member(idp, {
      ...says(answer),
      pause: pause?.pause,
    });

    const posting = post(messageFrom(teams, { text: "How does leave work?" }));
    await pause?.reached;
    await anUpdateLater();
    await providers().fetch(botConnectorEditsUrl, {
      method: "POST",
      body: JSON.stringify({ conversation: teams.conversation, count: 1 }),
    });
    pause?.release();
    await posting;

    const messages = await messagesIn(teams.conversation);
    const [first] = messages;
    expect({
      first: first?.words,
      posts: messages
        .filter(({ words }) => words.startsWith("Parental"))
        .filter(({ editOf }) => editOf === undefined).length,
      last: messages.findLast(({ editOf }) => editOf === first?.id)?.words,
      kept: await keptAnswersOf(userId),
    }).toStrictEqual({
      first: "Parental leave lasts sixteen weeks.",
      posts: 1,
      last: answer,
      kept: [[answer]],
    });
  });

  it("posts the answer whole, once, when Teams refuses every try of its card's last update", async () => {
    const answer =
      "Parental leave lasts sixteen weeks. You take it in one go, or in two parts.";
    const [pause] = pausesAt([answer.indexOf("You take")]);
    const { teams } = await member(idp, {
      ...says(answer),
      pause: pause?.pause,
    });

    const posting = post(messageFrom(teams, { text: "How does leave work?" }));
    await pause?.reached;
    await anUpdateLater();
    await providers().fetch(botConnectorEditsUrl, {
      method: "POST",
      body: JSON.stringify({ conversation: teams.conversation, count: 100 }),
    });
    pause?.release();
    await posting;

    const messages = await messagesIn(teams.conversation);
    const posts = messages.filter(
      ({ editOf, words }) =>
        editOf === undefined && words.startsWith("Parental")
    );
    expect(posts.map(({ words }) => words)).toStrictEqual([
      "Parental leave lasts sixteen weeks.",
      answer,
    ]);
  });

  it("ends its card as Stephen's line when the turn fails after its first words", async () => {
    const words = "Let me look [that](https://evil.com/x) up.";
    const [pause] = pausesAt([words.length]);
    const { teams } = await member(
      idp,
      {
        text: words,
        toolCalls: [
          {
            id: `call_${crypto.randomUUID()}`,
            name: "executeCode",
            arguments: { code: "export default async () => 1;" },
          },
        ],
        inputTokens: 200,
        outputTokens: 40,
        pause: pause?.pause,
      },
      { status: 500, errorType: "api_error" }
    );

    const posting = post(messageFrom(teams, { text: "Look it up." }));
    await pause?.reached;
    await anUpdateLater();
    pause?.release();
    await posting;

    const messages = await messagesIn(teams.conversation);
    const [card] = messages;
    expect({
      first: card?.words,
      posts: messages
        .filter(({ editOf }) => editOf === undefined)
        .map(({ words: shown }) => shown),
      last: messages.findLast(({ editOf }) => editOf === card?.id)?.words,
    }).toStrictEqual({
      first: "Let me look that up.",
      posts: ["Let me look that up."],
      last: "Something went wrong, and I couldn't answer. Try again in a moment.",
    });
  });
});
