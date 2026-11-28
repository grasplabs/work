import type { DirectoryPeople } from "@grasp-os/shared/directory";
import type { RosterInput } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import { landingAt } from "./d1-landing.ts";
import {
  connectedDirectory,
  connectedGoogleDirectory,
  directoryHolds,
  directoryUser as user,
  googleDirectoryHolds,
  googleDirectoryUser,
  googleId,
} from "./directory.ts";
import { mockIdp } from "./idp.ts";
import { runClockTask } from "./maintenance.ts";
import { teamsMade } from "./members-teams.ts";
import { acmeTenant, entraClient } from "./sign-in-config.ts";
import type { signedInApi } from "./sign-in.ts";
import {
  callAuth,
  entraPerson,
  googlePerson,
  outcome,
  signedIn,
  unique,
  whoami,
  withSignIn,
} from "./sign-in.ts";

// An entry of the onboarding's staff list tied to its person in the
// organization's directory (GRA-2249), from its threat model (on the
// issue): a tie only as core's own read named them, never a forged or
// swapped one from the browser; their erasure finds their entry by it and
// takes it off; who left the organization shows on the list, from the
// daily read and from a removal; the member who holds a role is found by
// it before they signed in. Graph and Google's Admin SDK are faked; core,
// connect and sign-in are the real ones. The tests share their storage,
// in order: the first runs before any daily read.

const idp = mockIdp();
const dayMs = 24 * 60 * 60 * 1000;

let days = 0;
/** A time past every read so far by more than a day: a read is due then. */
const nextDay = (): Date => {
  days += 2;
  return new Date(Date.now() + days * dayMs);
};

/** The clock's daily read of the directories. */
const dailyRead = async (changes: Partial<Env> = {}): Promise<void> => {
  await runClockTask("directory.people", changes, nextDay());
};

type Admin = Awaited<ReturnType<typeof signedInApi>>;

/** `oid` signing in with Microsoft, as a member: their user ID and name. */
const microsoftMember = async (oid: string) => {
  const person = entraPerson(acmeTenant, "acme.test", { oid });
  const session = await signedIn(idp, "microsoft", person, {
    coreEnv: withSignIn({
      entra: { tenantId: acmeTenant, clientId: entraClient.id },
    }),
  });
  const { userId } = await whoami(session);
  return { userId, name: String(person.name) };
};

/** Someone of the directory, as an entry of the list made of `read` has them. */
const entryOf = (
  read: DirectoryPeople,
  id: string,
  title = ""
): RosterInput["people"][number] => {
  const person = read.people.find((each) => each.id === id);
  const proof = read.proofs[id];
  if (person === undefined || proof === undefined) {
    throw new Error(`Expected ${id} in the read`);
  }
  return {
    id: `p-${id}`.slice(0, 60),
    name: person.name,
    email: person.email,
    team: "everyone",
    title,
    directory: { suite: read.suite, id, proof },
  };
};

/** Saves a list of `people`, all in one team, as the admin's browser does. */
const saveList = async (
  admin: Admin,
  people: RosterInput["people"]
): Promise<void> => {
  await admin.api.onboarding.saveRoster(
    await teamsMade({
      teams: [{ id: "everyone", name: `Everyone ${unique()}`, lead: null }],
      people,
    })
  );
};

/** The list as its admin sees it, by entry id: name, and whether they left. */
const listed = async (admin: Admin) => {
  const { roster } = await admin.api.onboarding.view();
  return Object.fromEntries(
    (roster?.people ?? []).map(({ id, name, left }) => [
      id,
      { name, left: left === true },
    ])
  );
};

/** Who each entry is tied to in the directory, as the store keeps it. */
const tiedIds = async () => {
  const ties = await onboardingStore(env).staffTies();
  return Object.fromEntries(ties.map(({ id, tie }) => [id, tie?.id ?? null]));
};

const idSchema = z.object({ id: z.string() });

/** A members' team an admin made, by a new name. */
const newTeam = async (session: string) => {
  const name = `Team ${crypto.randomUUID()}`;
  const made = await callAuth("/organization/create-team", session, { name });
  const { id } = idSchema.parse(await made.json());
  return { id, name };
};

