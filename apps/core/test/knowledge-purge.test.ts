import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import {
  documentsIn,
  erasing,
  holding,
  purged,
  rebuildFailingOnce,
  rememberAs,
  saveOver,
  setUpTime,
} from "./knowledge-purge.ts";
import {
  newTeam,
  ownCollectionOf,
  seed,
  storedVersionTexts as versionTexts,
} from "./knowledge.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// Purging a person from Knowledge, as their erasure does (person-erasure.ts
// `purgeFromKnowledge`). These tests start from the ways it can fail: their
// text survives somewhere (an earlier version, a section, a title, the
// search index's pages, a memory); the purge record in the audit log,
// which can't be purged, carries the text it removed; it reaches
// collections that aren't theirs alone; or a failed cleanup reads as done.

const idp = mockIdp();

const personOf = async (role: Role) => await signedInApi(idp, role);

/** Whether the purge `purgeId` is recorded as finished. */
const purgeComplete = async (purgeId: string): Promise<boolean> => {
  const row = await env.KNOWLEDGE.prepare(
    "SELECT completed_at IS NOT NULL AS done FROM brain_purges WHERE id = ?"
  )
    .bind(purgeId)
    .first<{ done: number }>();
  return row?.done === 1;
};

describe("a personal purge", setUpTime, () => {
  it("erases every collection only the person reads, however many they made, with every version, from everywhere", async () => {
    const admin = await personOf("admin");
    const leaver = await personOf("user");
    const secret = `vanderzwaluw${unique()}`;
    const notes = await ownCollectionOf(leaver);
    const { id: diary } = await seed(leaver.api).createCollection({
      name: `Diary ${unique()}`,
      access: "me",
    });
    await saveOver(leaver, notes, "about.md", `# About me\nI am ${secret}.`);
    await saveOver(
      leaver,
      notes,
      "about.md",
      `# About me\nI am ${secret}, on leave.`,
      `Learned ${secret} is on leave`
    );
    await saveOver(leaver, diary, "monday.md", `# Monday\n${secret} again.`);
    await rememberAs(leaver, `${secret} prefers mornings.`);
    const heldBefore = await holding(secret);

    let outcomeOf: Awaited<ReturnType<typeof purged>> | undefined;
    await erasing(admin, leaver.userId);
    const events = await auditedDuring(async () => {
      outcomeOf = await purged(admin, leaver.userId);
    });

    expect({
      heldBefore: heldBefore.length > 0,
      result: {
        ...outcomeOf,
        purgeId: typeof outcomeOf?.purgeId,
      },
      notes: await documentsIn(notes),
      diary: await documentsIn(diary),
      held: await holding(secret),
      purged: events
        .filter(({ action }) => action === "knowledge.purged")
        .map(({ detail }) => ({
          collections: detail.collections,
          documents: detail.documents,
          versions: detail.versions,
        })),
      carriesText: JSON.stringify(events).includes(secret),
    }).toStrictEqual({
      heldBefore: true,
      result: { purgeId: "string", documents: 2, versions: 3 },
      notes: "no collection",
      diary: "no collection",
      held: [],
      purged: [{ collections: 2, documents: 2, versions: 3 }],
      carriesText: false,
    });
  });

  it("leaves another person's collection only they read, and the team's and everyone's collections the person made or wrote in, as they were", async () => {
    const admin = await personOf("admin");
    // An admin, who may make collections for a team or for everyone.
    const leaver = await personOf("admin");
    const stays = await personOf("user");
    const team = await newTeam(admin, [leaver, stays]);
    const secret = `brandsma${unique()}`;
    const theirs = await ownCollectionOf(stays);
    const kept = await saveOver(
      stays,
      theirs,
      "notes.md",
      `# Notes\nWorking with ${secret}.`
    );
    const { id: teamCollection } = await seed(admin.api).createCollection({
      name: `Team ${unique()}`,
      access: "teams",
      teams: [team],
    });
    const shared = await saveOver(
      leaver,
      teamCollection,
      "plan.md",
      `# Plan\n${secret} leads it.`
    );
    // Collections the person made and owns, for others to read too: the
    // company's, not theirs alone.
    const { id: theirTeams } = await seed(leaver.api).createCollection({
      name: `Handover ${unique()}`,
      access: "teams",
      teams: [team],
    });
    const forTeam = await saveOver(
      leaver,
      theirTeams,
      "handover.md",
      `# Handover\n${secret} hands over.`
    );
    await saveOver(
      leaver,
      theirTeams,
      "handover.md",
      `# Handover\n${secret} hands over, done.`
    );
    const { id: theirEveryone } = await seed(leaver.api).createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    const forEveryone = await saveOver(
      leaver,
      theirEveryone,
      "rules.md",
      `# Rules\nAsk ${secret}.`
    );
    await saveOver(
      leaver,
      await ownCollectionOf(leaver),
      "mine.md",
      `# Mine\n${secret}.`
    );

    const result = await purged(admin, leaver.userId);

    expect({
      documents: result.documents,
      theirs: await versionTexts(kept.id),
      team: await versionTexts(shared.id),
      theirTeams: await versionTexts(forTeam.id),
      theirEveryone: await versionTexts(forEveryone.id),
    }).toStrictEqual({
      documents: 1,
      theirs: [`# Notes\nWorking with ${secret}.`],
      team: [`# Plan\n${secret} leads it.`],
      theirTeams: [
        `# Handover\n${secret} hands over.`,
        `# Handover\n${secret} hands over, done.`,
      ],
      theirEveryone: [`# Rules\nAsk ${secret}.`],
    });
  });

  it("leaves nothing of a person whose text was only theirs, and can run again", async () => {
    const admin = await personOf("admin");
    const leaver = await personOf("user");
    const secret = `oudejans${unique()}`;
    await saveOver(
      leaver,
      await ownCollectionOf(leaver),
      "about.md",
      `# ${secret}\nCall me ${secret}.`
    );
    const first = await purged(admin, leaver.userId);
    const again = await purged(admin, leaver.userId);
    expect({
      first: first.documents,
      again: { ...again, purgeId: typeof again.purgeId },
      held: await holding(secret),
    }).toStrictEqual({
      first: 1,
      again: {
        purgeId: "string",
        documents: 0,
        versions: 0,
      },
      held: [],
    });
  });
});

describe("a purge whose index cleanup fails", setUpTime, () => {
  it("says the data is gone and a run again cleans up, for a person", async () => {
    const admin = await personOf("admin");
    const leaver = await personOf("user");
    const secret = `brouwer${unique()}`;
    await saveOver(
      leaver,
      await ownCollectionOf(leaver),
      "about.md",
      `# About me\nCall me ${secret}.`
    );
    const failing = await rebuildFailingOnce();
    const first = await outcome(purged(admin, leaver.userId, failing));
    const heldAfterFirst = await holding(secret);
    // The collection is gone already, but the index is cleaned up.
    const again = await purged(admin, leaver.userId);
    expect({
      first,
      heldAfterFirst,
      // The same purge, gone on with (GRA-1122): what it removed in all.
      again: again.documents,
      complete: await purgeComplete(again.purgeId),
      heldAfterAgain: await holding(secret),
    }).toStrictEqual({
      first: "knowledge.purge_index_pending",
      heldAfterFirst: ["search_words_data.block"],
      again: 1,
      complete: true,
      heldAfterAgain: [],
    });
  });
});
