import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

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
import { acmeTenant, entraClient } from "./sign-in-config.ts";
import {
  auditedDuring,
  callAuth,
  entraPerson,
  signedIn,
  whoami,
  withSignIn,
} from "./sign-in.ts";

// The directory's mapped groups placing their members in teams (GRA-2056,
// G3), through the clock's daily read, with only Microsoft Graph faked.
// The ways it could go wrong come first: a team emptied by a group read in
// part, held, or emptied by mistake; an admin's hand change undone; a
// department filling a team that follows groups; a mapping made mid-read
// placing people before its group was read; someone the read keeps no
// row for placed.

const idp = mockIdp();
const dayMs = 24 * 60 * 60 * 1000;
let days = 0;

/** The clock's daily read, run for a slot more than a day past every read so far. */
const readNext = async (changes: Partial<Env> = {}): Promise<void> => {
  days += 2;
  await runClockTask(
    "directory.people",
    changes,
    new Date(Date.now() + days * dayMs)
  );
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
  return { oid, userId, session, person };
};

const idSchema = z.object({ id: z.string() });

/** A members' team an admin made in Settings › Members. */
const teamNamed = async (session: string, name: string): Promise<string> => {
  const made = await callAuth("/organization/create-team", session, { name });
  return idSchema.parse(await made.json()).id;
};

/** An admin's hand change of `userId` in `teamId`, in Settings › Members. */
const byHand = async (
  session: string,
  change: "add" | "remove",
  teamId: string,
  userId: string
): Promise<void> => {
  const response = await callAuth(
    `/organization/${change}-team-member`,
    session,
    { teamId, userId }
  );
  await response.body?.cancel();
};

/** The teams `userId` is in. */
const teamsOf = async (userId: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    "SELECT team_id AS teamId FROM team_members WHERE user_id = ? ORDER BY team_id"
  )
    .bind(userId)
    .all<{ teamId: string }>();
  return results.map(({ teamId }) => teamId);
};

const sorted = (...ids: string[]): string[] => ids.toSorted();

const userEntry = (id: string) => ({
  "@odata.type": "#microsoft.graph.user",
  id,
});

/** `members` as a group's members, as Graph lists them. */
const listing = (...members: { oid: string }[]) =>
  members.map(({ oid }) => userEntry(oid));

/** A unique team name. */
const unique = (name: string) => `${name} ${crypto.randomUUID()}`;

/** How many group rows the read keeps of the person with object ID `oid`. */
const rowsOf = async (oid: string): Promise<number | undefined> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM directory_group_members WHERE account_id = ?"
  )
    .bind(oid)
    .first<{ n: number }>();
  return row?.n;
};

