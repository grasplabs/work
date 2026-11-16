import type { RosterInput } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { SourceRef } from "../src/brain-next.ts";
import {
  brainExportFile,
  brainExportStatus,
  listSourcesAs,
  listVersionsAs,
  readSourceVersionAs,
  recallAs,
  startBrainExport,
  workBrain,
} from "../src/brain-next.ts";
import { producersOf, relayHandOvers } from "../src/brain-sources.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { answering, onLink } from "./interview-link.ts";
import { agree, fact, openLink, team } from "./onboarding-team.ts";
import { auditedDuring, signedInApi, unique } from "./sign-in.ts";

// The company's teams in the new Brain (GRA-1748): each team taking part on
// the staff list the admin confirmed, with how many people it has, as one
// source the company's admins read, a new version at each confirmed
// change. The ways it can fail, from the threat model on the issue and
// review round 1 of #2344:
//
// - What a team does reaching the Brain: a lead's map writes it, a model's
//   answer from that one person's interview, so a fact of theirs would
//   reach whoever reads the source, and outlive their delete or withdrawal.
// - A map drawing timing one person's interview in the admin's audit log.
// - A person on the list reaching the source: their name, address or title.
// - Anyone but the company's admins reading it.
// - A list the admin saved without confirming, a team switched off, or one
//   still waiting for the admin's confirmation, reaching the Brain.
// - A save that changes nothing writing a version or an audit event.

const idp = mockIdp();

/** A word for one test, lower case as the reads are searched for it. */
const markerOf = (kind: string): string => `zq${kind}${unique()}`;

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

/** Every version of the company's teams `userId` may read, as text. */
const versionsOf = async (userId: string): Promise<string[]> => {
  const { versions } = await listVersionsAs(env, userId, { source: roster });
  const read = await Promise.all(
    versions.map(
      async ({ version }) =>
        await readSourceVersionAs(env, userId, { source: roster, version })
    )
  );
  return read.flatMap((each) => (each === null ? [] : [each.text]));
};

/** Everything `userId` reads that could hold `word`: recall by it, the Sources listing and every version of the teams, as one lower-case text. */
const readOf = async (userId: string, word: string): Promise<string> => {
  const { items } = await recallAs(env, userId, {
    question: word,
    budget: { tokens: 2000 },
    personal: true,
  });
  const { sources } = await listSourcesAs(env, userId);
  return JSON.stringify({
    items,
    sources,
    versions: await versionsOf(userId),
  }).toLowerCase();
};

/** The company's export of the Brain, written, as one lower-case text. */
const exported = async (): Promise<string> => {
  const { id } = await startBrainExport(env);
  for (let tick = 0; tick < 20; tick += 1) {
    // oxlint-disable-next-line no-await-in-loop -- until the export is written
    const status = await brainExportStatus(env, { id });
    if (status?.state !== "writing") {
      break;
    }
    clock.at = Math.max(clock.at, Date.now()) + 1;
    // oxlint-disable-next-line no-await-in-loop -- one tick at a time
    await workBrain(env, new Date(clock.at), producersOf(env));
  }
  const written = await brainExportStatus(env, { id });
  if (written?.state !== "done") {
    throw new Error("The export was never written.");
  }
  const files = await Promise.all(
    written.files.map(
      async (file) => (await brainExportFile(env, { id, file })) ?? ""
    )
  );
  return files.join("\n").toLowerCase();
};

