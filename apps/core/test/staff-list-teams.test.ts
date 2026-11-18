import type { RosterInput } from "@grasp-os/shared/onboarding";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { mockIdp } from "./idp.ts";
import { auditedDuring, callAuth, signedInApi, unique } from "./sign-in.ts";

// One list of teams with one id (GRA-2055, core's staff-list-teams.ts):
// the onboarding's staff list names the members' teams. What can go
// wrong, tried here: a second team made for one the members already have,
// or a request's id taken for a new team (a deleted team's id coming back
// with what was shared with it); a rename in Settings › Members that the
// staff list doesn't follow; a team deleted while the list still names
// it; someone placed in a team by a draft, by a name, without an account
// or after an admin removed them; a move that leaves the old team's
// access behind; a team an admin added someone to by hand taken from them.

const idp = mockIdp();

type Admin = Awaited<ReturnType<typeof signedInApi>>;

/** The members' teams, by name: their ids and who is in them. */
const membersTeams = async (admin: Admin) => {
  const teams = await admin.api.members.teams();
  return new Map(
    teams.map(({ id, name, memberIds }) => [
      name,
      { id, memberIds: memberIds.toSorted() },
    ])
  );
};

/** The staff list's team ids, by name, as the store keeps them. */
const listTeams = async (admin: Admin) => {
  const { roster } = await admin.api.onboarding.view();
  return new Map((roster?.teams ?? []).map(({ id, name }) => [name, id]));
};

/** The address someone signed in with. */
const emailOf = (signedIn: Admin): string =>
  z.string().parse(signedIn.person.email);

/** A team made in Settings › Members, as an admin makes one. */
const settingsTeam = async (admin: Admin, name: string): Promise<string> => {
  const made = await callAuth("/organization/create-team", admin.session, {
    name,
  });
  const { id } = z.object({ id: z.string() }).parse(await made.json());
  return id;
};

