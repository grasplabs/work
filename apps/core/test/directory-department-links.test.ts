import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  connectedDirectory,
  directoryGroup,
  directoryGroupsHold,
  directoryHolds,
  directoryUser as user,
} from "./directory.ts";
import { mockIdp } from "./idp.ts";
import { runClockTask } from "./maintenance.ts";
import { acmeTenant, entraClient } from "./sign-in-config.ts";
import {
  auditedDuring,
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

// An admin links a directory department to a team by hand (GRA-2247; the
// threat model is on the issue): the department the read found no team
// named like, so it placed nobody. Only Microsoft Graph is faked. What
// could go wrong: someone who isn't an admin deciding who is in a team; a
// department pouring people into a team that follows groups, into a
// deleted team, or over an existing link; an admin's hand change undone;
// an undo that takes people away or touches a link the read made.

const idp = mockIdp();
const dayMs = 24 * 60 * 60 * 1000;

let days = 0;
/** The clock's daily read, for a slot past every read so far by more than a day. */
const readNext = async (): Promise<void> => {
  days += 2;
  await runClockTask(
    "directory.people",
    {},
    new Date(Date.now() + days * dayMs)
  );
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

/** A team an admin made, by a name of its own: its ID. */
const team = async (session: string, name: string): Promise<string> => {
  const made = await callAuth("/organization/create-team", session, {
    name: `${name} ${crypto.randomUUID()}`,
  });
  return idSchema.parse(await made.json()).id;
};

/** A department the directory gives, named like no team. */
const department = (name: string): string => `${name} ${crypto.randomUUID()}`;

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

describe("a department an admin links to a team", () => {
  it("places nobody of a department no team is named like until an admin links it, then, at the next read, everyone in it, recorded as the admin's", async () => {
    const { admin } = await connectedDirectory(idp);
    const sales = await team(admin.session, "Sales");
    const emea = department("Sales EMEA");
    const [ann, ben] = [await someone(), await someone()];
    await directoryHolds([
      user({ id: ann.oid, department: emea }),
      user({ id: ben.oid, department: emea }),
    ]);
    await readNext();
    const before = [await teamsOf(ann.userId), await teamsOf(ben.userId)];

    const linked = await auditedDuring(async () => {
      await admin.api.members.linkDepartment(emea, sales);
    });
    // The link places nobody itself: the read does.
    const linkedOnly = await teamsOf(ann.userId);
    await readNext();
    const shown = await admin.api.members.directoryPlacement();

    expect({
      before,
      linkedOnly,
      after: [await teamsOf(ann.userId), await teamsOf(ben.userId)],
      shown: shown.departmentLinks
        .filter((link) => link.department === emea)
        .map((link) => link.team.id),
      recorded: linked
        .filter(({ action }) => action.startsWith("directory."))
        .map(({ actor, action, target }) => ({ actor, action, target })),
    }).toStrictEqual({
      before: [[], []],
      linkedOnly: [],
      after: [[sales], [sales]],
      shown: [sales],
      recorded: [
        {
          actor: { type: "person", userId: admin.userId },
          action: "directory.department_linked",
          target: { type: "team", id: sales },
        },
      ],
    });
  });

  it("leaves someone an admin took out of the team by hand out of it", async () => {
    const { admin } = await connectedDirectory(idp);
    const support = await team(admin.session, "Support");
    const desk = department("Service desk");
    const [cy, dee] = [await someone(), await someone()];
    await directoryHolds([
      user({ id: cy.oid, department: desk }),
      user({ id: dee.oid, department: desk }),
    ]);
    await readNext();
    await byHand(admin.session, "add", support, cy.userId);
    await byHand(admin.session, "remove", support, cy.userId);

    await admin.api.members.linkDepartment(desk, support);
    await readNext();

    expect({
      cy: await teamsOf(cy.userId),
      dee: await teamsOf(dee.userId),
    }).toStrictEqual({ cy: [], dee: [support] });
  });

  it("is the client's admins' alone: a member and Grasp staff are refused, and nobody is placed", async () => {
    const { admin } = await connectedDirectory(idp);
    const finance = await team(admin.session, "Finance");
    const ledger = department("Ledger");
    const eve = await someone();
    await directoryHolds([user({ id: eve.oid, department: ledger })]);
    const member = await signedInApi(idp, "user");
    const staff = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );

    const refused = {
      member: await outcome(member.api.members.linkDepartment(ledger, finance)),
      staff: await outcome(
        staff.core.authenticate().members.linkDepartment(ledger, finance)
      ),
    };
    await readNext();

    expect({ refused, eve: await teamsOf(eve.userId) }).toStrictEqual({
      refused: { member: "role.forbidden", staff: "role.forbidden" },
      eve: [],
    });
  });

  it("refuses a team that follows the directory's groups, a deleted team, a department the directory doesn't list, and a department linked already", async () => {
    const { admin } = await connectedDirectory(idp);
    const [engineering, deleted, other] = [
      await team(admin.session, "Engineering"),
      await team(admin.session, "Deleted"),
      await team(admin.session, "Other"),
    ];
    const platform = department("Platform");
    const [fay, gil] = [await someone(), await someone()];
    await directoryHolds([
      user({ id: fay.oid, department: platform }),
      user({ id: gil.oid }),
    ]);
    const engineers = directoryGroup();
    const groupId = String(engineers.id);
    await directoryGroupsHold([engineers], {
      [groupId]: [{ "@odata.type": "#microsoft.graph.user", id: gil.oid }],
    });
    await admin.api.directoryGroups.mapToTeam(groupId, engineering);
    // Engineering follows the group once a read read it whole.
    await readNext();
    const removed = await callAuth("/organization/remove-team", admin.session, {
      teamId: deleted,
    });
    await removed.body?.cancel();
    const link = async (to: string, name = platform) =>
      await outcome(admin.api.members.linkDepartment(name, to));

    const refused = {
      grouped: await link(engineering),
      deleted: await link(deleted),
      unlisted: await link(other, department("Unlisted")),
    };
    const first = await link(other);
    const again = await link(engineering);
    await readNext();

    expect({
      refused,
      first,
      again,
      fay: await teamsOf(fay.userId),
    }).toStrictEqual({
      refused: {
        grouped: "directory.department_not_linked",
        deleted: "directory.department_not_linked",
        unlisted: "directory.department_not_linked",
      },
      first: "ok",
      again: "directory.department_not_linked",
      fay: [other],
    });
  });

  it("once undone places nobody new by it and takes nobody away; a link the read made by name isn't undone", async () => {
    const { admin } = await connectedDirectory(idp);
    const legal = await team(admin.session, "Legal");
    const contracts = department("Contracts");
    const named = await team(admin.session, "Named");
    const namedDepartment = await env.DB.prepare(
      "SELECT name FROM teams WHERE id = ?"
    )
      .bind(named)
      .first<string>("name");
    const [gus, hal, ida, jo] = [
      await someone(),
      await someone(),
      await someone(),
      await someone(),
    ];
    await directoryHolds([
      user({ id: gus.oid, department: contracts }),
      user({ id: ida.oid, department: namedDepartment }),
    ]);
    // The read links Named's department by its name.
    await readNext();
    await admin.api.members.linkDepartment(contracts, legal);
    await readNext();

    const undone = await auditedDuring(
      async () => await admin.api.members.unlinkDepartment(contracts, legal)
    );
    const byName = await admin.api.members.unlinkDepartment(
      namedDepartment ?? "",
      named
    );
    await directoryHolds([
      user({ id: gus.oid, department: contracts }),
      user({ id: hal.oid, department: contracts }),
      user({ id: ida.oid, department: namedDepartment }),
      user({ id: jo.oid, department: namedDepartment }),
    ]);
    await readNext();
    const shown = await admin.api.members.directoryPlacement();

    expect({
      gus: await teamsOf(gus.userId),
      hal: await teamsOf(hal.userId),
      jo: await teamsOf(jo.userId),
      byName,
      shown: shown.departmentLinks.filter(
        (link) => link.department === contracts
      ),
      recorded: undone
        .filter(({ action }) => action.startsWith("directory."))
        .map(({ actor, action, target }) => ({ actor, action, target })),
    }).toStrictEqual({
      gus: [legal],
      hal: [],
      jo: [named],
      byName: { unlinked: false },
      shown: [],
      recorded: [
        {
          actor: { type: "person", userId: admin.userId },
          action: "directory.department_unlinked",
          target: { type: "team", id: legal },
        },
      ],
    });
  });

  it("is undone by the client's admins alone", async () => {
    const { admin } = await connectedDirectory(idp);
    const ops = await team(admin.session, "Ops");
    const night = department("Night shift");
    const kit = await someone();
    await directoryHolds([user({ id: kit.oid, department: night })]);
    await readNext();
    await admin.api.members.linkDepartment(night, ops);
    const member = await signedInApi(idp, "user");

    const refused = await outcome(
      member.api.members.unlinkDepartment(night, ops)
    );
    await readNext();

    expect({ refused, kit: await teamsOf(kit.userId) }).toStrictEqual({
      refused: "role.forbidden",
      kit: [ops],
    });
  });
});
