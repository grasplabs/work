import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { landingAt } from "./d1-landing.ts";
import {
  connectedDirectory,
  directoryGroup as group,
  directoryGroupsHold,
  directoryHolds,
  directoryUser,
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

// The directory's groups as teams' source (GRA-2056, G2): an admin of
// the client searches the Entra directory's groups, weighs one, and maps
// it to a members' team. Only Microsoft Graph is faked. The ways it could
// go wrong come first: someone but the client's admin mapping, a group
// anyone can join (or one Microsoft didn't describe) mapped, a team that
// isn't there, a change that leaves no record or two, a preview that
// tells who.

const idp = mockIdp();

const idSchema = z.object({ id: z.string() });

/** A members' team an admin made in Settings › Members. */
const teamNamed = async (session: string, name: string): Promise<string> => {
  const made = await callAuth("/organization/create-team", session, {
    name: `${name} ${crypto.randomUUID()}`,
  });
  return idSchema.parse(await made.json()).id;
};

const user = (id: string = crypto.randomUUID()) => ({
  "@odata.type": "#microsoft.graph.user",
  id,
});

/** Someone who signed in with Microsoft under `oid`, as a member. */
const memberWith = async (oid: string): Promise<void> => {
  const person = entraPerson(acmeTenant, "acme.test", { oid });
  await whoami(
    await signedIn(idp, "microsoft", person, {
      coreEnv: withSignIn({
        entra: { tenantId: acmeTenant, clientId: entraClient.id },
      }),
    })
  );
};

/** The groups an admin mapped, as their mapping events record them. */
const mappingEvents = (events: { action: string }[]) =>
  events.filter(({ action }) => action.startsWith("directory.group_"));

/** Every call of `directoryGroups`, as `api` makes it: what each answered. */
const everyCall = async (
  api: Awaited<ReturnType<typeof signedInApi>>["api"]
): Promise<string[]> => [
  await outcome(api.directoryGroups.search("Finance")),
  await outcome(api.directoryGroups.preview(crypto.randomUUID())),
  await outcome(api.directoryGroups.mapToTeam(crypto.randomUUID(), "team")),
  await outcome(api.directoryGroups.unmap(crypto.randomUUID())),
  await outcome(api.directoryGroups.list()),
];

describe("the directory's groups as teams' source", () => {
  it("are for the client's admins alone: a member and Grasp staff are refused everything", async () => {
    await connectedDirectory(idp);
    const member = await signedInApi(idp, "user");
    const staff = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(staff);
    using staffApi = core.authenticate();
    expect({
      member: await everyCall(member.api),
      staff: await everyCall(staffApi),
    }).toStrictEqual({
      member: Array.from({ length: 5 }, () => "role.forbidden"),
      staff: Array.from({ length: 5 }, () => "role.forbidden"),
    });
  });

  it("are weighed by counts alone: the people a group holds, nested groups' each once, how many are members here, and the groups within", async () => {
    const { admin } = await connectedDirectory(idp);
    const tied = crypto.randomUUID();
    await memberWith(tied);
    await directoryHolds([directoryUser({ id: tied })]);
    await runClockTask("directory.people", {}, new Date(Date.now() + 9e12));
    const weighed = group({ displayName: `Weighed ${crypto.randomUUID()}` });
    const others = Array.from({ length: 150 }, () => user());
    await directoryGroupsHold([weighed], {
      [String(weighed.id)]: [
        user(tied),
        { "@odata.type": "#microsoft.graph.group", id: crypto.randomUUID() },
        ...others,
        // Again, through the nested group.
        user(tied.toUpperCase()),
        { "@odata.type": "#microsoft.graph.device", id: crypto.randomUUID() },
      ],
    });
    const seen = await admin.api.directoryGroups.preview(String(weighed.id));
    expect(seen).toStrictEqual({
      group: {
        id: weighed.id,
        name: weighed.displayName,
        kind: "security",
        membersFrom: "owners",
        refusal: null,
      },
      teamId: null,
      people: 151,
      members: 1,
      nestedGroups: 1,
    });
  });

  it("are mapped only as Microsoft answers them now: never one anyone can join, whose members can't all be read, or that Microsoft didn't describe, nor to a team that isn't there; a security group's null visibility is no refusal", async () => {
    const { admin } = await connectedDirectory(idp);
    const team = await teamNamed(admin.session, "Finance");
    const open = group({ groupTypes: ["Unified"], visibility: "Public" });
    const hidden = group({
      groupTypes: ["Unified"],
      visibility: "HiddenMembership",
    });
    const unsaid = group({ visibility: undefined });
    const unsaid365 = group({ groupTypes: ["Unified"], visibility: null });
    const securityNull = group({ visibility: null });
    const fine = group();
    await directoryGroupsHold([
      open,
      hidden,
      unsaid,
      unsaid365,
      securityNull,
      fine,
    ]);
    let tried: string[] = [];
    const recorded = await auditedDuring(async () => {
      tried = [
        await outcome(
          admin.api.directoryGroups.mapToTeam(String(open.id), team)
        ),
        await outcome(
          admin.api.directoryGroups.mapToTeam(String(hidden.id), team)
        ),
        await outcome(
          admin.api.directoryGroups.mapToTeam(String(unsaid.id), team)
        ),
        await outcome(
          admin.api.directoryGroups.mapToTeam(String(unsaid365.id), team)
        ),
        await outcome(
          admin.api.directoryGroups.mapToTeam(String(fine.id), "no-such-team")
        ),
        await outcome(
          admin.api.directoryGroups.mapToTeam(crypto.randomUUID(), team)
        ),
      ];
    });
    const listed = await admin.api.directoryGroups.list();
    const nullMapped = await outcome(
      admin.api.directoryGroups.mapToTeam(String(securityNull.id), team)
    );
    expect({
      tried,
      recorded: mappingEvents(recorded),
      listed: listed.filter(({ groupId }) =>
        [open.id, hidden.id, unsaid.id, unsaid365.id, fine.id].includes(groupId)
      ),
      nullMapped,
    }).toStrictEqual({
      tried: [
        "directory.group_not_mappable",
        "directory.group_not_mappable",
        "directory.group_not_mappable",
        "directory.group_not_mappable",
        "directory.team_not_found",
        "directory.group_gone",
      ],
      recorded: [],
      listed: [],
      nullMapped: "ok",
    });
  });

  it("are mapped, moved and unmapped by an admin, each change recorded once, and each found by a search with its team", async () => {
    const { admin } = await connectedDirectory(idp);
    const [first, second] = [
      await teamNamed(admin.session, "Sales"),
      await teamNamed(admin.session, "Support"),
    ];
    const prefix = `Mapped ${crypto.randomUUID()}`;
    const mapped = group({ displayName: `${prefix} one` });
    const other = group({ displayName: `${prefix} two` });
    const id = String(mapped.id);
    await directoryGroupsHold([mapped, other]);
    const map = async (teamId: string) =>
      await auditedDuring(async () => {
        await admin.api.directoryGroups.mapToTeam(id, teamId);
      });
    const onFirst = await map(first);
    const again = await map(first);
    const found = await admin.api.directoryGroups.search(prefix);
    const onSecond = await map(second);
    const listed = await admin.api.directoryGroups.list();
    const unmapped = await auditedDuring(async () => {
      await admin.api.directoryGroups.unmap(id);
    });
    const twice = await admin.api.directoryGroups.unmap(id);
    const after = await admin.api.directoryGroups.list();
    const actor = { type: "person", userId: admin.userId };
    expect({
      recorded: [...onFirst, ...again, ...onSecond, ...unmapped]
        .filter(({ action }) => action.startsWith("directory.group_"))
        .map(({ actor: by, action, target, detail }) => ({
          by,
          action,
          target,
          detail,
        })),
      found: found.groups.map(({ name, teamId }) => ({ name, teamId })),
      listed: listed
        .filter(({ groupId }) => groupId === id)
        .map(({ name, kind, membersFrom, teamId, readAt }) => ({
          name,
          kind,
          membersFrom,
          teamId,
          readAt,
        })),
      twice,
      after: after.filter(({ groupId }) => groupId === id),
    }).toStrictEqual({
      recorded: [
        {
          by: actor,
          action: "directory.group_mapped",
          target: { type: "team", id: first },
          detail: {
            provider: "microsoft-directory",
            groupId: id,
            previousTeamId: null,
          },
        },
        {
          by: actor,
          action: "directory.group_mapped",
          target: { type: "team", id: second },
          detail: {
            provider: "microsoft-directory",
            groupId: id,
            previousTeamId: first,
          },
        },
        {
          by: actor,
          action: "directory.group_unmapped",
          target: { type: "team", id: second },
          detail: { provider: "microsoft-directory", groupId: id },
        },
      ],
      found: [
        { name: `${prefix} one`, teamId: first },
        { name: `${prefix} two`, teamId: null },
      ],
      listed: [
        {
          name: `${prefix} one`,
          kind: "security",
          membersFrom: "owners",
          teamId: second,
          readAt: null,
        },
      ],
      twice: { unmapped: false },
      after: [],
    });
  });

  it("change nothing for an admin who stops being one while mapping or unmapping", async () => {
    const { admin } = await connectedDirectory(idp);
    const team = await teamNamed(admin.session, "Raced");
    const [raced, kept] = [group(), group()];
    await directoryGroupsHold([raced, kept]);
    await admin.api.directoryGroups.mapToTeam(String(kept.id), team);
    const demote = async () =>
      await env.DB.prepare("UPDATE members SET role = 'user' WHERE user_id = ?")
        .bind(admin.userId)
        .run();
    const restore = async () =>
      await env.DB.prepare(
        "UPDATE members SET role = 'admin' WHERE user_id = ?"
      )
        .bind(admin.userId)
        .run();
    const raceOn = async (
      matches: RegExp,
      call: (
        api: Awaited<ReturnType<typeof signedInApi>>["api"]
      ) => Promise<unknown>
    ) => {
      const { coreEnv, landed } = landingAt(matches, "before", demote);
      const { core } = await openRpc(admin.session, { coreEnv });
      using api = core.authenticate();
      let answered = "";
      const recorded = await auditedDuring(async () => {
        answered = await outcome(call(api));
      });
      await restore();
      return { landed: landed(), answered, recorded: mappingEvents(recorded) };
    };
    const mapping = await raceOn(
      /insert into "directory_group_teams"/iu,
      async (api) => await api.directoryGroups.mapToTeam(String(raced.id), team)
    );
    const unmapping = await raceOn(
      /delete from "directory_group_teams"/iu,
      async (api) => await api.directoryGroups.unmap(String(kept.id))
    );
    const listed = await admin.api.directoryGroups.list();
    expect({
      mapping,
      unmapping,
      listed: listed
        .filter(({ groupId }) => [raced.id, kept.id].includes(groupId))
        .map(({ groupId }) => groupId),
    }).toStrictEqual({
      mapping: { landed: true, answered: "role.forbidden", recorded: [] },
      unmapping: { landed: true, answered: "role.forbidden", recorded: [] },
      listed: [kept.id],
    });
  });

  it("go with their team: a deleted team's groups are mapped no more", async () => {
    const { admin } = await connectedDirectory(idp);
    const team = await teamNamed(admin.session, "Gone");
    const mapped = group();
    await directoryGroupsHold([mapped]);
    await admin.api.directoryGroups.mapToTeam(String(mapped.id), team);
    const removed = await callAuth("/organization/remove-team", admin.session, {
      teamId: team,
    });
    await removed.body?.cancel();
    const listed = await admin.api.directoryGroups.list();
    expect(listed.filter(({ groupId }) => groupId === mapped.id)).toStrictEqual(
      []
    );
  });
});