describe("the staff list's teams", { timeout: 120_000 }, () => {
  it("are the members' teams: one id each, a new one core's own", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const support = await settingsTeam(admin, `Support ${tag}`);
    const roster: RosterInput = {
      teams: [
        { id: `sales-${tag}`, name: `Sales ${tag}`, lead: null },
        // Named as the team made in Settings, under another id.
        {
          id: `support-${tag}`,
          name: ` support ${tag.toUpperCase()} `,
          lead: null,
        },
      ],
      people: [
        { id: `ann-${tag}`, name: "Ann", team: `sales-${tag}` },
        { id: `bo-${tag}`, name: "Bo", team: `support-${tag}` },
      ],
    };

    const events = await auditedDuring(async () => {
      await admin.api.onboarding.saveRoster(roster);
    });
    const members = await membersTeams(admin);
    const list = await listTeams(admin);
    const { roster: saved } = await admin.api.onboarding.view();
    const sales = members.get(`Sales ${tag}`)?.id;

    expect({
      sameIds: [...list].every(([name, id]) => members.get(name)?.id === id),
      support: list.get(`support ${tag.toUpperCase()}`),
      salesIsCores: sales !== undefined && sales !== `sales-${tag}`,
      people: saved?.people.map(({ team }) => team),
      created: events
        .filter(({ action }) => action === "team.created")
        .map(({ target, detail }) => ({ id: target?.id, detail })),
      // A draft places nobody.
      placed: members.get(`Sales ${tag}`)?.memberIds,
    }).toStrictEqual({
      sameIds: true,
      support,
      salesIsCores: true,
      people: [sales, support],
      created: [{ id: sales, detail: { via: "staffList" } }],
      placed: [],
    });
    // Renamed by the list: the members' team follows, under its id.
    await admin.api.onboarding.saveRoster({
      teams: [{ id: support, name: `Help ${tag}`, lead: null }],
      people: [{ id: `bo-${tag}`, name: "Bo", team: support }],
    });
    const renamed = await membersTeams(admin);
    expect(renamed.get(`Help ${tag}`)?.id).toBe(support);
  });

  it("follow a rename in Settings, and keep a team on the list from being deleted there", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const tag = unique();
    await admin.api.onboarding.confirmRoster({
      teams: [
        { id: "ops", name: `Ops ${tag}`, lead: null, does: "Runs the depots" },
        { id: "old", name: `Old ${tag}`, lead: null },
      ],
      people: [{ id: `cy-${tag}`, name: "Cy", team: "ops" }],
    });
    const first = await listTeams(admin);
    const ops = first.get(`Ops ${tag}`) ?? "";
    const old = first.get(`Old ${tag}`) ?? "";

    await callAuth("/organization/update-team", admin.session, {
      teamId: ops,
      data: { name: `Operations ${tag}` },
    });
    const listed = await listTeams(admin);
    // What every member reads of the company's teams.
    const { teams: read } = await member.api.brain.read();
    const refused = await callAuth("/organization/remove-team", admin.session, {
      teamId: old,
    });
    // Off the list, it goes as any other.
    await admin.api.onboarding.confirmRoster({
      teams: [{ id: ops, name: `Operations ${tag}`, lead: null }],
      people: [{ id: `cy-${tag}`, name: "Cy", team: ops }],
    });
    const removed = await callAuth("/organization/remove-team", admin.session, {
      teamId: old,
    });
    // Its id never comes back: the list sending it again gets a new team.
    await admin.api.onboarding.saveRoster({
      teams: [
        { id: ops, name: `Operations ${tag}`, lead: null },
        { id: old, name: `Old ${tag}`, lead: null },
      ],
      people: [{ id: `cy-${tag}`, name: "Cy", team: old }],
    });
    const last = await listTeams(admin);
    const again = last.get(`Old ${tag}`);

    expect({
      listed: listed.get(`Operations ${tag}`),
      read: read.find(({ id }) => id === `team-${ops}`)?.name,
      refused: refused.status,
      removed: removed.status,
      again: again !== undefined && again !== old,
    }).toStrictEqual({
      listed: ops,
      read: `Operations ${tag}`,
      refused: 409,
      removed: 200,
      again: true,
    });
  });

  it("place a member in their team once the admin confirms, by their sign-in's address only", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const removed = await signedInApi(idp, "user");
    const tag = unique();
    await admin.api.members.remove(removed.userId);
    const roster = (team: (person: string) => string): RosterInput => ({
      teams: [
        { id: "sales", name: `Sales ${tag}`, lead: null },
        { id: "finance", name: `Finance ${tag}`, lead: null },
      ],
      people: [
        // In capitals: the address is the same, whatever its case.
        {
          id: "ann",
          name: "Ann",
          email: emailOf(ann).toUpperCase(),
          team: team("ann"),
        },
        {
          id: "rex",
          name: "Rex",
          email: emailOf(removed),
          team: team("rex"),
        },
        // No account yet, and none at all.
        {
          id: "new",
          name: "Nia",
          email: `nia-${tag}@acme.test`,
          team: team("new"),
        },
        { id: "paper", name: "Ann", team: team("paper") },
      ],
    });

    await admin.api.onboarding.saveRoster(roster(() => "sales"));
    const draft = await membersTeams(admin);
    const events = await auditedDuring(async () => {
      await admin.api.onboarding.confirmRoster(roster(() => "sales"));
    });
    const confirmed = await membersTeams(admin);
    const theirs = await ann.api.whoami();

    expect({
      draft: draft.get(`Sales ${tag}`)?.memberIds,
      confirmed: confirmed.get(`Sales ${tag}`)?.memberIds,
      // The id a person's team has on the list is the one their member
      // teams carry: what their observed routines name (GRA-2035).
      theirs: theirs.teams.map(({ id }) => id),
      events: events
        .filter(({ action }) => action.startsWith("team.member."))
        .map(({ action, target, detail }) => ({
          action,
          target: target?.id,
          detail,
        })),
    }).toStrictEqual({
      draft: [],
      confirmed: [ann.userId],
      theirs: [confirmed.get(`Sales ${tag}`)?.id],
      events: [
        {
          action: "team.member.added",
          target: confirmed.get(`Sales ${tag}`)?.id,
          detail: { userId: ann.userId, via: "staffList" },
        },
      ],
    });
  });

  it("move a member out of the team the list gave them, never out of one an admin added them to", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const tag = unique();
    const extra = await settingsTeam(admin, `Board ${tag}`);
    await callAuth("/organization/add-team-member", admin.session, {
      teamId: extra,
      userId: ann.userId,
    });
    const roster = (team: string): RosterInput => ({
      teams: [
        { id: "sales", name: `Sales ${tag}`, lead: null },
        { id: "finance", name: `Finance ${tag}`, lead: null },
      ],
      people: [{ id: "ann", name: "Ann", email: emailOf(ann), team }],
    });
    await admin.api.onboarding.confirmRoster(roster("sales"));
    const before = await membersTeams(admin);

    await admin.api.onboarding.confirmRoster(roster("finance"));
    const moved = await membersTeams(admin);
    // Taken off the list: out of the team it gave them.
    await admin.api.onboarding.confirmRoster({
      teams: [{ id: "x", name: `Sales ${tag}`, lead: null }],
      people: [{ id: "bo", name: "Bo", team: "x" }],
    });
    const off = await membersTeams(admin);

    const inTeams = (teams: typeof before) =>
      [...teams]
        .filter(([, { memberIds }]) => memberIds.includes(ann.userId))
        .map(([name]) => name)
        .toSorted();
    expect({
      before: inTeams(before),
      moved: inTeams(moved),
      off: inTeams(off),
    }).toStrictEqual({
      before: [`Board ${tag}`, `Sales ${tag}`],
      moved: [`Board ${tag}`, `Finance ${tag}`],
      off: [`Board ${tag}`],
    });
  });
});