/** A staff list: `team` of two, the marked person leading it, and `other` of one. */
const rosterWith = (
  words: {
    team: string;
    other: string;
    person: string;
    email: string;
    title: string;
  },
  { off = false }: { off?: boolean } = {}
): RosterInput => ({
  teams: [
    { id: "bakery", name: words.team, lead: "ann", does: "Bakes bread" },
    { id: "shop", name: words.other, lead: null, off },
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

/** Where each of a test's words is on its staff list. */
const kinds = ["team", "other", "person", "email", "title"] as const;

const markers = () => ({
  team: markerOf("team"),
  other: markerOf("other"),
  person: markerOf("person"),
  email: markerOf("mail"),
  title: markerOf("title"),
});

describe("the company's teams in the new Brain", { timeout: 180_000 }, () => {
  it("never hands over what a lead's map says a team does, nor times a drawing in the audit log, before or after the lead deletes their interview", async () => {
    const [admin, member] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const ids = await team();
    const store = onboardingStore(env);
    await store.releaseDue();
    const marker = markerOf("lead");
    await agree(ids.lea, [
      fact(
        "l1",
        "work",
        `Lea Lind alone handles the ${marker} dispute for our biggest client.`
      ),
    ]);
    // The lead's map, as the model draws it from her interview.
    const drawing = await auditedDuring(async () => {
      await answering(
        [
          {
            text: JSON.stringify({
              does: `Lea Lind handles the ${marker} dispute`,
              works: [],
            }),
            inputTokens: 1,
            outputTokens: 1,
          },
        ],
        async () => await store.drawNext()
      );
    });
    await handOverNow();
    const before = {
      member: await readOf(member.userId, marker),
      admin: await readOf(admin.userId, marker),
      page: JSON.stringify(await member.api.brain.read()).toLowerCase(),
      exported: await exported(),
    };

    // She deletes her interview.
    await onLink({ action: "delete", ...(await openLink(ids.lea)) });
    await store.releaseDue();
    await handOverNow();
    const after = {
      member: await readOf(member.userId, marker),
      admin: await readOf(admin.userId, marker),
      page: JSON.stringify(await member.api.brain.read()).toLowerCase(),
      exported: await exported(),
    };
    const held = (read: Record<string, string>) =>
      Object.entries(read).flatMap(([where, text]) =>
        text.includes(marker) || text.includes("lea lind") ? [where] : []
      );

    expect({
      before: held(before),
      after: held(after),
      drawingHandedOver: drawing.filter(
        ({ action }) => action === "onboarding.roster.brain_source"
      ).length,
    }).toStrictEqual({ before: [], after: [], drawingHandedOver: 0 });
  });

  it("gives the company's admins the confirmed teams taking part and their sizes, never who is in them, and nobody else anything of them", async () => {
    const [admin, member] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const words = markers();
    // Saved, not confirmed: nothing is handed over.
    await admin.api.onboarding.saveRoster(rosterWith(words));
    await handOverNow();
    const unconfirmed = await readOf(admin.userId, words.team);

    // Confirmed, the other team switched off.
    await admin.api.onboarding.confirmRoster(rosterWith(words, { off: true }));
    await handOverNow();
    const confirmed = await readOf(admin.userId, words.team);
    const asMember = {
      versions: await versionsOf(member.userId),
      read: await readOf(member.userId, words.team),
    };
    const events = JSON.stringify(await allEvents()).toLowerCase();
    const found = (read: string) =>
      kinds.filter((kind) => read.includes(words[kind]));

    expect({
      unconfirmed: found(unconfirmed),
      confirmed: found(confirmed),
      sized: confirmed.includes(`${words.team}: 2 people`),
      member: { versions: asMember.versions, found: found(asMember.read) },
      logged: found(events),
    }).toStrictEqual({
      unconfirmed: [],
      // Not the switched-off team, nor anyone on the list.
      confirmed: ["team"],
      sized: true,
      member: { versions: [], found: [] },
      logged: [],
    });
  });

  it("keeps each confirmed change a version, and a confirmed save that changes nothing writes none and notes nothing", async () => {
    const admin = await signedInApi(idp, "admin");
    const words = markers();
    await admin.api.onboarding.confirmRoster(rosterWith(words));
    await handOverNow();
    const first = await versionsOf(admin.userId);

    // The same list confirmed again.
    const again = await auditedDuring(async () => {
      await admin.api.onboarding.confirmRoster(rosterWith(words));
    });
    await handOverNow();
    const unchanged = await versionsOf(admin.userId);

    // Renamed, and one more person in it.
    const renamed = markerOf("renamed");
    const changed = rosterWith({ ...words, team: renamed });
    await admin.api.onboarding.confirmRoster({
      ...changed,
      people: [
        ...changed.people,
        { id: "dee", name: "Dee Dough", team: "bakery", title: "Baker" },
      ],
    });
    await handOverNow();
    const last = await versionsOf(admin.userId);
    const read = await readOf(admin.userId, renamed);
    const current = read.includes(`${renamed}: 3 people`);

    expect({
      againNoted: again.filter(
        ({ action }) => action === "onboarding.roster.brain_source"
      ).length,
      unchanged: unchanged.length - first.length,
      added: last.length - unchanged.length,
      // The earlier name stays as history.
      history: last.some((text) => text.toLowerCase().includes(words.team)),
      current,
    }).toStrictEqual({
      againNoted: 0,
      unchanged: 0,
      added: 1,
      history: true,
      current: true,
    });
  });
});
