import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { keptAnswersOf, pausedReply, says } from "./agent-chat.ts";
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
// Stephen's line, on a card. Each step waits for what the card shows, never
// on the clock: the model's stream stops at each pause until let go.

const idp = mockIdp();

watched();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** What a Teams activity carries that these tests read. */
const activitySchema = z
  .object({
    type: z.string(),
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
 * the id it updated if it is an update, whether it is a card, and the
 * words it shows (its card's first text, or its own text).
 */
const messagesIn = async (conversation: string) => {
  const { sent } = await reached(conversation);
  return sent.flatMap(({ activity, id, editOf }) => {
    const {
      type,
      attachments,
      text,
      entities = [],
    } = activitySchema.parse(activity);
    // Not the card offering their own Microsoft 365 (connect-own.ts).
    if (
      (type !== "message" && editOf === undefined) ||
      JSON.stringify(activity).includes("/connect-microsoft")
    ) {
      return [];
    }
    const cardText = attachments?.[0]?.content?.body?.[0]?.text;
    return [
      {
        id,
        editOf,
        card: cardText !== undefined,
        words: cardText ?? text ?? "",
        streamed: entities.some(({ streamType }) => streamType !== undefined),
      },
    ];
  });
};

/** Waits, within a bound, for the card in `conversation` to show `words`. */
const cardShows = async (conversation: string, words: string) => {
  await expect
    .poll(
      async () => {
        const messages = await messagesIn(conversation);
        return messages.at(-1)?.words;
      },
      { timeout: 15_000, message: `the card to show ${JSON.stringify(words)}` }
    )
    .toBe(words);
};

/** Each pause of a reply, and a way to let it go. */
const pausesAt = (points: readonly number[]) =>
  points.map((at) => {
    const until = Promise.withResolvers<boolean>();
    return {
      pause: { at, until: until.promise },
      release: () => {
        until.resolve(true);
      },
    };
  });

/** Where an address, a link form the card reads, or HTML would show. */
const linking = /evil\.com|\]\(|<a |<img|!\[/u;

/** Consecutive repeats of `words` taken out: what the card showed in turn. */
const inTurn = (words: readonly string[]): string[] =>
  words.filter((each, at) => each !== words[at - 1]);

describe("an answer written into its card", setUpTime, () => {
  it("is one card updated in place, showing at each chunk's end only words it keeps, the last update whole and as Grasp keeps it", async () => {
    const answer = [
      'Leave lasts [sixteen weeks](https://evil.com/leave?d=secret "t") in all. ![chart](https://evil.com/c.png) and <a href="https://evil.com/a">the form</a>.',
      "Ask [your lead] first.",
      "[your lead]: https://evil.com/lead",
    ].join("\n\n");
    const kept =
      "Leave lasts sixteen weeks in all. chart and the form.\n\nAsk your lead first.";
    // Mid-label, mid-address, mid-image, mid-tag, and before a reference's
    // late definition; and what the card shows at each: a link, image or
    // tag still open is held back until it closes.
    const stops = [
      [answer.indexOf("weeks]"), "Leave lasts"],
      [answer.indexOf("evil.com/leave"), "Leave lasts"],
      [
        answer.indexOf("](https://evil.com/c.png"),
        "Leave lasts sixteen weeks in all.",
      ],
      [
        answer.indexOf('evil.com/a">'),
        "Leave lasts sixteen weeks in all. chart and",
      ],
      [
        answer.indexOf("[your lead]:"),
        "Leave lasts sixteen weeks in all. chart and the form.\n\nAsk [your lead] first.",
      ],
    ] as const;
    const pauses = pausesAt(stops.map(([at]) => at));
    const reply: ProviderReply = {
      ...says(answer),
      pause: pauses.map(({ pause }) => pause),
    };
    const { userId, teams } = await member(idp, reply);

    const posting = post(messageFrom(teams, { text: "How does leave work?" }));
    for (const [index, [, words]] of stops.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- chunk by chunk
      await cardShows(teams.conversation, words);
      pauses[index]?.release();
    }
    await posting;

    const messages = await messagesIn(teams.conversation);
    const [card] = messages;
    expect({
      // Its first post, then updates of that card alone, showing in turn
      // what each chunk's end showed, then the whole answer.
      firstIsAPost: card?.editOf === undefined,
      updatesOfIt: messages.slice(1).every(({ editOf }) => editOf === card?.id),
      shown: inTurn(messages.map(({ words }) => words)),
      streamed: messages.some(({ streamed }) => streamed),
      linking: messages.filter(({ words }) => linking.test(words)),
      kept: await keptAnswersOf(userId),
    }).toStrictEqual({
      firstIsAPost: true,
      updatesOfIt: true,
      shown: [...inTurn(stops.map(([, words]) => words)), kept],
      streamed: false,
      linking: [],
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
    await cardShows(teams.conversation, "Parental leave lasts sixteen weeks.");
    await providers().fetch(botConnectorEditsUrl, {
      method: "POST",
      body: JSON.stringify({ conversation: teams.conversation, count: 1 }),
    });
    pause?.release();
    await posting;

    const messages = await messagesIn(teams.conversation);
    const [first] = messages;
    expect({
      shown: inTurn(messages.map(({ words }) => words)),
      posts: messages.filter(({ editOf }) => editOf === undefined).length,
      kept: await keptAnswersOf(userId),
    }).toStrictEqual({
      shown: ["Parental leave lasts sixteen weeks.", answer],
      posts: 1,
      kept: [[answer]],
    });
    expect(messages.at(-1)?.editOf).toBe(first?.id);
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
    await cardShows(teams.conversation, "Parental leave lasts sixteen weeks.");
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

  it("ends its card as Stephen's line, on a card, when the turn fails after its first words", async () => {
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
    await cardShows(teams.conversation, "Let me look that up.");
    pause?.release();
    await posting;

    const messages = await messagesIn(teams.conversation);
    const [card] = messages;
    const last = messages.findLast(({ editOf }) => editOf === card?.id);
    expect({
      posts: messages
        .filter(({ editOf }) => editOf === undefined)
        .map(({ words: shown }) => shown),
      last: [last?.card, last?.words],
    }).toStrictEqual({
      posts: ["Let me look that up."],
      last: [
        true,
        "Something went wrong, and I couldn't answer. Try again in a moment.",
      ],
    });
  });

  it("says Stephen's line, once, when the turn is refused before any words", async () => {
    // A turn of the chat's under way, held before its answer, so the
    // person's message is refused as the chat being busy.
    const { reply, release } = pausedReply(says("Still on it."), 3);
    const { userId, teams, provider } = await member(idp, reply);
    const first = workspace(env, personalWorkspaceId(userId)).askThrough(
      userId,
      chatAgentId,
      "teams",
      "What's on today?",
      { kind: "direct" }
    );
    await expect
      .poll(() => provider.requests.length, { timeout: 15_000 })
      .toBe(1);

    await post(messageFrom(teams, { text: "How does leave work?" }));
    release();
    await first;

    const messages = await messagesIn(teams.conversation);
    expect(messages.map(({ words, editOf }) => [words, editOf])).toStrictEqual([
      ["The AI model is busy right now. Try again in a minute.", undefined],
    ]);
  });
});
