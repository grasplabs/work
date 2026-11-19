import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { landingAt } from "./d1-landing.ts";
import {
  connectedDirectory,
  connectedGoogleDirectory,
  googleDirectoryHolds,
  googleDirectoryUser,
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

  it("change nothing for a group that is gone, refused, lists nobody or anyone can join now, and say why", async () => {
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
    // Microsoft refuses this one group: the rest of the read is applied.
    await directoryGroupsHold([lawyers], { [id]: listing(jo) });
    await directoryGroupFails(id, 403);
    const refused = await heldAs();
    await directoryGroupsHold([lawyers], { [id]: listing(jo) });
    const back = await heldAs();
    expect({ empty, open, gone, refused, back }).toStrictEqual({
      empty: { held: "empty", teams: [team] },
      open: { held: "not_mappable", teams: [team] },
      gone: { held: "gone", teams: [team] },
      refused: { held: "refused", teams: [team] },
      back: { held: null, teams: [team] },
    });
  });

  it("keep a team its department fills while its newly mapped group is held at its first read", async () => {
    const { admin } = await connectedDirectory(idp);
    const ops = unique("Ops");
    const team = await teamNamed(admin.session, ops);
    const ray = await member();
    await directoryHolds([inDirectory({ id: ray.oid, department: ops })]);
    await directoryGroupsHold([]);
    await readNext();
    const byDepartment = await teamsOf(ray.userId);
    const empty = group();
    await directoryGroupsHold([empty], { [String(empty.id)]: [] });
    await admin.api.directoryGroups.mapToTeam(String(empty.id), team);
    await readNext();
    const listed = await admin.api.directoryGroups.list();
    expect({
      byDepartment,
      after: await teamsOf(ray.userId),
      mapping: listed
        .filter(({ groupId }) => groupId === empty.id)
        .map(({ held, readAt }) => ({ held, readAt })),
    }).toStrictEqual({
      byDepartment: [team],
      after: [team],
      mapping: [{ held: "empty", readAt: null }],
    });
  });

  it("keep what a newer read placed when an older read, started first, lands after it", async () => {
    const { admin } = await connectedDirectory(idp);
    const sam = await member();
    await directoryHolds([inDirectory({ id: sam.oid })]);
    const team = await teamNamed(admin.session, unique("Research"));
    const research = group();
    const id = String(research.id);
    await directoryGroupsHold([research], { [id]: listing(sam) });
    await admin.api.directoryGroups.mapToTeam(id, team);
    await readNext();
    days += 2;
    const at = new Date(Date.now() + days * dayMs);
    // The older read has read every page; before its batch lands, a read
    // started after it reads the group and applies it.
    const { coreEnv, landed } = landingAt(
      /insert into "directory_reads"/u,
      "before",
      async () => {
        await runClockTask("directory.people", {}, at);
      }
    );
    await runClockTask("directory.people", { DB: coreEnv.DB }, at);
    expect({
      landed: landed(),
      rows: await rowsOf(sam.oid),
      sam: await teamsOf(sam.userId),
    }).toStrictEqual({ landed: true, rows: 1, sam: [team] });
  });

  it("place nobody in the team a group moved to until a read reads it for that team", async () => {
    const { admin } = await connectedDirectory(idp);
    const [first, second] = [
      await teamNamed(admin.session, unique("First")),
      await teamNamed(admin.session, unique("Second")),
    ];
    const oid = crypto.randomUUID();
    await directoryHolds([inDirectory({ id: oid })]);
    const moving = group();
    const id = String(moving.id);
    await directoryGroupsHold([moving], { [id]: listing({ oid }) });
    await admin.api.directoryGroups.mapToTeam(id, first);
    await readNext();
    await admin.api.directoryGroups.mapToTeam(id, second);
    // They sign in after the move, before a read.
    const signer = entraPerson(acmeTenant, "acme.test", { oid });
    const session = await signedIn(idp, "microsoft", signer, {
      coreEnv: withSignIn({
        entra: { tenantId: acmeTenant, clientId: entraClient.id },
      }),
    });
    const { userId } = await whoami(session);
    const beforeRead = await teamsOf(userId);
    await readNext();
    expect({ beforeRead, after: await teamsOf(userId) }).toStrictEqual({
      beforeRead: [],
      after: [second],
    });
  });

  it("place nobody by a group moved to another team while the read ran, and take nobody out of that team, until a read reads it there", async () => {
    const { admin } = await connectedDirectory(idp);
    const support = unique("Support");
    const [first, second] = [
      await teamNamed(admin.session, unique("Helpdesk")),
      await teamNamed(admin.session, support),
    ];
    const [uma, vic] = [await member(), await member()];
    // Uma is in the group; Vic is in Support by department.
    await directoryHolds([
      inDirectory({ id: uma.oid }),
      inDirectory({ id: vic.oid, department: support }),
    ]);
    const desk = group();
    const id = String(desk.id);
    await directoryGroupsHold([desk], { [id]: listing(uma) });
    await admin.api.directoryGroups.mapToTeam(id, first);
    await readNext();
    const before = {
      uma: await teamsOf(uma.userId),
      vic: await teamsOf(vic.userId),
    };
    // The read captured the group on its first team; before its batch
    // lands, an admin moves the group to Support.
    const { coreEnv, landed } = landingAt(
      /insert into "directory_reads"/u,
      "before",
      async () => await admin.api.directoryGroups.mapToTeam(id, second)
    );
    await readNext({ DB: coreEnv.DB });
    const listed = await admin.api.directoryGroups.list();
    const during = {
      vic: await teamsOf(vic.userId),
      readAt: listed.find(({ groupId }) => groupId === id)?.readAt,
    };
    await readNext();
    const umaAfter = await teamsOf(uma.userId);
    expect({
      landed: landed(),
      before,
      during,
      after: {
        uma: umaAfter.includes(second),
        vic: await teamsOf(vic.userId),
      },
    }).toStrictEqual({
      landed: true,
      before: { uma: [first], vic: [second] },
      // Support still follows its department: its group wasn't read there.
      during: { vic: [second], readAt: null },
      // The next read reads the group for Support: Uma joins, Vic leaves.
      after: { uma: true, vic: [] },
    });
  });

  it("are read by the Entra directory's read alone: the Google directory's read reads no group and leaves their rows and teams as they are", async () => {
    const { admin } = await connectedDirectory(idp);
    const wes = await member();
    await directoryHolds([inDirectory({ id: wes.oid })]);
    const team = await teamNamed(admin.session, unique("Legal"));
    const legal = group();
    const id = String(legal.id);
    await directoryGroupsHold([legal], { [id]: listing(wes) });
    await admin.api.directoryGroups.mapToTeam(id, team);
    days += 2;
    const at = new Date(Date.now() + days * dayMs);
    await runClockTask("directory.people", {}, at);
    const before = {
      rows: await rowsOf(wes.oid),
      teams: await teamsOf(wes.userId),
    };
    // Graph would fail the group now: a read of it fails the whole read.
    await directoryGroupFails(id);
    await connectedGoogleDirectory(idp);
    await googleDirectoryHolds([googleDirectoryUser()]);
    // The same slot: Entra's read was applied in it, Google's is due.
    await runClockTask("directory.people", {}, at);
    const google = await env.DB.prepare(
      "SELECT failure, read_at IS NOT NULL AS applied FROM directory_reads WHERE provider = 'google-directory'"
    ).first<{ failure: string | null; applied: number }>();
    expect({
      before,
      google,
      after: { rows: await rowsOf(wes.oid), teams: await teamsOf(wes.userId) },
    }).toStrictEqual({
      before: { rows: 1, teams: [team] },
      google: { failure: null, applied: 1 },
      after: { rows: 1, teams: [team] },
    });
  });

  it("keep nothing of an erased person's group membership, though the directory and the group still list them", async () => {
    const { admin } = await connectedDirectory(idp);
    const ted = await member();
    await directoryHolds([inDirectory({ id: ted.oid })]);
    const team = await teamNamed(admin.session, unique("Payroll"));
    const payroll = group();
    const id = String(payroll.id);
    await directoryGroupsHold([payroll], { [id]: listing(ted) });
    await admin.api.directoryGroups.mapToTeam(id, team);
    await readNext();
    const placed = {
      rows: await rowsOf(ted.oid),
      teams: await teamsOf(ted.userId),
    };
    await admin.api.members.remove(ted.userId);
    await admin.api.members.erase(ted.userId, String(ted.person.name));
    const erased = await rowsOf(ted.oid);
    await readNext();
    expect({ placed, erased, after: await rowsOf(ted.oid) }).toStrictEqual({
      placed: { rows: 1, teams: [team] },
      erased: 0,
      after: 0,
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

  it("place only object IDs the people read lists, each once, however often a group's pages name them", async () => {
    const { admin } = await connectedDirectory(idp);
    const pia = await member();
    const unlisted = crypto.randomUUID();
    await directoryHolds([inDirectory({ id: pia.oid })]);
    const team = await teamNamed(admin.session, unique("Platform"));
    const platform = group();
    const id = String(platform.id);
    // Pia on the first page and again on the second (a hundred to a page),
    // and someone the people read doesn't list.
    await directoryGroupsHold([platform], {
      [id]: [
        ...listing(pia),
        ...Array.from({ length: 120 }, () => userEntry(crypto.randomUUID())),
        userEntry(pia.oid.toUpperCase()),
        userEntry(unlisted),
      ],
    });
    await admin.api.directoryGroups.mapToTeam(id, team);
    await readNext();
    const { results } = await env.DB.prepare(
      "SELECT account_id AS id FROM directory_group_members WHERE group_id = ?"
    )
      .bind(id)
      .all<{ id: string }>();
    expect({
      rows: results.map((row) => row.id),
      pia: await teamsOf(pia.userId),
    }).toStrictEqual({ rows: [pia.oid], pia: [team] });
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