describe("teams that follow directory groups", () => {
  it("take in a group's members, let go those it no longer lists, and keep what an admin did by hand", async () => {
    const { admin } = await connectedDirectory(idp);
    const [ann, bob, cy, dee] = [
      await member(),
      await member(),
      await member(),
      await member(),
    ];
    await directoryHolds(
      [ann, bob, cy, dee].map(({ oid }) => inDirectory({ id: oid }))
    );
    const team = await teamNamed(admin.session, unique("Engineering"));
    const engineers = group();
    const id = String(engineers.id);
    await directoryGroupsHold([engineers], { [id]: listing(ann, bob, dee) });
    await admin.api.directoryGroups.mapToTeam(id, team);
    await readNext();
    const placed = await Promise.all(
      [ann, bob, dee].map(async ({ userId }) => await teamsOf(userId))
    );
    // An admin adds cy by hand, and takes dee out by hand.
    await byHand(admin.session, "add", team, cy.userId);
    await byHand(admin.session, "remove", team, dee.userId);
    await directoryGroupsHold([engineers], { [id]: listing(ann, dee) });
    await readNext();
    expect({
      placed,
      ann: await teamsOf(ann.userId),
      bob: await teamsOf(bob.userId),
      cy: await teamsOf(cy.userId),
      dee: await teamsOf(dee.userId),
    }).toStrictEqual({
      placed: [[team], [team], [team]],
      ann: [team],
      // No longer listed: let go.
      bob: [],
      // Added by hand, listed by no group: kept.
      cy: [team],
      // Listed again, but taken out by hand: kept out.
      dee: [],
    });
  });

  it("put someone two mapped groups list in both their teams", async () => {
    const { admin } = await connectedDirectory(idp);
    const fay = await member();
    await directoryHolds([inDirectory({ id: fay.oid })]);
    const [first, second] = [
      await teamNamed(admin.session, unique("Design")),
      await teamNamed(admin.session, unique("Research")),
    ];
    const [one, two] = [group(), group()];
    await directoryGroupsHold([one, two], {
      [String(one.id)]: listing(fay),
      [String(two.id)]: listing(fay),
    });
    await admin.api.directoryGroups.mapToTeam(String(one.id), first);
    await admin.api.directoryGroups.mapToTeam(String(two.id), second);
    await readNext();
    await expect(teamsOf(fay.userId)).resolves.toStrictEqual(
      sorted(first, second)
    );
  });

  it("follow their group, not a department, from its first read: the department's other people leave that team, and other teams keep following their departments", async () => {
    const { admin } = await connectedDirectory(idp);
    const sales = unique("Sales");
    const ops = unique("Ops");
    const [salesTeam, opsTeam] = [
      await teamNamed(admin.session, sales),
      await teamNamed(admin.session, ops),
    ];
    const [hal, ivy, gus] = [await member(), await member(), await member()];
    await directoryHolds([
      inDirectory({ id: hal.oid, department: sales }),
      inDirectory({ id: ivy.oid, department: sales }),
      inDirectory({ id: gus.oid, department: ops }),
    ]);
    await directoryGroupsHold([]);
    await readNext();
    const byDepartment = {
      hal: await teamsOf(hal.userId),
      ivy: await teamsOf(ivy.userId),
      gus: await teamsOf(gus.userId),
    };
    const sellers = group();
    await directoryGroupsHold([sellers], {
      [String(sellers.id)]: listing(hal),
    });
    await admin.api.directoryGroups.mapToTeam(String(sellers.id), salesTeam);
    await readNext();
    // A read more: Ivy's department, linked to Sales, never puts her back.
    const again = await auditedDuring(async () => {
      await readNext();
    });
    expect({
      byDepartment,
      churn: again.filter(
        ({ action, detail }) =>
          action.startsWith("team.member.") &&
          [hal.userId, ivy.userId, gus.userId].includes(String(detail?.userId))
      ),
      hal: await teamsOf(hal.userId),
      ivy: await teamsOf(ivy.userId),
      gus: await teamsOf(gus.userId),
    }).toStrictEqual({
      byDepartment: { hal: [salesTeam], ivy: [salesTeam], gus: [opsTeam] },
      churn: [],
      hal: [salesTeam],
      ivy: [],
      gus: [opsTeam],
    });
  });

  it("change nothing for a group that is gone, lists nobody or anyone can join now, and say why", async () => {
    const { admin } = await connectedDirectory(idp);
    const jo = await member();
    await directoryHolds([inDirectory({ id: jo.oid })]);
    const team = await teamNamed(admin.session, unique("Legal"));
    const lawyers = group();
    const id = String(lawyers.id);
    await directoryGroupsHold([lawyers], { [id]: listing(jo) });
    await admin.api.directoryGroups.mapToTeam(id, team);
    await readNext();
    const heldAs = async () => {
      await readNext();
      const listed = await admin.api.directoryGroups.list();
      return {
        held: listed.find(({ groupId }) => groupId === id)?.held,
        teams: await teamsOf(jo.userId),
      };
    };
    await directoryGroupsHold([lawyers], { [id]: [] });
    const empty = await heldAs();
    await directoryGroupsHold(
      [{ ...lawyers, groupTypes: ["Unified"], visibility: "Public" }],
      {
        [id]: [],
      }
    );
    const open = await heldAs();
    await directoryGroupsHold([]);
    const gone = await heldAs();
    await directoryGroupsHold([lawyers], { [id]: listing(jo) });
    const back = await heldAs();
    expect({ empty, open, gone, back }).toStrictEqual({
      empty: { held: "empty", teams: [team] },
      open: { held: "not_mappable", teams: [team] },
      gone: { held: "gone", teams: [team] },
      back: { held: null, teams: [team] },
    });
  });

  it("apply nothing of a read in which a group's members couldn't be read", async () => {
    const { admin } = await connectedDirectory(idp);
    const [kit, lou] = [await member(), await member()];
    await directoryHolds([
      inDirectory({ id: kit.oid }),
      inDirectory({ id: lou.oid }),
    ]);
    const team = await teamNamed(admin.session, unique("Finance"));
    const finance = group();
    const id = String(finance.id);
    await directoryGroupsHold([finance], { [id]: listing(kit) });
    await admin.api.directoryGroups.mapToTeam(id, team);
    await readNext();
    // The group now lists lou instead, but Graph fails its members.
    await directoryGroupsHold([finance], { [id]: listing(lou) });
    await directoryGroupFails(id);
    await readNext();
    const { results } = await env.DB.prepare(
      "SELECT failure FROM directory_reads WHERE provider = 'microsoft-directory'"
    ).all<{ failure: string | null }>();
    expect({
      kit: await teamsOf(kit.userId),
      lou: await teamsOf(lou.userId),
      failure: results[0]?.failure,
    }).toStrictEqual({
      kit: [team],
      lou: [],
      failure: "directory.provider_failed",
    });
  });

  it("change nothing by a mapping made while the read ran: its team follows its department until a read reads the group", async () => {
    const { admin } = await connectedDirectory(idp);
    const [mo, nan] = [await member(), await member()];
    const support = unique("Support");
    const team = await teamNamed(admin.session, support);
    await directoryHolds([
      inDirectory({ id: mo.oid, department: support }),
      inDirectory({ id: nan.oid }),
    ]);
    const supporters = group();
    const id = String(supporters.id);
    await directoryGroupsHold([supporters], { [id]: listing(nan) });
    await readNext();
    const byDepartment = await teamsOf(mo.userId);
    const { coreEnv, landed } = landingAt(
      /insert into "directory_reads"/iu,
      "before",
      async () => await admin.api.directoryGroups.mapToTeam(id, team)
    );
    await readNext({ DB: coreEnv.DB });
    const during = {
      mo: await teamsOf(mo.userId),
      nan: await teamsOf(nan.userId),
    };
    await readNext();
    expect({
      landed: landed(),
      byDepartment,
      during,
      after: { mo: await teamsOf(mo.userId), nan: await teamsOf(nan.userId) },
    }).toStrictEqual({
      landed: true,
      byDepartment: [team],
      during: { mo: [team], nan: [] },
      after: { mo: [], nan: [team] },
    });
  });

  it("place only the people the read keeps: never a guest, nor a turned-off account, nor someone the directory no longer lists", async () => {
    const { admin } = await connectedDirectory(idp);
    const [ned, off] = [await member(), await member()];
    const guest = crypto.randomUUID();
    await directoryHolds([
      inDirectory({ id: ned.oid }),
      inDirectory({ id: off.oid, accountEnabled: false }),
      inDirectory({ id: guest, userType: "Guest" }),
    ]);
    const team = await teamNamed(admin.session, unique("Marketing"));
    const marketing = group();
    const id = String(marketing.id);
    await directoryGroupsHold([marketing], {
      [id]: [...listing(ned, off), userEntry(guest)],
    });
    await admin.api.directoryGroups.mapToTeam(id, team);
    await readNext();
    const kept = { ned: await rowsOf(ned.oid), guest: await rowsOf(guest) };
    // Ned leaves the directory: his row, and his group's row, go.
    await directoryHolds([inDirectory({ id: off.oid, accountEnabled: false })]);
    await readNext();
    expect({
      kept,
      off: await teamsOf(off.userId),
      left: await rowsOf(ned.oid),
    }).toStrictEqual({
      kept: { ned: 1, guest: 0 },
      off: [],
      left: 0,
    });
  });

  it("place someone their group lists as they first sign in", async () => {
    const { admin } = await connectedDirectory(idp);
    const oid = crypto.randomUUID();
    await directoryHolds([inDirectory({ id: oid })]);
    const team = await teamNamed(admin.session, unique("Data"));
    const data = group();
    const id = String(data.id);
    await directoryGroupsHold([data], { [id]: listing({ oid }) });
    await admin.api.directoryGroups.mapToTeam(id, team);
    await readNext();
    const signer = entraPerson(acmeTenant, "acme.test", { oid });
    const session = await signedIn(idp, "microsoft", signer, {
      coreEnv: withSignIn({
        entra: { tenantId: acmeTenant, clientId: entraClient.id },
      }),
    });
    const { userId } = await whoami(session);
    await expect(teamsOf(userId)).resolves.toStrictEqual([team]);
  });
});
