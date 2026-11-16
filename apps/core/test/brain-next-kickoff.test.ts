import { brainOf } from "@grasp-os/brain-next/contract";
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
import { inJurisdiction } from "../src/durable-objects.ts";
import {
  eraseOwedKickoffs,
  settleOnboardingBrain,
} from "../src/onboarding/new-brain.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { adminKickoff } from "./admin-kickoff.ts";
import { allEvents } from "./audit-events.ts";
import { erasuresFailing } from "./brain-erasures-failing.ts";
import { copyOfStore, restoreStore } from "./brain-next-store-copy.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// The kickoff in the new Brain (GRA-1748): what every member reads of it,
// the vision and the teams it named, as one source readable by everyone,
// a new version at each save and answer; the admin's delete erases it,
// every version. The ways it can fail, from the threat model on the issue:
//
// - The transcript, or a field only staff and admins read (what the
//   company does), reaching members through it.
// - The kickoff readable after the admin's delete: an older version, a
//   hand-over noted before the delete landing after it, or a restore of
//   an older copy of the Brain's store bringing it back.
// - A delete whose erasure failed reading as done, or never finishing.
// - A kickoff brought in after a delete landing under the closed key, and
//   so never reaching the Brain.
// - Its words in the audit log.

const idp = mockIdp();

/** A word for one test, lower case as the reads are searched for it. */
const markerOf = (kind: string): string => `zq${kind}${unique()}`;

/** The words the kickoff of one test holds, each where only it is. */
interface Markers {
  /** In the transcript alone. */
  transcript: string;
  /** In what the company does, which only staff and admins read. */
  business: string;
  /** In the goals, which every member reads, as the vision. */
  goals: string;
  /** The name of a team it named, as the transcript names it. */
  team: string;
}

const markers = (): Markers => ({
  transcript: markerOf("talk"),
  business: markerOf("biz"),
  goals: markerOf("goal"),
  team: markerOf("team"),
});

/** Staff bring in a kickoff holding `words`, read by the fake provider. */
const bringIn = async (words: Markers): Promise<void> => {
  await fakeProvider({
    text: JSON.stringify({
      fields: [
        {
          field: "business",
          text: `We run ${words.business} bakeries.`,
          quote: "We run bakeries",
          ask: "",
        },
        {
          field: "goals",
          text: `Bread from ${words.goals} in every town.`,
          quote: "Bread in every town",
          ask: "",
        },
      ],
      teams: [{ name: words.team, does: "Baking", people: 6 }],
      sponsor: "Anna",
      onboarding: [],
    }),
    inputTokens: 900,
    outputTokens: 300,
  });
  await adminKickoff().saveKickoff({
    locale: "en",
    transcript: {
      text: `Anna (CEO): We run bakeries and say ${words.transcript} a lot.
Anna (CEO): We want bread in every town within two years.
Anna (CEO): Our ${words.team} team of 6 bakes through the night.
Jakob (Grasp): What takes the most time?
Anna (CEO): Counting the flour by hand every morning, and the orders by phone.`,
    },
  });
};

/** The queue's clock across this file: only forward, as core's clock goes. */
const clock = { at: Date.now() };

/** Hands over what the onboarding noted, as core does: its outbox drained, relayed, and the Brain worked. */
const handOverNow = async (): Promise<void> => {
  await allEvents();
  await relayHandOvers(env);
  clock.at = Math.max(clock.at, Date.now()) + 1;
  await workBrain(env, new Date(clock.at), producersOf(env));
};

/** The kickoff's source in the Brain, by the store's id for it now. */
const kickoffNow = async (): Promise<SourceRef> => ({
  producer: "kickoff",
  id: await onboardingStore(env).kickoffBrainId(),
});

/** Where the shared store has `source`'s key: held, erased, or free. */
const keyOf = async (source: SourceRef) =>
  await brainOf(inJurisdiction(env, env.BRAIN_STORE)).keyState(
    `${source.producer}:${source.id}`
  );

