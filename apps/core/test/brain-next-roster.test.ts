import type { RosterInput } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

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
import { copyOfStore, restoreStore } from "./brain-next-store-copy.ts";
import { mockIdp } from "./idp.ts";
import { aloneInTheStore, answering, onLink } from "./interview-link.ts";
import { agree, fact, openLink, team } from "./onboarding-team.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// The company's teams in the new Brain (GRA-1748): each team taking part on
// the staff list the admin confirmed, as the admin described it, with its
// head count on the roster, as one source everyone in the company reads
// (the owner, 17 November), a new version at each hand-over after a
// confirmed change; the admin may erase it, and what members read with it. The ways it can fail, from the threat model on the
// issue and review round 1 of #2344:
//
// - What a lead's map says a team does reaching anyone: a model's answer
//   from that one person's interview, so a fact of theirs would reach
//   everyone, and outlive their delete or withdrawal.
// - A map drawing timing one person's interview in the admin's audit log.
// - A person on the list reaching the source: their name, address or title.
// - A list the admin saved without confirming, a team switched off, or one
//   still waiting for the admin's confirmation, reaching members.
// - A save that changes nothing writing a version or an audit event.
// - An erase leaving any version readable, coming back after a restore, or
//   closing the key the next confirmed save needs.

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

/** The company's teams' source in the Brain now. */
const rosterNow = async (): Promise<SourceRef> => ({
  producer: "roster",
  id: await onboardingStore(env).rosterBrainId(),
});

/** Every version of `source` `userId` may read, as text. */
const versionsIn = async (
  userId: string,
  source: SourceRef
): Promise<string[]> => {
  const { versions } = await listVersionsAs(env, userId, { source });
  const read = await Promise.all(
    versions.map(
      async ({ version }) =>
        await readSourceVersionAs(env, userId, { source, version })
    )
  );
  return read.flatMap((each) => (each === null ? [] : [each.text]));
};

