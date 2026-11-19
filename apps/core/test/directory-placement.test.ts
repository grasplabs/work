import type { DirectoryMover, UnplacedMember } from "@grasp-os/shared/members";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  connectedDirectory,
  directoryHolds,
  directoryUser as user,
} from "./directory.ts";
import { mockIdp } from "./idp.ts";
import { runClockTask } from "./maintenance.ts";
import { acmeTenant, entraClient } from "./sign-in-config.ts";
import {
  callAuth,
  entraPerson,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  whoami,
  withSignIn,
} from "./sign-in.ts";

// What the directory leaves for an admin to place, and what admins placed
// by hand, as Settings › Members › Teams shows it (GRA-2056, slice 4;
// GRA-2110, GRA-2135). Only Microsoft Graph is faked. What could go wrong:
// someone the directory left without a team, or in a team that no longer
// fits, whom no admin ever learns of; someone listed for an admin to act
// on who isn't (a suspended member, a team added by hand, a pair an admin
// kept); a pin shown where it changes nothing; the list read by someone
// it isn't for. Placing by hand is Better Auth's own route, which pins.

const idp = mockIdp();
const dayMs = 24 * 60 * 60 * 1000;

let days = 0;
/** A time past every read so far by more than a day: a read is due then. */
const nextDay = (): Date => {
  days += 2;
  return new Date(Date.now() + days * dayMs);
};

/** The clock's daily read, run for the slot at `at`. */
const readAt = async (at: Date): Promise<void> => {
  await runClockTask("directory.people", {}, at);
};

/** Someone who signed in with Microsoft under a new object ID, as a member. */
const someone = async () => {
  const oid = crypto.randomUUID();
  const person = entraPerson(acmeTenant, "acme.test", { oid });
  const session = await signedIn(idp, "microsoft", person, {
    coreEnv: withSignIn({
      admins: [String(person.email)],
      entra: { tenantId: acmeTenant, clientId: entraClient.id },
    }),
  });
  const { userId } = await whoami(session);
  return { oid, userId };
};

const idSchema = z.object({ id: z.string() });

/** A team an admin made, by a name of its own: its ID and that name. */
const team = async (session: string, name: string) => {
  const unique = `${name} ${crypto.randomUUID()}`;
  const made = await callAuth("/organization/create-team", session, {
    name: unique,
  });
  return { id: idSchema.parse(await made.json()).id, name: unique };
};