/** Everything `userId` reads of the kickoff's sources: recalled texts by `word`, listed first lines, and every version's text. */
const readOf = async (userId: string, word: string): Promise<string> => {
  const { items } = await recallAs(env, userId, {
    question: word,
    budget: { tokens: 2000 },
    personal: true,
  });
  const { sources } = await listSourcesAs(env, userId);
  const kickoffs = sources.filter(
    ({ source }) => source.producer === "kickoff"
  );
  const versions = await Promise.all(
    kickoffs.map(async ({ source }) => {
      const { versions: listed } = await listVersionsAs(env, userId, {
        source,
      });
      return await Promise.all(
        listed.map(
          async ({ version }) =>
            await readSourceVersionAs(env, userId, { source, version })
        )
      );
    })
  );
  return JSON.stringify({ items, kickoffs, versions }).toLowerCase();
};

/** Where each of a test's words is in its kickoff. */
const kinds = ["transcript", "business", "goals", "team"] as const;

/** What of `words` reached `read`, by which. */
const reached = (read: string, words: Markers): (keyof Markers)[] =>
  kinds.filter((kind) => read.includes(words[kind]));

/** Where the admin's onboarding says the kickoff is. */
const kickoffState = async (
  admin: Awaited<ReturnType<typeof signedInApi>>
): Promise<unknown> => {
  const view = await admin.api.onboarding.view();
  return view.kickoff;
};

