import type { RosterInput } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
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
  it("are the members' teams: one id each, a new one core's own, made only once the admin confirms", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const support = await settingsTeam(admin, `Support ${tag}`);
    const roster = (sales: string): RosterInput => ({
      teams: [
        { id: `sales-${tag}`, name: sales, lead: null },
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
    });

    // A typo, saved as a draft and put right: no team is left behind.
    await admin.api.onboarding.saveRoster(roster(`Salse ${tag}`));
    const drafted = await membersTeams(admin);
    await admin.api.onboarding.saveRoster(roster(`Sales ${tag}`));
    const events = await auditedDuring(async () => {
      await admin.api.onboarding.confirmRoster(roster(`Sales ${tag}`));
    });
    const members = await membersTeams(admin);
    const list = await listTeams(admin);
    const { roster: saved } = await admin.api.onboarding.view();
    const sales = members.get(`Sales ${tag}`)?.id;

    expect({
      drafted: [...drafted.keys()].filter((name) => name.endsWith(tag)),
      typo: members.has(`Salse ${tag}`),
      sameIds: [...list].every(([name, id]) => members.get(name)?.id === id),
      support: list.get(`support ${tag.toUpperCase()}`),
      salesIsCores: sales !== undefined && sales !== `sales-${tag}`,
      people: saved?.people.map(({ team }) => team),
      created: events
        .filter(({ action }) => action === "team.created")
        .map(({ target, detail }) => ({ id: target?.id, detail })),
    }).toStrictEqual({
      drafted: [`Support ${tag}`],
      typo: false,
      sameIds: true,
      support,
      salesIsCores: true,
      people: [sales, support],
      created: [{ id: sales, detail: { via: "staffList" } }],
    });
    // Renamed by the list: the members' team follows, under its id.
    await admin.api.onboarding.confirmRoster({
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
    await admin.api.onboarding.confirmRoster({
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
      // A draft makes no team, nor puts anyone in one.
      draft: draft.has(`Sales ${tag}`),
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
      draft: false,
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

  it("move a member out of the team the list gave them, never out of one an admin added them to, though the list names it", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const tag = unique();
    // Added by hand before the list, which then names the same team.
    const board = await settingsTeam(admin, `Board ${tag}`);
    await callAuth("/organization/add-team-member", admin.session, {
      teamId: board,
      userId: ann.userId,
    });
    const roster = (team: string): RosterInput => ({
      teams: [
        { id: "board", name: `Board ${tag}`, lead: null },
        { id: "sales", name: `Sales ${tag}`, lead: null },
        { id: "finance", name: `Finance ${tag}`, lead: null },
      ],
      people: [
        { id: "ann", name: "Ann", email: emailOf(ann), team },
        { id: "bo", name: "Bo", team: "sales" },
      ],
    });
    const ids = (kept: Awaited<ReturnType<typeof listTeams>>) => ({
      board: kept.get(`Board ${tag}`) ?? "",
      sales: kept.get(`Sales ${tag}`) ?? "",
      finance: kept.get(`Finance ${tag}`) ?? "",
    });
    await admin.api.onboarding.confirmRoster(roster("board"));
    const kept = ids(await listTeams(admin));
    const named = (team: keyof typeof kept): RosterInput => ({
      teams: [
        { id: kept.board, name: `Board ${tag}`, lead: null },
        { id: kept.sales, name: `Sales ${tag}`, lead: null },
        { id: kept.finance, name: `Finance ${tag}`, lead: null },
      ],
      people: [
        { id: "ann", name: "Ann", email: emailOf(ann), team: kept[team] },
        { id: "bo", name: "Bo", team: kept.sales },
      ],
    });
    const inTeams = async () => {
      const teams = await membersTeams(admin);
      return [...teams]
        .filter(([, { memberIds }]) => memberIds.includes(ann.userId))
        .map(([name]) => name)
        .toSorted();
    };
    const before = await inTeams();

    await admin.api.onboarding.confirmRoster(named("sales"));
    const moved = await inTeams();
    await admin.api.onboarding.confirmRoster(named("finance"));
    const movedAgain = await inTeams();
    // Taken off the list: out of the team it gave them.
    await admin.api.onboarding.confirmRoster({
      teams: [{ id: kept.sales, name: `Sales ${tag}`, lead: null }],
      people: [{ id: "bo", name: "Bo", team: kept.sales }],
    });
    const off = await inTeams();

    expect({ before, moved, movedAgain, off }).toStrictEqual({
      before: [`Board ${tag}`],
      // Board was the admin's: the list never made it, so never takes it.
      moved: [`Board ${tag}`, `Sales ${tag}`],
      movedAgain: [`Board ${tag}`, `Finance ${tag}`],
      off: [`Board ${tag}`],
    });
  });

  it("leave a member out of the team an admin took them out of, until the list gives them another", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const tag = unique();
    await admin.api.onboarding.confirmRoster({
      teams: [
        { id: "sales", name: `Sales ${tag}`, lead: null },
        { id: "finance", name: `Finance ${tag}`, lead: null },
      ],
      people: [{ id: "ann", name: "Ann", email: emailOf(ann), team: "sales" }],
    });
    const kept = await listTeams(admin);
    const sales = kept.get(`Sales ${tag}`) ?? "";
    const finance = kept.get(`Finance ${tag}`) ?? "";
    const listed = (team: string): RosterInput => ({
      teams: [
        { id: sales, name: `Sales ${tag}`, lead: null },
        { id: finance, name: `Finance ${tag}`, lead: null },
      ],
      people: [{ id: "ann", name: "Ann", email: emailOf(ann), team }],
    });
    const inTeams = async () => {
      const teams = await membersTeams(admin);
      return [...teams]
        .filter(([, { memberIds }]) => memberIds.includes(ann.userId))
        .map(([name]) => name)
        .toSorted();
    };

    await callAuth("/organization/remove-team-member", admin.session, {
      teamId: sales,
      userId: ann.userId,
    });
    // Her line untouched: the admin's removal stands.
    await admin.api.onboarding.confirmRoster(listed(sales));
    const untouched = await inTeams();
    // The list moves her: it gives her another team, so she joins it.
    await admin.api.onboarding.confirmRoster(listed(finance));
    const moved = await inTeams();
    // Added back to Finance by hand, it is the admin's: moving her on the
    // list leaves it.
    await callAuth("/organization/remove-team-member", admin.session, {
      teamId: finance,
      userId: ann.userId,
    });
    await callAuth("/organization/add-team-member", admin.session, {
      teamId: finance,
      userId: ann.userId,
    });
    await admin.api.onboarding.confirmRoster(listed(sales));
    const handMade = await inTeams();

    expect({ untouched, moved, handMade }).toStrictEqual({
      untouched: [],
      moved: [`Finance ${tag}`],
      handMade: [`Finance ${tag}`, `Sales ${tag}`],
    });
  });

  it("add a membership as Better Auth does, so the same one added twice stays one row", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const tag = unique();
    const sales = await settingsTeam(admin, `Sales ${tag}`);
    // Better Auth's own row for her, then taken away by hand: its key.
    await callAuth("/organization/add-team-member", admin.session, {
      teamId: sales,
      userId: ann.userId,
    });
    const keyOf = async () =>
      await env.DB.prepare(
        "SELECT membership_key AS key FROM team_members WHERE team_id = ? AND user_id = ?"
      )
        .bind(sales, ann.userId)
        .all<{ key: string | null }>();
    const { results: byBetterAuth } = await keyOf();
    await callAuth("/organization/remove-team-member", admin.session, {
      teamId: sales,
      userId: ann.userId,
    });

    await admin.api.onboarding.confirmRoster({
      teams: [{ id: sales, name: `Sales ${tag}`, lead: null }],
      people: [{ id: "ann", name: "Ann", email: emailOf(ann), team: sales }],
    });
    const { results: byList } = await keyOf();
    // Added again by hand: Better Auth finds hers by that key.
    const again = await callAuth(
      "/organization/add-team-member",
      admin.session,
      { teamId: sales, userId: ann.userId }
    );
    const { results: after } = await keyOf();

    expect({
      byList,
      again: again.ok,
      rows: after.length,
    }).toStrictEqual({ byList: byBetterAuth, again: true, rows: 1 });
  });

  it("keep what the admin set for a team on the draft once the confirm gives it its id: held for later, it stays held", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const roster: RosterInput = {
      teams: [
        { id: "ops", name: `Ops ${tag}`, lead: null },
        { id: "later", name: `Later ${tag}`, lead: null, does: "Plans it" },
      ],
      people: [
        { id: `oli-${tag}`, name: "Oli", team: "ops" },
        { id: `lou-${tag}`, name: "Lou", team: "later" },
      ],
    };
    await admin.api.onboarding.saveRoster(roster);
    // Held for later while it is a draft's team, under the draft's id.
    await admin.api.onboarding.savePlan({
      start: new Date().toISOString().slice(0, 10),
      later: { later: null },
    });

    const { roster: kept, plan } =
      await admin.api.onboarding.confirmRoster(roster);
    const later = kept?.teams.find(({ name }) => name === `Later ${tag}`);

    expect({
      moved: later !== undefined && later.id !== "later",
      does: later?.does,
      lou: kept?.people.find(({ name }) => name === "Lou")?.team,
      held: plan?.later,
    }).toStrictEqual({
      moved: true,
      does: "Plans it",
      lou: later?.id,
      held: { [later?.id ?? ""]: null },
    });
  });
});