/** An admin's hand change of `userId` in `teamId`, in Settings › Members. */
const byHand = async (
  session: string,
  change: "add" | "remove",
  teamId: string,
  userId: string
): Promise<number> => {
  const response = await callAuth(
    `/organization/${change}-team-member`,
    session,
    { teamId, userId }
  );
  await response.body?.cancel();
  return response.status;
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

/** Of `list`, the entries of `userIds`, each as `shape` gives it, by user. */
const of = <Entry extends { userId: string }, Shown>(
  list: Entry[],
  userIds: string[],
  shape: (entry: Entry) => Shown
): Record<string, Shown[]> => {
  const shown: Record<string, Shown[]> = {};
  for (const entry of list) {
    if (userIds.includes(entry.userId)) {
      shown[entry.userId] = [...(shown[entry.userId] ?? []), shape(entry)];
    }
  }
  return shown;
};

/** What a test reads of someone not in a team. */
const unplaced = ({
  department,
  departmentTeam,
}: UnplacedMember): Pick<UnplacedMember, "department" | "departmentTeam"> => ({
  department,
  departmentTeam,
});

/** What a test reads of a mover: their team, department, and its team, by ID. */
const mover = ({
  team: inTeam,
  department,
  departmentTeam,
}: DirectoryMover) => ({
  team: inTeam.id,
  department,
  departmentTeam: departmentTeam?.id ?? null,
});

describe("whom the directory leaves for an admin to place", () => {
  it("lists members who may act and are in no team, with what the directory says of them, until an admin places them by hand, which pins them where the next read keeps them", async () => {
    const { admin } = await connectedDirectory(idp);
    const finance = await team(admin.session, "Finance");
    const [ann, ben, cas, dan, eve] = [
      await someone(),
      await someone(),
      await someone(),
      await someone(),
      await someone(),
    ];
    const legal = `Legal ${crypto.randomUUID()}`;
    // Cas isn't in the directory; Dan's account is turned off.
    await directoryHolds([
      user({ id: ann.oid, department: legal }),
      user({ id: ben.oid, department: null }),
      user({ id: dan.oid, accountEnabled: false }),
      user({ id: eve.oid, department: finance.name }),
    ]);
    await readAt(nextDay());
    const everyone = [ann, ben, cas, dan, eve].map(({ userId }) => userId);
    const before = await admin.api.members.directoryPlacement();

    const placed = await byHand(admin.session, "add", finance.id, ann.userId);
    await readAt(nextDay());
    const after = await admin.api.members.directoryPlacement();

    expect(of(before.unplaced, everyone, unplaced)).toStrictEqual({
      [ann.userId]: [{ department: legal, departmentTeam: null }],
      [ben.userId]: [{ department: "", departmentTeam: null }],
      [cas.userId]: [{ department: null, departmentTeam: null }],
    });
    expect({
      placed,
      unplaced: Object.keys(of(after.unplaced, everyone, unplaced)).toSorted(),
      teams: await teamsOf(ann.userId),
      pins: of(after.pins, everyone, ({ team: { id }, kept }) => ({
        id,
        kept,
      })),
    }).toStrictEqual({
      placed: 200,
      unplaced: [ben.userId, cas.userId].toSorted(),
      teams: [finance.id],
      pins: { [ann.userId]: [{ id: finance.id, kept: true }] },
    });
  });

  it("lists a member still in a team the read put them in that their department no longer fills, with that department and its team, until an admin acts; not a mover the read moved, a team added by hand, or a pair an admin kept", async () => {
    const { admin } = await connectedDirectory(idp);
    const [sales, support, projects] = [
      await team(admin.session, "Sales"),
      await team(admin.session, "Support"),
      await team(admin.session, "Projects"),
    ];
    const [fay, gus, hal, ida, jon] = [
      await someone(),
      await someone(),
      await someone(),
      await someone(),
      await someone(),
    ];
    const everyone = [fay, gus, hal, ida, jon];
    await directoryHolds(
      everyone.map(({ oid }) => user({ id: oid, department: sales.name }))
    );
    await readAt(nextDay());
    // Gus is kept out of Support by hand; Ida is added to Projects by hand,
    // and that pin released;
    // Jon is kept in Sales by hand.
    await byHand(admin.session, "add", support.id, gus.userId);
    await byHand(admin.session, "remove", support.id, gus.userId);
    await byHand(admin.session, "add", projects.id, ida.userId);
    // Released, Ida's team added by hand is still none the read made.
    await admin.api.members.releaseTeamPin(ida.userId, projects.id);
    await byHand(admin.session, "add", sales.id, jon.userId);
    const nowhere = `Nowhere ${crypto.randomUUID()}`;
    await directoryHolds([
      user({ id: fay.oid, department: nowhere }),
      user({ id: gus.oid, department: support.name }),
      user({ id: hal.oid, department: support.name }),
      user({ id: ida.oid, department: sales.name }),
      user({ id: jon.oid, department: null }),
    ]);
    await readAt(nextDay());
    const before = await admin.api.members.directoryPlacement();

    // An admin acts: Fay is taken off Sales, Gus is put in Support.
    await byHand(admin.session, "remove", sales.id, fay.userId);
    await byHand(admin.session, "add", support.id, gus.userId);
    await readAt(nextDay());
    const after = await admin.api.members.directoryPlacement();

    const ids = everyone.map(({ userId }) => userId);
    expect(of(before.movers, ids, mover)).toStrictEqual({
      [fay.userId]: [
        { team: sales.id, department: nowhere, departmentTeam: null },
      ],
      [gus.userId]: [
        {
          team: sales.id,
          department: support.name,
          departmentTeam: support.id,
        },
      ],
    });
    expect({
      movers: of(after.movers, ids, mover),
      gus: await teamsOf(gus.userId),
      hal: await teamsOf(hal.userId),
    }).toStrictEqual({
      movers: {},
      gus: [support.id],
      hal: [support.id],
    });
  });

  it("shows pins only on members tied to the directory, on whom the read acts", async () => {
    const { admin } = await connectedDirectory(idp);
    const ops = await team(admin.session, "Ops");
    const [kim, lou] = [await someone(), await someone()];
    await directoryHolds([user({ id: kim.oid })]);
    await readAt(nextDay());
    // Lou isn't in the directory: a pin on them changes nothing it does.
    await byHand(admin.session, "add", ops.id, kim.userId);
    await byHand(admin.session, "add", ops.id, lou.userId);

    const shown = await admin.api.members.directoryPlacement();

    expect(
      of(shown.pins, [kim.userId, lou.userId], ({ team: { id }, kept }) => ({
        id,
        kept,
      }))
    ).toStrictEqual({ [kim.userId]: [{ id: ops.id, kept: true }] });
  });

  it("is the client's admins' alone: a member and Grasp staff are refused", async () => {
    await connectedDirectory(idp);
    const member = await signedInApi(idp, "user");
    const staff = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );

    expect({
      member: await outcome(member.api.members.directoryPlacement()),
      staff: await outcome(
        staff.core.authenticate().members.directoryPlacement()
      ),
    }).toStrictEqual({ member: "role.forbidden", staff: "role.forbidden" });
  });
});