/** Every version `userId` may read of every source of the company's teams they list. */
const versionsOf = async (userId: string): Promise<string[]> => {
  const { sources } = await listSourcesAs(env, userId);
  const rosters = sources.filter(({ source }) => source.producer === "roster");
  const texts = await Promise.all(
    rosters.map(async ({ source }) => await versionsIn(userId, source))
  );
  return texts.flat();
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
  // The tests draw the maps themselves, each with the model's answer it
  // gives: the store's own alarm drawing one first, with no answer to
  // give, would put it off.
  beforeEach(aloneInTheStore);

  it("never gives anyone what a lead's map says a team does, nor times a drawing in the audit log, and takes it from staff too when the lead deletes their interview", async () => {
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
    // A confirmed save after the drawing hands the teams over again.
    const { roster } = await store.view();
    if (roster === null) {
      throw new Error("No roster.");
    }
    await admin.api.onboarding.confirmRoster(roster);
    await handOverNow();
    const readNow = async () => ({
      member: await readOf(member.userId, marker),
      admin: await readOf(admin.userId, marker),
      page: JSON.stringify(await member.api.brain.read()).toLowerCase(),
      exported: await exported(),
    });
    const before = await readNow();
    // Grasp's staff still read the map's words, as before (admin-snapshot.ts);
    // the company's admin's own roster never holds them as theirs.
    const asMapped = JSON.stringify(await store.rosterAsMapped());
    const adminView = JSON.stringify(await admin.api.onboarding.view());

    // She deletes her interview.
    await onLink({ action: "delete", ...(await openLink(ids.lea)) });
    await store.releaseDue();
    await handOverNow();
    const after = await readNow();
    // Nor do staff any more: the map's words were drawn from her interview.
    const asMappedAfter = JSON.stringify(await store.rosterAsMapped());
    const held = (read: Record<string, string>) =>
      Object.entries(read).flatMap(([where, text]) =>
        text.includes(marker) || text.includes("lea lind") ? [where] : []
      );

    expect({
      staff: asMapped.includes(marker),
      staffAfter: asMappedAfter.includes(marker),
      adminRoster: adminView.includes(marker),
      before: held(before),
      after: held(after),
      drawingHandedOver: drawing.filter(
        ({ action }) => action === "onboarding.roster.brain_source"
      ).length,
    }).toStrictEqual({
      staff: true,
      staffAfter: false,
      adminRoster: false,
      before: [],
      after: [],
      drawingHandedOver: 0,
    });
  });

  it("takes what a lead's map says a team does from staff when the lead withdraws", async () => {
    const ids = await team();
    const store = onboardingStore(env);
    await store.releaseDue();
    const marker = markerOf("lead");
    await agree(ids.lea, [
      fact("l1", "work", "Max, Mia and Mo handle new tickets every morning."),
    ]);
    await answering(
      [
        {
          text: JSON.stringify({
            does: `Handles the ${marker} tickets`,
            works: [],
          }),
          inputTokens: 1,
          outputTokens: 1,
        },
      ],
      async () => await store.drawNext()
    );
    const mapped = async () => {
      const roster = await store.rosterAsMapped();
      return roster?.teams.find(({ id }) => id === ids.team)?.does;
    };
    const before = await mapped();

    await onLink({ action: "withdraw", ...(await openLink(ids.lea)) });

    expect({ before, after: await mapped() }).toStrictEqual({
      before: `Handles the ${marker} tickets`,
      // What the admin wrote, which is nothing here.
      after: "",
    });
  });

  it("takes what a lead's map says a team does from staff when the lead takes back an approval, and when a redraw says nothing", async () => {
    const ids = await team();
    const store = onboardingStore(env);
    await store.releaseDue();
    const tickets = fact("l1", "work", "Max, Mia and Mo handle new tickets.");
    const rota = fact("l2", "work", "Lea plans the rota every Friday.");
    /** Draws the team's map, the model saying the team does `does`. */
    const draw = async (does: string): Promise<void> => {
      await answering(
        [
          {
            text: JSON.stringify({ does, works: [] }),
            inputTokens: 1,
            outputTokens: 1,
          },
        ],
        async () => await store.drawNext()
      );
    };
    const mapped = async () => {
      const roster = await store.rosterAsMapped();
      return roster?.teams.find(({ id }) => id === ids.team)?.does;
    };
    const first = markerOf("lead");
    let version = await agree(ids.lea, [tickets]);
    await draw(`Handles the ${first} tickets`);
    const drawn = await mapped();

    // She agrees to more: drawn again, the model saying nothing of it.
    version = await agree(ids.lea, [tickets, rota], version);
    await draw("");
    const redrawnEmpty = await mapped();

    // Drawn once more, then she takes the rota's approval back.
    const second = markerOf("lead");
    version = await agree(
      ids.lea,
      [tickets, rota, fact("l3", "work", "Mo orders the paper.")],
      version
    );
    await draw(`Handles the ${second} tickets`);
    const drawnAgain = await mapped();
    await agree(ids.lea, [tickets], version);
    const takenBack = await mapped();

    expect({ drawn, redrawnEmpty, drawnAgain, takenBack }).toStrictEqual({
      drawn: `Handles the ${first} tickets`,
      redrawnEmpty: "",
      drawnAgain: `Handles the ${second} tickets`,
      takenBack: "",
    });
  });

  it("gives every member the confirmed teams taking part, as the admin described them, with their head counts, never who is in them", async () => {
    const [admin, member] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const words = markers();
    // Saved, not confirmed: nothing reaches a member.
    await admin.api.onboarding.saveRoster(rosterWith(words));
    await handOverNow();
    const unconfirmed = {
      read: await readOf(member.userId, words.team),
      page: JSON.stringify(await member.api.brain.read()).toLowerCase(),
    };

    // Confirmed, the other team switched off.
    await admin.api.onboarding.confirmRoster(rosterWith(words, { off: true }));
    await handOverNow();
    const read = await readOf(member.userId, words.team);
    const page = await member.api.brain.read();
    const bakery = page.teams.find(({ id }) => id === "team-bakery");
    const events = JSON.stringify(await allEvents()).toLowerCase();
    const found = (text: string) =>
      kinds.filter((kind) => text.includes(words[kind]));

    expect({
      unconfirmed: [...found(unconfirmed.read), ...found(unconfirmed.page)],
      read: found(read),
      sized: read.includes(`${words.team}: 2 people. bakes bread`),
      page: {
        shown: found(JSON.stringify(page).toLowerCase()),
        bakery: {
          does: bakery?.does,
          people: bakery?.counts.map(({ people }) => people),
          stakeholders: bakery?.stakeholders,
        },
      },
      logged: found(events),
    }).toStrictEqual({
      unconfirmed: [],
      // Not the switched-off team, nor anyone on the list.
      read: ["team"],
      sized: true,
      page: {
        shown: ["team"],
        bakery: { does: "Bakes bread", people: [2], stakeholders: [] },
      },
      logged: [],
    });
  });

  it("keeps each confirmed change a version, and a confirmed save that changes nothing writes none and notes nothing", async () => {
    const [admin, member] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const words = markers();
    await admin.api.onboarding.confirmRoster(rosterWith(words));
    await handOverNow();
    const first = await versionsOf(member.userId);

    // The same list confirmed again.
    const again = await auditedDuring(async () => {
      await admin.api.onboarding.confirmRoster(rosterWith(words));
    });
    await handOverNow();
    const unchanged = await versionsOf(member.userId);

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
    const last = await versionsOf(member.userId);
    const read = await readOf(member.userId, renamed);

    expect({
      againNoted: again.filter(
        ({ action }) => action === "onboarding.roster.brain_source"
      ).length,
      unchanged: unchanged.length - first.length,
      added: last.length - unchanged.length,
      // The earlier name stays as history.
      history: last.some((text) => text.toLowerCase().includes(words.team)),
      current: read.includes(`${renamed}: 3 people`),
    }).toStrictEqual({
      againNoted: 0,
      unchanged: 0,
      added: 1,
      history: true,
      current: true,
    });
  });

  it("keeps the confirmed teams when the admin saves an edit without confirming it", async () => {
    const [admin, member] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const words = markers();
    await admin.api.onboarding.confirmRoster(rosterWith(words));
    await handOverNow();
    const confirmed = await versionsOf(member.userId);

    // The same team renamed and described anew, saved but not confirmed.
    const renamed = markerOf("renamed");
    const described = markerOf("does");
    const edited = rosterWith({ ...words, team: renamed });
    await admin.api.onboarding.saveRoster({
      ...edited,
      teams: edited.teams.map((each) =>
        each.id === "bakery" ? { ...each, does: `Bakes ${described}` } : each
      ),
    });
    await handOverNow();
    const read = await readOf(member.userId, words.team);
    const page = JSON.stringify(await member.api.brain.read()).toLowerCase();
    const after = await versionsOf(member.userId);

    expect({
      added: after.length - confirmed.length,
      current: read.includes(`${words.team}: 2 people. bakes bread`),
      edited: [read, page].some(
        (text) => text.includes(renamed) || text.includes(described)
      ),
      page: page.includes(words.team),
    }).toStrictEqual({ added: 0, current: true, edited: false, page: true });
  });

  it("gives the Brain a version saying no team takes part once the admin switches every team off", async () => {
    const [admin, member] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const words = markers();
    await admin.api.onboarding.confirmRoster(rosterWith(words));
    await handOverNow();
    const source = await rosterNow();
    const list = rosterWith(words);
    await admin.api.onboarding.confirmRoster({
      ...list,
      teams: list.teams.map((each) => ({ ...each, off: true })),
    });
    await handOverNow();
    const { versions } = await listVersionsAs(env, member.userId, { source });
    const newest = Math.max(...versions.map(({ version }) => version));
    const current = await readSourceVersionAs(env, member.userId, {
      source,
      version: newest,
    });
    const page = await member.api.brain.read();

    expect({
      current: current?.text.toLowerCase().includes(words.team),
      none: current?.text.includes("No team takes part"),
      page: page.teams.some(({ name }) => name === words.team),
    }).toStrictEqual({ current: false, none: true, page: false });
  });

  it("refuses a member's erase, and keeps the teams in the Brain", async () => {
    const [admin, member] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const words = markers();
    await admin.api.onboarding.confirmRoster(rosterWith(words));
    await handOverNow();

    const refused = await outcome(member.api.onboarding.eraseTeamsFromBrain());
    const read = await readOf(member.userId, words.team);
    const { teamsInBrain } = await admin.api.onboarding.view();

    expect({
      refused,
      kept: read.includes(words.team),
      inBrain: teamsInBrain,
    }).toStrictEqual({ refused: "role.forbidden", kept: true, inBrain: "in" });
  });

  it("erases every version when the admin erases the teams, also after a restore, keeps the roster, and gives them afresh at the next confirmed save", async () => {
    const [admin, member] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const words = markers();
    await admin.api.onboarding.confirmRoster(rosterWith(words));
    await handOverNow();
    const renamed = markerOf("renamed");
    await admin.api.onboarding.confirmRoster(
      rosterWith({ ...words, team: renamed })
    );
    await handOverNow();
    const erased = await rosterNow();
    const before = await readOf(member.userId, words.team);
    const copy = await copyOfStore();

    const events = await auditedDuring(async () => {
      await admin.api.onboarding.eraseTeamsFromBrain();
    });
    const holds = async (word: string): Promise<boolean> => {
      const read = await readOf(member.userId, word);
      return read.includes(word);
    };
    const view = await admin.api.onboarding.view();
    const page = await member.api.brain.read();
    const afterErase = {
      read: await holds(words.team),
      renamed: await holds(renamed),
      versions: await versionsIn(member.userId, erased),
      // The roster itself stays; members' page shows no team until the
      // next confirmed save.
      roster: view.roster?.teams.map(({ name }) => name),
      page: page.teams.some(({ name }) => name === renamed),
      inBrain: view.teamsInBrain,
    };
    await restoreStore(copy);
    const afterRestore = {
      read: await holds(renamed),
      versions: await versionsIn(member.userId, erased),
    };
    // The next confirmed save, the same list: given afresh, under a new id.
    await admin.api.onboarding.confirmRoster(
      rosterWith({ ...words, team: renamed })
    );
    await handOverNow();
    const fresh = await rosterNow();
    const freshVersions = await versionsIn(member.userId, fresh);
    const freshPage = await member.api.brain.read();
    const logged = JSON.stringify(events).toLowerCase();

    expect({
      before: before.includes(words.team),
      afterErase,
      afterRestore,
      fresh: {
        own: fresh.id !== erased.id,
        versions: freshVersions.length,
        read: await holds(renamed),
        page: freshPage.teams.some(({ name }) => name === renamed),
      },
      audited: events
        .filter(({ action }) => action === "onboarding.roster.brain_erased")
        .map(({ actor }) => actor.type),
      logged: logged.includes(words.team) || logged.includes(renamed),
    }).toStrictEqual({
      before: true,
      afterErase: {
        read: false,
        renamed: false,
        versions: [],
        roster: [renamed, words.other],
        page: false,
        inBrain: null,
      },
      afterRestore: { read: false, versions: [] },
      fresh: { own: true, versions: 1, read: true, page: true },
      audited: ["person"],
      logged: false,
    });
  });
});