describe("an entry of the staff list tied to its directory person", () => {
  it("is tied only by core's proof of them, so erasing them takes their entry and a forged or swapped tie takes nobody's", async () => {
    const { admin } = await connectedDirectory(idp);
    const [annId, bobId] = [crypto.randomUUID(), crypto.randomUUID()];
    const ann = await microsoftMember(annId);
    // The directory's address for Ann isn't the one she signs in with:
    // only the tie finds her entry.
    await directoryHolds([
      user({
        id: annId,
        displayName: "Ann Directory",
        mail: "ann.d@acme.test",
      }),
      user({
        id: bobId,
        displayName: "Bob Directory",
        mail: "bob.d@acme.test",
      }),
    ]);
    const read = await admin.api.onboarding.readDirectory();
    const genuine = entryOf(read, annId);
    const bob = entryOf(read, bobId);
    await saveList(admin, [
      // Bob's entry with Ann's ID and her own proof, and an entry with
      // Ann's ID and a proof made up: first on the list, so either would
      // be the one tie of her ID if a proof counted for any entry.
      { ...bob, directory: genuine.directory },
      {
        id: "p-carol",
        name: "Carol",
        email: "carol@acme.test",
        team: "everyone",
        title: "",
        directory: { suite: "microsoft", id: annId, proof: "0".repeat(64) },
      },
      genuine,
    ]);
    const tiedBefore = await tiedIds();

    await admin.api.members.remove(ann.userId);
    await admin.api.members.erase(ann.userId, ann.name);

    expect({
      tiedBefore,
      list: await listed(admin),
      tiedAfter: await tiedIds(),
    }).toStrictEqual({
      tiedBefore: { [bob.id]: null, "p-carol": null, [genuine.id]: annId },
      list: {
        [bob.id]: { name: "Bob Directory", left: false },
        "p-carol": { name: "Carol", left: false },
        // Hers stays in its team, without her name, and without the tie.
        [genuine.id]: { name: "", left: false },
      },
      tiedAfter: { [bob.id]: null, "p-carol": null, [genuine.id]: null },
    });
  });

  it("keeps its tie through a save from the list as shown, which never shows it, until its address or name changes, and never takes one to someone erased", async () => {
    const { admin } = await connectedDirectory(idp);
    const [daanId, eveId, erasedId, fayId] = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];
    const erased = await microsoftMember(erasedId);
    await admin.api.members.remove(erased.userId);
    await admin.api.members.erase(erased.userId, erased.name);
    await directoryHolds([
      user({ id: daanId, displayName: "Daan", mail: "daan@acme.test" }),
      user({ id: eveId, displayName: "Eve", mail: "eve@acme.test" }),
      user({ id: fayId, displayName: "Fay", mail: "fay@acme.test" }),
      // Still in the directory after their erasure in Grasp.
      user({ id: erasedId, displayName: "Gone", mail: "gone@acme.test" }),
    ]);
    const read = await admin.api.onboarding.readDirectory();
    const [daan, eve, fay, gone] = [
      entryOf(read, daanId),
      entryOf(read, eveId),
      entryOf(read, fayId),
      entryOf(read, erasedId),
    ];
    // Daan twice, under another entry: one ID ties one entry, the first.
    const copy = { ...daan, id: "p-daan-copy" };
    await saveList(admin, [daan, copy, eve, fay, gone]);
    const { roster } = await admin.api.onboarding.view();
    if (roster === null) {
      throw new Error("Expected the list");
    }
    // The admin confirms the list as shown, Eve's address and Fay's name
    // put right.
    const putRight: Record<string, Partial<(typeof roster.people)[number]>> = {
      [eve.id]: { email: "eve@other.test" },
      [fay.id]: { name: "Fay Renamed" },
    };
    await admin.api.onboarding.confirmRoster({
      ...roster,
      people: roster.people.map((person) => ({
        ...person,
        ...putRight[person.id],
      })),
    });

    expect({
      shown: roster.people.find(({ id }) => id === daan.id),
      tied: await tiedIds(),
    }).toStrictEqual({
      shown: {
        id: daan.id,
        name: "Daan",
        email: "daan@acme.test",
        team: roster.teams[0]?.id,
        title: "",
        away: false,
      },
      tied: {
        [daan.id]: daanId,
        [copy.id]: null,
        [eve.id]: null,
        [fay.id]: null,
        [gone.id]: null,
      },
    });
  });

  it("shows as left once the daily read no longer holds them, or holds them only deleted, never before a read, and no longer once it holds them again", async () => {
    const { admin } = await connectedDirectory(idp);
    const [finId, gusId, idaId] = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];
    // Ida signed in: the read keeps a deleted account only of someone an
    // account names (directory-people.ts `carriedOf`).
    await microsoftMember(idaId);
    const all = [
      user({ id: finId, displayName: "Fin", mail: "fin@acme.test" }),
      user({ id: gusId, displayName: "Gus", mail: "gus@acme.test" }),
      user({ id: idaId, displayName: "Ida", mail: "ida@acme.test" }),
    ];
    await directoryHolds(all);
    const read = await admin.api.onboarding.readDirectory();
    const [fin, gus, ida] = [
      entryOf(read, finId),
      entryOf(read, gusId),
      entryOf(read, idaId),
    ];
    // Hanna is on the list from a file: nothing ties her to anyone.
    const hanna = {
      id: "p-hanna",
      name: "Hanna",
      email: "hanna@acme.test",
      team: "everyone",
      title: "",
    };
    await saveList(admin, [fin, gus, ida, hanna]);
    // Fin gone from the directory, and Ida held only as a deleted account,
    // before any daily read was applied.
    await directoryHolds([all[1] ?? {}], [{ id: idaId }]);
    const beforeRead = await listed(admin);

    await dailyRead();
    const gone = await listed(admin);
    // Kept through a save of the list as shown.
    const { roster } = await admin.api.onboarding.view();
    if (roster !== null) {
      await admin.api.onboarding.saveRoster(roster);
    }
    const saved = await listed(admin);
    await directoryHolds(all);
    await dailyRead();

    expect({
      beforeRead,
      gone,
      saved,
      back: await listed(admin),
    }).toStrictEqual({
      beforeRead: {
        [fin.id]: { name: "Fin", left: false },
        [gus.id]: { name: "Gus", left: false },
        [ida.id]: { name: "Ida", left: false },
        "p-hanna": { name: "Hanna", left: false },
      },
      gone: {
        [fin.id]: { name: "Fin", left: true },
        [gus.id]: { name: "Gus", left: false },
        [ida.id]: { name: "Ida", left: true },
        "p-hanna": { name: "Hanna", left: false },
      },
      saved: {
        [fin.id]: { name: "Fin", left: true },
        [gus.id]: { name: "Gus", left: false },
        [ida.id]: { name: "Ida", left: true },
        "p-hanna": { name: "Hanna", left: false },
      },
      back: {
        [fin.id]: { name: "Fin", left: false },
        [gus.id]: { name: "Gus", left: false },
        [ida.id]: { name: "Ida", left: false },
        "p-hanna": { name: "Hanna", left: false },
      },
    });
  });

  it("shows as left once their member is removed, though the directory still holds them", async () => {
    const { admin } = await connectedDirectory(idp);
    const [ivoId, janId] = [crypto.randomUUID(), crypto.randomUUID()];
    const ivo = await microsoftMember(ivoId);
    await directoryHolds([
      user({ id: ivoId, displayName: "Ivo", mail: "ivo@acme.test" }),
      user({ id: janId, displayName: "Jan", mail: "jan@acme.test" }),
    ]);
    const read = await admin.api.onboarding.readDirectory();
    const [ivoEntry, jan] = [entryOf(read, ivoId), entryOf(read, janId)];
    await saveList(admin, [ivoEntry, jan]);

    await admin.api.members.remove(ivo.userId);
    const removed = await listed(admin);
    await dailyRead();

    expect({ removed, afterRead: await listed(admin) }).toStrictEqual({
      removed: {
        [ivoEntry.id]: { name: "Ivo", left: true },
        [jan.id]: { name: "Jan", left: false },
      },
      afterRead: {
        [ivoEntry.id]: { name: "Ivo", left: true },
        [jan.id]: { name: "Jan", left: false },
      },
    });
  });

  it("keeps a removal's mark that lands while a daily read looks, which saw them still there", async () => {
    const { admin } = await connectedDirectory(idp);
    const oliId = crypto.randomUUID();
    const oli = await microsoftMember(oliId);
    await directoryHolds([
      user({ id: oliId, displayName: "Oli", mail: "oli@acme.test" }),
    ]);
    const read = await admin.api.onboarding.readDirectory();
    const entry = entryOf(read, oliId);
    await saveList(admin, [entry]);
    await dailyRead();
    // Removed just after the next read found them held and not removed.
    const { coreEnv, landed } = landingAt(
      /inner join "directory_reads"/u,
      "after",
      async () => {
        await admin.api.members.remove(oli.userId);
      }
    );

    await dailyRead(coreEnv);

    expect({ landed: landed(), list: await listed(admin) }).toStrictEqual({
      landed: true,
      list: { [entry.id]: { name: "Oli", left: true } },
    });
  });

  it("finds the member who holds a gap's role by the tie, though the directory made them a member before they signed in", async () => {
    const { admin } = await connectedDirectory(idp);
    const team = await newTeam(admin.session);
    const kimId = crypto.randomUUID();
    await directoryHolds([
      user({
        id: kimId,
        displayName: "Kim",
        mail: "kim@acme.test",
        department: team.name,
      }),
    ]);
    // The read makes Kim a member, under an address no mail reaches, and
    // the next ties the row to that member.
    await dailyRead();
    await dailyRead();
    const read = await admin.api.onboarding.readDirectory();
    const tag = unique();
    const gap = `gap-${tag}`;
    await admin.api.brain.addRecords([
      {
        type: "source",
        id: `src-${tag}`,
        kind: "interview",
        title: "Finance interview",
        date: "2026-10-20",
      },
      { type: "candidate", id: `cand-${tag}`, name: "Invoice entry" },
      {
        type: "gap",
        id: gap,
        question: "How many invoices come in a month?",
        owner: "Head of finance",
        sourceId: `src-${tag}`,
        about: [`cand-${tag}`],
      },
    ]);
    const untied = entryOf(read, kimId, "Head of finance");
    const { directory: _tie, ...fromFile } = untied;
    await saveList(admin, [fromFile]);
    const byAddress = await outcome(admin.api.brain.askAboutGap(gap));

    await saveList(admin, [untied]);
    const asked = await admin.api.brain.askAboutGap(gap);

    expect({ byAddress, asked: asked.askedAt !== undefined }).toStrictEqual({
      byAddress: "brain.gap_no_owner",
      asked: true,
    });
  });

  it("is tied and shown as left the same way for a Google Workspace directory", async () => {
    // Last: from here on the onboarding reads the Workspace's directory.
    const { admin } = await connectedGoogleDirectory(idp);
    const [leoId, mayId] = [googleId(), googleId()];
    const leoPerson = googlePerson({ sub: leoId });
    const leo = await signedIn(idp, "google", leoPerson);
    const { userId: leoUser } = await whoami(leo);
    const both = [
      googleDirectoryUser({
        id: leoId,
        name: { fullName: "Leo" },
        primaryEmail: "leo@acme.test",
      }),
      googleDirectoryUser({
        id: mayId,
        name: { fullName: "May" },
        primaryEmail: "may@acme.test",
      }),
    ];
    await googleDirectoryHolds(both);
    const read = await admin.api.onboarding.readDirectory();
    const [leoEntry, may] = [entryOf(read, leoId), entryOf(read, mayId)];
    await saveList(admin, [leoEntry, may]);
    await dailyRead();
    await googleDirectoryHolds([both[0] ?? {}]);
    await dailyRead();
    const gone = await listed(admin);

    await admin.api.members.remove(leoUser);
    await admin.api.members.erase(leoUser, String(leoPerson.name));

    expect({
      suite: read.suite,
      gone,
      erased: await listed(admin),
      tied: await tiedIds(),
    }).toStrictEqual({
      suite: "google",
      gone: {
        [leoEntry.id]: { name: "Leo", left: false },
        [may.id]: { name: "May", left: true },
      },
      erased: {
        [leoEntry.id]: { name: "", left: false },
        [may.id]: { name: "May", left: true },
      },
      tied: { [leoEntry.id]: null, [may.id]: mayId },
    });
  });
});