describe("the kickoff in the new Brain", { timeout: 120_000 }, () => {
  it("gives every member its vision and teams as one source, a new version at each change, never the transcript or what the company does", async () => {
    const member = await signedInApi(idp, "user");
    const words = markers();
    await bringIn(words);
    await handOverNow();
    const source = await kickoffNow();
    const answer = markerOf("pain");
    await adminKickoff().answerKickoff("pain", `Night shifts at ${answer}.`);
    await handOverNow();

    const read = await readOf(member.userId, words.goals);
    const { versions } = await listVersionsAs(env, member.userId, { source });
    const first = await readSourceVersionAs(env, member.userId, {
      source,
      version: 1,
    });
    const events = JSON.stringify(await allEvents()).toLowerCase();

    expect({
      reached: reached(read, words),
      answered: read.includes(answer),
      versions: versions
        .map(({ version }) => version)
        .toSorted((a, b) => a - b),
      // The version before the answer stays as history, without it.
      firstAnswered: first?.text.toLowerCase().includes(answer),
      logged: [...kinds.map((kind) => words[kind]), answer].filter((word) =>
        events.includes(word)
      ),
    }).toStrictEqual({
      reached: ["goals", "team"],
      answered: true,
      versions: [1, 2],
      firstAnswered: false,
      logged: [],
    });
  });

  it("hands over no version for an answer outside the vision, and one saying nothing is known once the only answer is taken back", async () => {
    const member = await signedInApi(idp, "user");
    // A kickoff that read nothing of the vision and named no team.
    await fakeProvider({
      text: JSON.stringify({ fields: [], teams: [], onboarding: [] }),
      inputTokens: 900,
      outputTokens: 300,
    });
    await adminKickoff().saveKickoff({
      locale: "en",
      transcript: {
        text: `Anna (CEO): We run bakeries in Utrecht and in the towns around it.
Jakob (Grasp): What takes the most time?
Anna (CEO): Counting the flour by hand every morning, and the orders by phone.
Jakob (Grasp): And who does that?
Anna (CEO): Whoever opens the shop that day, before the first customers come in.`,
      },
    });
    await handOverNow();
    const source = await kickoffNow();
    // An earlier test's kickoff may be the same source: counted from here.
    const versionsOf = async (): Promise<number> => {
      const { versions } = await listVersionsAs(env, member.userId, {
        source,
      });
      return versions.length;
    };
    const first = await versionsOf();

    // Not the vision: members read nothing of it, so nothing is handed over.
    const languages = markerOf("lang");
    const languagesNoted = await auditedDuring(async () => {
      await adminKickoff().answerKickoff(
        "languages",
        `Dutch and ${languages}.`
      );
    });
    await handOverNow();
    const afterLanguages = await versionsOf();

    const answer = markerOf("pain");
    await adminKickoff().answerKickoff("pain", `Night shifts at ${answer}.`);
    await handOverNow();
    const answeredRead = await readOf(member.userId, answer);
    const answered = answeredRead.includes(answer);
    // Taken back: the vision says nothing again, and the Brain follows.
    await adminKickoff().answerKickoff("pain", "");
    await handOverNow();
    const { items } = await recallAs(env, member.userId, {
      question: answer,
      budget: { tokens: 2000 },
      personal: true,
    });

    const languagesRead = await readOf(member.userId, languages);

    expect({
      afterLanguages: afterLanguages - first,
      languagesHandedOver: languagesNoted.filter(
        ({ action }) => action === "onboarding.kickoff.brain_source"
      ).length,
      answered,
      added: (await versionsOf()) - first,
      recalled: items.some(({ text }) => text.includes(answer)),
      languagesRead: languagesRead.includes(languages),
    }).toStrictEqual({
      afterLanguages: 0,
      languagesHandedOver: 0,
      answered: true,
      // The answer, then the vision saying nothing again.
      added: 2,
      recalled: false,
      languagesRead: false,
    });
  });

  it("erases every version when the admin deletes the kickoff, also after a restore, and keeps a later kickoff a source of its own", async () => {
    const [admin, member] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const words = markers();
    await bringIn(words);
    await handOverNow();
    await adminKickoff().answerKickoff("pain", `Ovens at ${words.goals}.`);
    await handOverNow();
    const deleted = await kickoffNow();
    const copy = await copyOfStore();

    await admin.api.onboarding.deleteKickoff();
    const afterDelete = {
      read: reached(await readOf(member.userId, words.goals), words),
      key: await keyOf(deleted),
    };
    await restoreStore(copy);
    const afterRestore = {
      read: reached(await readOf(member.userId, words.goals), words),
      key: await keyOf(deleted),
    };
    const fresh = markers();
    await bringIn(fresh);
    await handOverNow();
    const later = await kickoffNow();

    expect({
      afterDelete,
      afterRestore,
      later: {
        own: later.id !== deleted.id,
        read: reached(await readOf(member.userId, fresh.goals), fresh),
        key: await keyOf(later),
      },
    }).toStrictEqual({
      afterDelete: { read: [], key: "erased" },
      afterRestore: { read: [], key: "erased" },
      later: { own: true, read: ["goals", "team"], key: "held" },
    });
  });

  it("never adds a kickoff whose hand-over was noted before the admin deleted it", async () => {
    const [admin, member] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const words = markers();
    // Noted for the hand-over, which hasn't run yet.
    await bringIn(words);
    const source = await kickoffNow();

    await admin.api.onboarding.deleteKickoff();
    await handOverNow();

    expect({
      read: reached(await readOf(member.userId, words.goals), words),
      key: await keyOf(source),
    }).toStrictEqual({ read: [], key: "erased" });
  });

  it("keeps a delete's erasure owed while the Brain fails it, saying the kickoff is erasing, until the admin asks again or core's clock runs", async () => {
    const [admin, member] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const store = onboardingStore(env);

    // Finished by the admin asking again.
    const asked = markers();
    await bringIn(asked);
    await handOverNow();
    const first = await kickoffNow();
    await store.deleteKickoff({ type: "system" });
    const failed = await eraseOwedKickoffs(erasuresFailing());
    const meanwhile = {
      view: await kickoffState(admin),
      read: reached(await readOf(member.userId, asked.goals), asked),
    };
    const again = await outcome(admin.api.onboarding.deleteKickoff());
    const afterAgain = {
      view: await kickoffState(admin),
      read: reached(await readOf(member.userId, asked.goals), asked),
      key: await keyOf(first),
    };

    // Finished by core's clock.
    const ticked = markers();
    await bringIn(ticked);
    await handOverNow();
    const second = await kickoffNow();
    await store.deleteKickoff({ type: "system" });
    await eraseOwedKickoffs(erasuresFailing());
    await settleOnboardingBrain(env);

    expect({
      failed,
      meanwhile,
      again,
      afterAgain,
      clock: {
        view: await kickoffState(admin),
        read: reached(await readOf(member.userId, ticked.goals), ticked),
        key: await keyOf(second),
      },
    }).toStrictEqual({
      failed: false,
      // The kickoff is gone from the onboarding; the Brain still holds it.
      meanwhile: { view: "erasing", read: ["goals", "team"] },
      again: "ok",
      afterAgain: { view: null, read: [], key: "erased" },
      clock: { view: null, read: [], key: "erased" },
    });
  });
});
