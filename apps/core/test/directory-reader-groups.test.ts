import { recallBudgetMax } from "@grasp-os/brain-next/contract";
import type { SourceReader } from "@grasp-os/shared/source-readers";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { addSource, recallAs } from "../src/brain-next.ts";
import type { SourceRef } from "../src/brain-next.ts";
import { readerGroupRequestsPerTick } from "../src/source-readers.ts";
import { landingAt } from "./d1-landing.ts";
import {
  connectedDirectory,
  directoryGroup as group,
  directoryGroupFails,
  directoryGroupsHold,
  directoryHolds,
  directoryUser as inDirectory,
} from "./directory.ts";
import { mockIdp } from "./idp.ts";
import { runClockTask } from "./maintenance.ts";
import { acmeTenant, entraClient, otherTenant } from "./sign-in-config.ts";
import {
  callAuth,
  entraPerson,
  onlyAdmins,
  signedIn,
  unique,
  uniqueWord,
  whoami,
  withSignIn,
} from "./sign-in.ts";

// A member's Entra groups proved by the company's directory connection
// (GRA-2146; the threat model is on the issue), so a file shared with a
// group reaches its members who never connected their own Microsoft
// account. Through the clock's reads and the Brain's recall, with only
// Microsoft Graph faked. The ways it could go wrong come first: someone
// taken for a member of a group they aren't in, a guest or a turned-off
// account counted, a failed or partial read taken for the whole or taking
// a group away early, someone removed at the source still counting, the
// two readers of a group undoing each other, a group that places people
// in a team by a reader list, and rows kept past their use.

const idp = mockIdp();
const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
/** Signing people in and reading the directory can be slow on CI. */
const setUpTime = { timeout: 120_000 };

/**
 * The clock's slots, each later than any before in this file: so the
 * daily read is always due, and so is every group's read. `hours` past
 * the last one (two days unless told).
 */
let slot = Date.now();
const later = (hours = 48): Date => {
  slot += hours * hourMs;
  return new Date(slot);
};

/** The clock's daily read of the directory, at `at`. */
const readDirectory = async (at = later()): Promise<void> => {
  await runClockTask("directory.people", {}, at);
};

/** The clock's read of the groups reader lists name, at `at`. */
const readGroups = async (at = later()): Promise<void> => {
  await runClockTask("directory.reader_groups", {}, at);
};

/**
 * The clock's read of the groups reader lists name, at `ms` as both its
 * slot and the clock's time: so the rows it keeps date from then.
 */
const readGroupsAsOf = async (ms: number): Promise<void> => {
  vi.useFakeTimers({ toFake: ["Date"], now: ms });
  try {
    await runClockTask("directory.reader_groups", {}, new Date(ms));
  } finally {
    vi.useRealTimers();
  }
};

/** Someone who signed in with Microsoft under a new object ID, as a member. */
const member = async () => {
  const oid = crypto.randomUUID();
  const person = entraPerson(acmeTenant, "acme.test", { oid });
  const session = await signedIn(idp, "microsoft", person, {
    coreEnv: withSignIn({
      entra: { tenantId: acmeTenant, clientId: entraClient.id },
    }),
  });
  const { userId } = await whoami(session);
  return { oid, userId, session };
};

/** `members` as a group's members, as Graph lists them. */
const listing = (...members: { oid: string }[]) =>
  members.map(({ oid }) => ({
    "@odata.type": "#microsoft.graph.user",
    id: oid,
  }));

/** An Entra group's reader, by its object ID, in `tenant`. */
const entraGroup = (id: unknown, tenant = acmeTenant): SourceReader => ({
  kind: "group",
  provider: "microsoft",
  tenant,
  group: String(id),
});

/** An item kept with `marker` for `readers`: a file the source shares with them. */
const sharedWith = async (
  marker: string,
  ...readers: SourceReader[]
): Promise<SourceRef> => {
  const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
  await addSource(env, {
    source,
    change: crypto.randomUUID(),
    text: `Budget review ${marker}`,
    readers: { kind: "readers", readers },
  });
  return source;
};

