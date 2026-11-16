import type { RosterInput } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { SourceRef } from "../src/brain-next.ts";
import {
  listSourcesAs,
  listVersionsAs,
  readSourceVersionAs,
  recallAs,
  workBrain,
} from "../src/brain-next.ts";
import { producersOf, relayHandOvers } from "../src/brain-sources.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi, unique } from "./sign-in.ts";

// The company's teams in the new Brain (GRA-1748): each team on the staff
// list, what it does and how many people it has, as one source readable by
// everyone, a new version at each change. The ways it can fail, from the
// threat model on the issue:
//
// - A person on the list reaching every member through it: their name,
//   address or title, or who leads a team.
// - A change of the list not reaching the Brain, or written over: a team's
//   new name or size missing, or its history gone.
// - Its words in the audit log.

const idp = mockIdp();

/** A word for one test, lower case as the reads are searched for it. */
const markerOf = (kind: string): string => `zq${kind}${unique()}`;

/** The words a test's staff list holds, each where only it is. */
interface Markers {
  /** A team's name. */
  team: string;
  /** What that team does. */
  does: string;
  /** A person's name. */
  person: string;
  /** A person's address. */
  email: string;
  /** A person's title. */
  title: string;
}

const kinds = ["team", "does", "person", "email", "title"] as const;

const markers = (): Markers => ({
  team: markerOf("team"),
  does: markerOf("does"),
  person: markerOf("person"),
  email: markerOf("mail"),
  title: markerOf("title"),
});

/** A staff list holding `words`: their team of two, led by the marked person, and another of one. */
const rosterOf = (words: Markers): RosterInput => ({
  teams: [
    { id: "bakery", name: words.team, lead: "ann", does: words.does },
    { id: "shop", name: "Shop", lead: null },
  ],
  people: [
    {
      id: "ann",
      name: `Ann ${words.person}`,
      email: `${words.email}@acme.test`,
      team: "bakery",
      title: `Head ${words.title}`,
    },
    { id: "ben", name: "Ben Baker", team: "bakery", title: "Baker" },
    { id: "cas", name: "Cas Clerk", team: "shop", title: "Clerk" },
  ],
});

/** The queue's clock across this file: only forward, as core's clock goes. */
const clock = { at: Date.now() };

/** Hands over what the onboarding noted, as core does: its outbox drained, relayed, and the Brain worked. */
const handOverNow = async (): Promise<void> => {
  await allEvents();
  await relayHandOvers(env);
  clock.at = Math.max(clock.at, Date.now()) + 1;
  await workBrain(env, new Date(clock.at), producersOf(env));
};

/** The company's teams' source in the Brain. */
const roster: SourceRef = { producer: "roster", id: "teams" };

/** Everything `userId` reads of the company's teams: recalled texts by `word`, listed first lines, and every version's text. */
const readOf = async (userId: string, word: string): Promise<string> => {
  const { items } = await recallAs(env, userId, {
    question: word,
    budget: { tokens: 2000 },
    personal: true,
  });
  const { sources } = await listSourcesAs(env, userId);
  const listed = sources.filter(({ source }) => source.producer === "roster");
  const { versions } = await listVersionsAs(env, userId, { source: roster });
  const texts = await Promise.all(
    versions.map(
      async ({ version }) =>
        await readSourceVersionAs(env, userId, { source: roster, version })
    )
  );
  return JSON.stringify({ items, listed, texts }).toLowerCase();
};

/** What of `words` reached `read`, by which. */
const reached = (read: string, words: Markers): (keyof Markers)[] =>
  kinds.filter((kind) => read.includes(words[kind]));

describe("the company's teams in the new Brain", { timeout: 120_000 }, () => {
  it("gives every member the teams, what each does and its size, never who is in them, and keeps each change a version", async () => {
    const [admin, member] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const words = markers();
    await admin.api.onboarding.saveRoster(rosterOf(words));
    await handOverNow();
    const first = await readOf(member.userId, words.team);
    const { versions: before } = await listVersionsAs(env, member.userId, {
      source: roster,
    });

    // The team renamed, and someone added to it: a new version.
    const renamed = markerOf("renamed");
    const changed = rosterOf({ ...words, team: renamed });
    await admin.api.onboarding.saveRoster({
      ...changed,
      people: [
        ...changed.people,
        { id: "dee", name: "Dee Dough", team: "bakery", title: "Baker" },
      ],
    });
    await handOverNow();
    const { versions: after } = await listVersionsAs(env, member.userId, {
      source: roster,
    });
    const current = await readSourceVersionAs(env, member.userId, {
      source: roster,
      version: Math.max(...after.map(({ version }) => version)),
    });
    const events = JSON.stringify(await allEvents()).toLowerCase();
    const afterRead = await readOf(member.userId, renamed);

    expect({
      reached: reached(first, words),
      sized: first.includes(`${words.team}: 2 people`),
      added: after.length - before.length,
      // The earlier name stays as history, readable by everyone.
      history: afterRead.includes(words.team),
      current: {
        renamed: current?.text.includes(`${renamed}: 3 people`),
        shop: current?.text.includes("Shop: 1 person"),
      },
      logged: [...kinds.map((kind) => words[kind]), renamed].filter((word) =>
        events.includes(word)
      ),
    }).toStrictEqual({
      reached: ["team", "does"],
      sized: true,
      added: 1,
      history: true,
      current: { renamed: true, shop: true },
      logged: [],
    });
  });
});
