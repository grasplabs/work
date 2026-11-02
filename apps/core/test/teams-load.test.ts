import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { answeringProvider } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import {
  memberAnsweredBy,
  messageFrom,
  post,
  reached,
  watched,
} from "./teams-door.ts";

// Stephen at a 500-person client, its door's path at rate (GRA-732): 50
// people writing at once through the door (src/channels/door.ts), each
// turn in their own Workspace, each answer back through the real connect
// to the fake Bot Connector. The model echoes each question's own mark,
// so an answer that reached the wrong person, or none, shows.
//
// 500 people's turns at once are for a staging client, with budgets and
// limits on: workerd runs one isolate here, and signing in 500 people
// would take the suite's whole budget.

const idp = mockIdp();

watched();

/** How many people write at once. */
const people = 50;

/** Signing 50 people in and running their turns at once takes a while. */
const loadTime = { timeout: 600_000 };

/** The mark a question carries, and its answer repeats. */
const markPattern = /load-question-[\da-f-]+/gu;

/** An answer to the question the request asks: its mark, said back. */
const echo = (body: unknown): ProviderReply => {
  const marks = JSON.stringify(body).match(markPattern) ?? [];
  const mark = marks.at(-1) ?? "no-mark";
  const text = `Answer for ${mark}.`;
  return { text, inputTokens: 40, outputTokens: text.length };
};

describe("the door at a 500-person client", loadTime, () => {
  it("answers 50 people writing at once, each in their own chat with their own answer, none lost", async () => {
    const provider = await answeringProvider((requests) =>
      echo(requests.at(-1)?.body)
    );
    const members = [];
    for (let index = 0; index < people; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- the mock IdP signs one in at a time
      members.push(await memberAnsweredBy(idp, provider));
    }
    const asked = members.map(({ teams }) => ({
      teams,
      mark: `load-question-${crypto.randomUUID()}`,
    }));

    const statuses = await Promise.all(
      asked.map(
        async ({ teams, mark }) =>
          await post(messageFrom(teams, { text: `What about ${mark}?` }))
      )
    );

    const answered = await Promise.all(
      asked.map(async ({ teams, mark }) => {
        // An answer is a card: its words are in the activity, not its text.
        const { activities } = await reached(teams.conversation);
        const marks = activities
          .filter(({ type }) => type === "message")
          .flatMap(
            (activity) => JSON.stringify(activity).match(markPattern) ?? []
          );
        // A card says its answer's mark once in each of its renderings.
        const distinct = new Set(marks);
        return { own: distinct.has(mark), marks: distinct.size };
      })
    );
    expect({
      // The door answers Teams at once, whatever follows.
      accepted: statuses.filter((status) => status === 200).length,
      // Each person's chat has one answer, and it's to their own question.
      ownAnswers: answered.filter(({ own }) => own).length,
      strays: answered.filter(({ marks }) => marks !== 1).length,
    }).toStrictEqual({ accepted: people, ownAnswers: people, strays: 0 });
  });
});