/** Whether `personId`, reading as themselves, `laterMs` from now, finds `source` by `marker`. */
const finds = async (
  personId: string,
  source: SourceRef,
  marker: string,
  laterMs = 0
): Promise<boolean> => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + laterMs });
  try {
    const { items } = await recallAs(env, personId, {
      personal: true,
      question: marker,
      budget: { tokens: recallBudgetMax },
    });
    return items.some(
      ({ source: found, text }) =>
        found.id === source.id && text.includes(marker)
    );
  } finally {
    vi.useRealTimers();
  }
};

/** How many group rows are kept of the person with object ID `oid`. */
const rowsOf = async (oid: string): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM directory_group_members WHERE account_id = ?"
  )
    .bind(oid)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

const idSchema = z.object({ id: z.string() });

/** A members' team an admin made in Settings › Members. */
const teamNamed = async (session: string, name: string): Promise<string> => {
  const made = await callAuth("/organization/create-team", session, { name });
  return idSchema.parse(await made.json()).id;
};

/** The teams `userId` is in. */
const teamsOf = async (userId: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    "SELECT team_id AS teamId FROM team_members WHERE user_id = ?"
  )
    .bind(userId)
    .all<{ teamId: string }>();
  return results.map(({ teamId }) => teamId);
};

describe("a member's Entra groups proved by the company's directory", () => {
  it(
    "let a group's members read what is shared with it without connecting anything, for a day from the read, and nobody else",
    setUpTime,
    async () => {
      await connectedDirectory(idp);
      const [ann, bob, cy] = [await member(), await member(), await member()];
      await directoryHolds(
        [ann, bob, cy].map(({ oid }) => inDirectory({ id: oid }))
      );
      const [finance, sales] = [group(), group()];
      await directoryGroupsHold([finance, sales], {
        [String(finance.id)]: listing(ann),
        [String(sales.id)]: listing(cy),
      });
      await readDirectory();
      const marker = uniqueWord();
      const file = await sharedWith(marker, entraGroup(finance.id));
      const beforeRead = await finds(ann.userId, file, marker);
      await readGroups();

      expect({
        beforeRead,
        ann: await finds(ann.userId, file, marker),
        annWithinTheDay: await finds(ann.userId, file, marker, 23 * hourMs),
        annAfterTheDay: await finds(ann.userId, file, marker, 25 * hourMs),
        // In the directory, in no group the file names.
        bob: await finds(bob.userId, file, marker),
        // In another group.
        cy: await finds(cy.userId, file, marker),
      }).toStrictEqual({
        beforeRead: false,
        ann: true,
        annWithinTheDay: true,
        annAfterTheDay: false,
        bob: false,
        cy: false,
      });
    }
  );

  it(
    "count no guest, no turned-off account, even one the directory can't suspend, and no group of another tenant",
    setUpTime,
    async () => {
      await connectedDirectory(idp);
      const [ann, dee, guest] = [
        await member(),
        await member(),
        await member(),
      ];
      // Dee is the company's only admin: the read turns her account off
      // but can't suspend her, as no admin would be left.
      await env.DB.prepare(
        "UPDATE members SET role = 'admin' WHERE user_id = ?"
      )
        .bind(dee.userId)
        .run();
      await onlyAdmins(dee.userId);
      await directoryHolds([
        inDirectory({ id: ann.oid }),
        inDirectory({ id: dee.oid, accountEnabled: false }),
        inDirectory({ id: guest.oid, userType: "Guest" }),
      ]);
      const finance = group();
      await directoryGroupsHold([finance], {
        [String(finance.id)]: listing(ann, dee, guest),
      });
      await readDirectory();
      const marker = uniqueWord();
      const file = await sharedWith(marker, entraGroup(finance.id));
      const otherMarker = uniqueWord();
      // The same group ID, named by a list in another tenant.
      const otherFile = await sharedWith(
        otherMarker,
        entraGroup(finance.id, otherTenant)
      );
      await readGroups();

      expect({
        ann: await finds(ann.userId, file, marker),
        dee: await finds(dee.userId, file, marker),
        guestRows: await rowsOf(guest.oid),
        annInAnotherTenant: await finds(ann.userId, otherFile, otherMarker),
      }).toStrictEqual({
        ann: true,
        dee: false,
        guestRows: 0,
        annInAnotherTenant: false,
      });
    }
  );

  it(
    "end for someone removed from the group at its next read, half a day after the last, not before",
    setUpTime,
    async () => {
      await connectedDirectory(idp);
      const [ann, bob] = [await member(), await member()];
      await directoryHolds(
        [ann, bob].map(({ oid }) => inDirectory({ id: oid }))
      );
      const finance = group();
      await directoryGroupsHold([finance], {
        [String(finance.id)]: listing(ann, bob),
      });
      await readDirectory();
      const marker = uniqueWord();
      const file = await sharedWith(marker, entraGroup(finance.id));
      const readAt = later();
      await readGroups(readAt);
      // Bob leaves the group at the source.
      await directoryGroupsHold([finance], {
        [String(finance.id)]: listing(ann),
      });
      await readGroups(new Date(readAt.getTime() + hourMs));
      const anHourLater = await finds(bob.userId, file, marker);
      await readGroups(new Date(readAt.getTime() + 13 * hourMs));

      expect({
        anHourLater,
        bobAfterTheNextRead: await finds(bob.userId, file, marker),
        ann: await finds(ann.userId, file, marker),
      }).toStrictEqual({
        anHourLater: true,
        bobAfterTheNextRead: false,
        ann: true,
      });
    }
  );

  it(
    "prove nothing by a read that fails or can't read every member, and take nothing away before the day is over",
    setUpTime,
    async () => {
      await connectedDirectory(idp);
      const [ann, bob, cy, dee, eve] = [
        await member(),
        await member(),
        await member(),
        await member(),
        await member(),
      ];
      await directoryHolds(
        [ann, bob, cy, dee, eve].map(({ oid }) => inDirectory({ id: oid }))
      );
      const finance = group();
      const hidden = group({ visibility: "HiddenMembership" });
      // A Microsoft 365 group Microsoft says no visibility of.
      const unknown = group({ groupTypes: ["Unified"], visibility: null });
      // Anyone may join it, and the source lets whoever joins read.
      const open = group({ groupTypes: ["Unified"], visibility: "Public" });
      await directoryGroupsHold([finance, hidden, unknown, open], {
        [String(finance.id)]: listing(ann),
        [String(hidden.id)]: listing(cy),
        [String(unknown.id)]: listing(cy),
        [String(open.id)]: listing(dee),
      });
      await readDirectory();
      const marker = uniqueWord();
      const file = await sharedWith(
        marker,
        entraGroup(finance.id),
        entraGroup(hidden.id),
        entraGroup(unknown.id),
        entraGroup(open.id)
      );
      await readGroups();
      // Bob joins Finance, but every read of it fails from now on; Eve
      // joins the Public group, whose read the failing one holds up
      // only once.
      await directoryGroupsHold([finance, hidden, unknown, open], {
        [String(finance.id)]: listing(ann, bob),
        [String(hidden.id)]: listing(cy),
        [String(unknown.id)]: listing(cy),
        [String(open.id)]: listing(dee, eve),
      });
      await directoryGroupFails(String(finance.id));
      await readGroups();
      await readGroups();

      expect({
        ann: await finds(ann.userId, file, marker),
        annWithinTheDay: await finds(ann.userId, file, marker, 23 * hourMs),
        annAfterTheDay: await finds(ann.userId, file, marker, 25 * hourMs),
        bob: await finds(bob.userId, file, marker),
        cy: await finds(cy.userId, file, marker),
        dee: await finds(dee.userId, file, marker),
        eve: await finds(eve.userId, file, marker),
      }).toStrictEqual({
        ann: true,
        annWithinTheDay: true,
        annAfterTheDay: false,
        bob: false,
        cy: false,
        dee: true,
        eve: true,
      });
    }
  );

  it(
    "leave a group mapped to a team to the daily read, which reads it again before its proof's day is over, and place nobody by a group only a list names",
    setUpTime,
    async () => {
      const { admin } = await connectedDirectory(idp);
      const [ann, bob] = [await member(), await member()];
      await directoryHolds(
        [ann, bob].map(({ oid }) => inDirectory({ id: oid }))
      );
      const [mapped, named] = [group(), group()];
      await directoryGroupsHold([mapped, named], {
        [String(mapped.id)]: listing(ann),
        [String(named.id)]: listing(bob),
      });
      const team = await teamNamed(admin.session, `Finance ${unique()}`);
      await admin.api.directoryGroups.mapToTeam(String(mapped.id), team);
      const marker = uniqueWord();
      const file = await sharedWith(
        marker,
        entraGroup(mapped.id),
        entraGroup(named.id)
      );
      await readDirectory();
      await env.DB.prepare(
        "DELETE FROM directory_group_members WHERE group_id = ?"
      )
        .bind(String(mapped.id))
        .run();
      await readGroups();
      const annByGroupsRead = await finds(ann.userId, file, marker);
      const bobByGroupsRead = await finds(bob.userId, file, marker);
      // Less than half an hour short of a day after the last, the daily
      // read reads the mapped group again: Ann's proof comes from it.
      await readDirectory(new Date(Date.now() + dayMs - 29 * 60_000));

      expect({
        annByGroupsRead,
        bobByGroupsRead,
        annByDailyRead: await finds(ann.userId, file, marker),
        annsTeams: await teamsOf(ann.userId),
        bobsTeams: await teamsOf(bob.userId),
      }).toStrictEqual({
        annByGroupsRead: false,
        bobByGroupsRead: true,
        annByDailyRead: true,
        annsTeams: [team],
        bobsTeams: [],
      });
    }
  );

  it(
    "keep no member's row of a group once it is neither mapped to a team nor named by a list, and hand an unmapped named group to the groups' read",
    setUpTime,
    async () => {
      const { admin } = await connectedDirectory(idp);
      const [ann, bob, cy] = [await member(), await member(), await member()];
      await directoryHolds(
        [ann, bob, cy].map(({ oid }) => inDirectory({ id: oid }))
      );
      // Only named; only mapped; both.
      const [named, mapped, both] = [group(), group(), group()];
      await directoryGroupsHold([named, mapped, both], {
        [String(named.id)]: listing(ann),
        [String(mapped.id)]: listing(bob),
        [String(both.id)]: listing(cy),
      });
      const [mappedTeam, bothTeam] = [
        await teamNamed(admin.session, `Ops ${unique()}`),
        await teamNamed(admin.session, `Legal ${unique()}`),
      ];
      await admin.api.directoryGroups.mapToTeam(String(mapped.id), mappedTeam);
      await admin.api.directoryGroups.mapToTeam(String(both.id), bothTeam);
      const marker = uniqueWord();
      const file = await sharedWith(
        marker,
        entraGroup(named.id),
        entraGroup(both.id)
      );
      await readDirectory();
      await readGroups();
      const kept = {
        named: await rowsOf(ann.oid),
        mapped: await rowsOf(bob.oid),
        both: await rowsOf(cy.oid),
      };
      // No list names the first any more; the other two are unmapped.
      await env.DB.prepare("DELETE FROM source_reader_groups WHERE name = ?")
        .bind(`group:microsoft:${acmeTenant.toLowerCase()}:${String(named.id)}`)
        .run();
      await admin.api.directoryGroups.unmap(String(mapped.id));
      await admin.api.directoryGroups.unmap(String(both.id));
      const unmapped = {
        mapped: await rowsOf(bob.oid),
        both: await rowsOf(cy.oid),
        cyReads: await finds(cy.userId, file, marker),
      };
      // Cy leaves the group that was mapped: the groups' read now reads it.
      await directoryGroupsHold([named, mapped, both], {
        [String(named.id)]: listing(ann),
        [String(mapped.id)]: listing(bob),
        [String(both.id)]: [],
      });
      await readGroups();

      expect({
        kept,
        unmapped,
        afterTheNextRead: {
          named: await rowsOf(ann.oid),
          both: await rowsOf(cy.oid),
          cyReads: await finds(cy.userId, file, marker),
        },
      }).toStrictEqual({
        kept: { named: 1, mapped: 1, both: 1 },
        unmapped: { mapped: 0, both: 1, cyReads: true },
        afterTheNextRead: { named: 0, both: 0, cyReads: false },
      });
    }
  );

  it(
    "keep a named group's rows when it is unmapped while the daily read runs",
    setUpTime,
    async () => {
      const { admin } = await connectedDirectory(idp);
      const cy = await member();
      await directoryHolds([inDirectory({ id: cy.oid })]);
      const both = group();
      await directoryGroupsHold([both], { [String(both.id)]: listing(cy) });
      const team = await teamNamed(admin.session, `Legal ${unique()}`);
      await admin.api.directoryGroups.mapToTeam(String(both.id), team);
      const marker = uniqueWord();
      const file = await sharedWith(marker, entraGroup(both.id));
      await readDirectory();
      const { coreEnv, landed } = landingAt(
        /insert into "directory_reads"/iu,
        "before",
        async () => await admin.api.directoryGroups.unmap(String(both.id))
      );
      await runClockTask("directory.people", { DB: coreEnv.DB }, later());

      expect({
        landed: landed(),
        rows: await rowsOf(cy.oid),
        cy: await finds(cy.userId, file, marker),
      }).toStrictEqual({ landed: true, rows: 1, cy: true });
    }
  );

  it(
    "write nothing of an older run of the groups' read that lands after a newer one",
    setUpTime,
    async () => {
      await connectedDirectory(idp);
      const ann = await member();
      await directoryHolds([inDirectory({ id: ann.oid })]);
      const finance = group();
      await directoryGroupsHold([finance], {
        [String(finance.id)]: listing(ann),
      });
      await readDirectory();
      // Every other group read now, so only Finance is due next.
      const settled = later();
      await readGroups(settled);
      const marker = uniqueWord();
      const file = await sharedWith(marker, entraGroup(finance.id));
      const { coreEnv, landed } = landingAt(
        /update "source_reader_groups"/iu,
        "before",
        async () => {
          // Ann leaves Finance, and a newer run reads it first.
          await directoryGroupsHold([finance], {
            [String(finance.id)]: [],
          });
          await readGroups(new Date(settled.getTime() + 2 * hourMs));
        }
      );
      await runClockTask(
        "directory.reader_groups",
        { DB: coreEnv.DB },
        new Date(settled.getTime() + hourMs)
      );

      expect({
        landed: landed(),
        ann: await finds(ann.userId, file, marker),
      }).toStrictEqual({ landed: true, ann: false });
    }
  );

  it(
    "try a group whose read failed again at the next run, so one failure cuts nobody off",
    setUpTime,
    async () => {
      await connectedDirectory(idp);
      const [ann, bob] = [await member(), await member()];
      await directoryHolds(
        [ann, bob].map(({ oid }) => inDirectory({ id: oid }))
      );
      const finance = group();
      const id = String(finance.id);
      await directoryGroupsHold([finance], { [id]: listing(ann) });
      await readDirectory();
      const marker = uniqueWord();
      const file = await sharedWith(marker, entraGroup(finance.id));
      const start = Date.now();
      await readGroupsAsOf(start);
      // Bob joins; the read half a day on is throttled, the next one works.
      await directoryGroupsHold([finance], { [id]: listing(ann, bob) });
      await directoryGroupFails(id, 429);
      await readGroupsAsOf(start + 12 * hourMs + 15 * 60_000);
      await directoryGroupsHold([finance], { [id]: listing(ann, bob) });
      await readGroupsAsOf(start + 12 * hourMs + 30 * 60_000);

      expect({
        refreshed: await finds(bob.userId, file, marker),
        annJustAfterTheDay: await finds(
          ann.userId,
          file,
          marker,
          dayMs + 15 * 60_000
        ),
      }).toStrictEqual({ refreshed: true, annJustAfterTheDay: true });
    }
  );

  it(
    "write nothing of a group the daily read reads for its new team while this read reads it",
    setUpTime,
    async () => {
      const { admin } = await connectedDirectory(idp);
      const [ann, cy] = [await member(), await member()];
      await directoryHolds(
        [ann, cy].map(({ oid }) => inDirectory({ id: oid }))
      );
      const finance = group();
      const id = String(finance.id);
      await directoryGroupsHold([finance], { [id]: listing(ann) });
      await readDirectory();
      const marker = uniqueWord();
      const file = await sharedWith(marker, entraGroup(finance.id));
      const team = await teamNamed(admin.session, `Finance ${unique()}`);
      const { coreEnv, landed } = landingAt(
        /update "source_reader_groups"/iu,
        "before",
        async () => {
          // Mapped, Cy joins, and the daily read reads it for its team.
          await admin.api.directoryGroups.mapToTeam(id, team);
          await directoryGroupsHold([finance], { [id]: listing(ann, cy) });
          await readDirectory();
        }
      );
      await runClockTask(
        "directory.reader_groups",
        { DB: coreEnv.DB },
        later()
      );

      expect({
        landed: landed(),
        cy: await finds(cy.userId, file, marker),
        cysTeams: await teamsOf(cy.userId),
        rows: await rowsOf(cy.oid),
      }).toStrictEqual({ landed: true, cy: true, cysTeams: [team], rows: 1 });
    }
  );

  it(
    "go on proving a named group once it is mapped to a team, until the daily read reads it for that team, which alone places its members",
    setUpTime,
    async () => {
      const { admin } = await connectedDirectory(idp);
      const [ann, bob] = [await member(), await member()];
      await directoryHolds(
        [ann, bob].map(({ oid }) => inDirectory({ id: oid }))
      );
      const finance = group();
      const id = String(finance.id);
      await directoryGroupsHold([finance], { [id]: listing(ann) });
      await readDirectory();
      const marker = uniqueWord();
      const file = await sharedWith(marker, entraGroup(finance.id));
      const first = later();
      await readGroups(first);
      const team = await teamNamed(admin.session, `Finance ${unique()}`);
      await admin.api.directoryGroups.mapToTeam(id, team);
      await directoryGroupsHold([finance], { [id]: listing(ann, bob) });
      await readGroups(new Date(first.getTime() + 13 * hourMs));
      const beforeDailyRead = {
        bob: await finds(bob.userId, file, marker),
        teams: [...(await teamsOf(ann.userId)), ...(await teamsOf(bob.userId))],
      };
      await readDirectory();

      expect({
        beforeDailyRead,
        afterDailyRead: {
          bob: await finds(bob.userId, file, marker),
          ann: await teamsOf(ann.userId),
          bobs: await teamsOf(bob.userId),
        },
      }).toStrictEqual({
        beforeDailyRead: { bob: true, teams: [] },
        afterDailyRead: { bob: true, ann: [team], bobs: [team] },
      });
    }
  );

  // Last: it leaves many groups named.
  it(
    "read no more groups in a run than its calls cover, and leave the rest unread for the next",
    { timeout: 300_000 },
    async () => {
      await connectedDirectory(idp);
      const ann = await member();
      await directoryHolds([inDirectory({ id: ann.oid })]);
      // Taken after every group below: they go by ID when none was tried.
      const finance = group({
        id: `ffffffff-ffff-4fff-bfff-${crypto.randomUUID().slice(-12)}`,
      });
      await directoryGroupsHold([finance], {
        [String(finance.id)]: listing(ann),
      });
      await readDirectory();
      // As many named groups as one run's calls cover, none in the
      // directory any more: each is one call.
      const tenant = acmeTenant.toLowerCase();
      const gone = Array.from(
        { length: readerGroupRequestsPerTick },
        (_, at) =>
          `group:microsoft:${tenant}:00000000-0000-4000-8000-${at.toString(16).padStart(12, "0")}`
      );
      await env.DB.prepare(
        "INSERT INTO source_reader_groups (name) SELECT value FROM json_each(?)"
      )
        .bind(JSON.stringify(gone))
        .run();
      const marker = uniqueWord();
      const file = await sharedWith(marker, entraGroup(finance.id));
      await readGroups();
      const afterOneRun = await finds(ann.userId, file, marker);
      await readGroups();

      expect({
        afterOneRun,
        afterTheNext: await finds(ann.userId, file, marker),
      }).toStrictEqual({ afterOneRun: false, afterTheNext: true });
    }
  );
});
