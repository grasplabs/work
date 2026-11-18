import { rosterSchema } from "@grasp-os/shared/onboarding";
import type { RosterInput } from "@grasp-os/shared/onboarding";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import { intoMembersTeams, placePrimaries } from "../src/staff-list-teams.ts";
import { adminCommands } from "./admin-command.ts";
import { add, markerWord, textsFor } from "./brain-next-leaks-harness.ts";
import { landingAt } from "./d1-landing.ts";
import { mockIdp } from "./idp.ts";
import { aloneInTheStore } from "./interview-link.ts";
import {
  agree,
  fact,
  mapped,
  team as teamOnTheList,
} from "./onboarding-team.ts";
import { clientOrigin } from "./sign-in-config.ts";
import {
  auditedDuring,
  callAuth,
  openRpc,
  routed,
  signedInApi,
  unique,
} from "./sign-in.ts";

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

const dayMs = 24 * 60 * 60 * 1000;

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

/** Which of a team's columns hold a value, as Better Auth reads its row. */
const shapeOf = async (id: string) => {
  const row = await env.DB.prepare("SELECT * FROM teams WHERE id = ?")
    .bind(id)
    .first();
  return Object.fromEntries(
    Object.entries(row ?? {}).map(([column, value]) => [
      column,
      column === "member_count" ? value : value !== null,
    ])
  );
};

/** An admin's add of `userId` to `teamId` in Settings › Members, on `coreEnv`. */
const addByHand = async (
  admin: Admin,
  teamId: string,
  userId: string,
  coreEnv: Env
): Promise<Response> =>
  await routed(
    "/api/auth/organization/add-team-member",
    {
      method: "POST",
      headers: {
        origin: clientOrigin,
        cookie: admin.session,
        "content-type": "application/json",
      },
      body: JSON.stringify({ teamId, userId }),
    },
    coreEnv
  );

/** `admin`'s confirm of `roster`, through core on `coreEnv`. */
const confirmOn = async (
  admin: Admin,
  coreEnv: Env,
  roster: RosterInput
): Promise<void> => {
  const { core } = await openRpc(admin.session, { coreEnv });
  try {
    using session = core.authenticate();
    await session.onboarding.confirmRoster(roster);
  } finally {
    core[Symbol.dispose]();
  }
};

/** How many pieces of work the store holds for `team`. */
const worksOf = async (team: string): Promise<number> =>
  await runInDurableObject(
    onboardingStore(env),
    (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>(
          "SELECT count(*) AS n FROM works WHERE team = ?",
          team
        )
        .one().n
  );

/** `userId`'s primary rows (`team_primaries`), as the database has them. */
const primariesOf = async (userId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT team_id AS team, made FROM team_primaries WHERE user_id = ?"
  )
    .bind(userId)
    .all<{ team: string; made: number }>();
  return results;
};

/** How many audit events the outbox refused (`audit_outbox_rejected`). */
const rejectedCount = async (): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM audit_outbox_rejected"
  ).first<{ n: number }>();
  return row?.n ?? 0;
};

/**
 * Writes the store's team rows again as a release from before
 * `teams.minted` wrote them, or an older one after a rollback: without
 * the column, so its default fills it.
 */
const asAnEarlierReleaseWrote = async (): Promise<void> => {
  await runInDurableObject(onboardingStore(env), (_instance, state) => {
    const columns =
      "id, position, name, lead, does, mapped_does, off, mapped_at, mapped_from";
    const rows = state.storage.sql
      .exec(`SELECT ${columns} FROM teams`)
      .toArray();
    state.storage.sql.exec("DELETE FROM teams");
    for (const row of rows) {
      state.storage.sql.exec(
        `INSERT INTO teams (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.position,
        row.name,
        row.lead,
        row.does,
        row.mapped_does,
        row.off,
        row.mapped_at,
        row.mapped_from
      );
    }
  });
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
    // Its id never comes back, on a draft or a confirm: the list sending it
    // again gets a team of a new id.
    const { roster: redrafted } = await admin.api.onboarding.saveRoster({
      teams: [
        { id: ops, name: `Operations ${tag}`, lead: null },
        { id: old, name: `Old ${tag}`, lead: null },
      ],
      people: [{ id: `cy-${tag}`, name: "Cy", team: old }],
    });
    const drafted = redrafted?.teams.find(
      ({ name }) => name === `Old ${tag}`
    )?.id;
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
      drafted: drafted !== undefined && drafted !== old,
    }).toStrictEqual({
      listed: ops,
      read: `Operations ${tag}`,
      refused: 409,
      removed: 200,
      again: true,
      drafted: true,
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

  it("keep a team's id from the draft that first names it, so a team held for later on the draft stays held, and sends its people nothing", async () => {
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
    const { roster: drafted } = await admin.api.onboarding.saveRoster(roster);
    const draftedLater = drafted?.teams.find(
      ({ name }) => name === `Later ${tag}`
    )?.id;
    // Held for later while it is a draft's team, under the id core gave it.
    await admin.api.onboarding.savePlan({
      start: new Date().toISOString().slice(0, 10),
      later: { [draftedLater ?? ""]: null },
    });
    const draftTeams = await membersTeams(admin);

    // The admin's page sends the list as it read it back.
    if (drafted === null) {
      throw new Error("The draft wasn't kept");
    }
    const { roster: kept, plan } =
      await admin.api.onboarding.confirmRoster(drafted);
    const later = kept?.teams.find(({ name }) => name === `Later ${tag}`);
    await adminCommands().setAgreements({
      processing: true,
      assessment: true,
      council: "none",
    });
    const store = onboardingStore(env);
    await store.releaseDue();
    await store.releaseDue(new Date(Date.now() + 60 * dayMs).toISOString());
    const out = await store.sentLinks();
    const sent = new Set(out.map(({ person }) => person));

    expect({
      coresOwn: draftedLater !== undefined && draftedLater !== "later",
      // A draft makes no members' team.
      inSettings: draftTeams.has(`Later ${tag}`),
      kept: later?.id,
      does: later?.does,
      lou: kept?.people.find(({ name }) => name === "Lou")?.team,
      held: plan?.later,
      sent: { oli: sent.has(`oli-${tag}`), lou: sent.has(`lou-${tag}`) },
    }).toStrictEqual({
      coresOwn: true,
      inSettings: false,
      kept: draftedLater,
      does: "Plans it",
      lou: draftedLater,
      held: { [draftedLater ?? ""]: null },
      sent: { oli: true, lou: false },
    });
  });

  it("count an interview finished while its team was only on a draft for that team once the admin confirms", async () => {
    const admin = await signedInApi(idp, "admin");
    const ids = await teamOnTheList(["lea", "max", "mia"]);
    const store = onboardingStore(env);
    // Everyone's link out, as days on.
    await store.releaseDue(new Date(Date.now() + 10 * dayMs).toISOString());
    const listed = await store.view();
    if (listed.roster === null) {
      throw new Error("No staff list");
    }
    // Max moves to a team new on a draft, his link in hand.
    const { roster: drafted } = await admin.api.onboarding.saveRoster({
      teams: [
        ...listed.roster.teams,
        { id: "desk", name: `Desk ${ids.team}`, lead: null },
      ],
      people: listed.roster.people.map((person) =>
        person.id === ids.max ? { ...person, team: "desk" } : person
      ),
    });
    const desk = drafted?.teams.find(
      ({ name }) => name === `Desk ${ids.team}`
    )?.id;
    await agree(ids.max, [
      fact("f1", "system", "We log every ticket in Zendesk first."),
    ]);
    if (drafted === null) {
      throw new Error("The draft wasn't kept");
    }

    await admin.api.onboarding.confirmRoster(drafted);
    const showing = await store.interviewSources();
    const sources = showing.map(({ team: of }) => of);

    expect({
      coresOwn: desk !== "desk",
      counts: sources.includes(desk ?? ""),
    }).toStrictEqual({
      coresOwn: true,
      counts: true,
    });
  });

  it("keep a draft team where the admin placed it on the Brain's map once the admin confirms", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const { roster: drafted } = await admin.api.onboarding.saveRoster({
      teams: [{ id: `desk-${tag}`, name: `Desk ${tag}`, lead: null }],
      people: [{ id: `dee-${tag}`, name: "Dee", team: `desk-${tag}` }],
    });
    const desk = drafted?.teams[0]?.id ?? "";
    // Placed by the admin while the team is only on the draft.
    await admin.api.brain.saveTeamGroups([
      { id: `front-${tag}`, name: "Front office", teamIds: [`team-${desk}`] },
    ]);
    if (drafted === null) {
      throw new Error("The draft wasn't kept");
    }

    await admin.api.onboarding.confirmRoster(drafted);
    const { teamGroups } = await admin.api.brain.read();

    expect(
      teamGroups.find(({ id }) => id === `front-${tag}`)?.teamIds
    ).toStrictEqual([`team-${desk}`]);
  });

  it("make a confirmed team as Better Auth makes one in Settings, under the id the draft gave it", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const settings = await settingsTeam(admin, `Made ${tag}`);
    const { roster: drafted } = await admin.api.onboarding.saveRoster({
      teams: [{ id: "listed", name: `Listed ${tag}`, lead: null }],
      people: [{ id: `ivy-${tag}`, name: "Ivy", team: "listed" }],
    });
    if (drafted === null) {
      throw new Error("The draft wasn't kept");
    }
    await admin.api.onboarding.confirmRoster(drafted);
    const listedId = drafted.teams[0]?.id ?? "";
    await expect(shapeOf(listedId)).resolves.toStrictEqual(
      await shapeOf(settings)
    );
  });

  it("leave an admin's add theirs when a confirm places the same membership while Better Auth adds it", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const tag = unique();
    const { roster: first } = await admin.api.onboarding.confirmRoster({
      teams: [
        { id: "sales", name: `Sales ${tag}`, lead: null },
        { id: "finance", name: `Finance ${tag}`, lead: null },
      ],
      people: [{ id: "bo", name: "Bo", team: "sales" }],
    });
    const idOf = (name: string): string =>
      first?.teams.find((each) => each.name === `${name} ${tag}`)?.id ?? "";
    const listed = (annIn: string): RosterInput => ({
      teams: [
        { id: idOf("Sales"), name: `Sales ${tag}`, lead: null },
        { id: idOf("Finance"), name: `Finance ${tag}`, lead: null },
      ],
      people: [
        { id: "bo", name: "Bo", team: idOf("Sales") },
        { id: "ann", name: "Ann", email: emailOf(ann), team: annIn },
      ],
    });
    // The confirm lands after Better Auth's before-hook, just before it
    // looks for the membership: it finds the row the confirm made.
    const landing = landingAt(/from "team_members"/iu, "before", async () => {
      await admin.api.onboarding.confirmRoster(listed(idOf("Sales")));
    });
    const added = await addByHand(
      admin,
      idOf("Sales"),
      ann.userId,
      landing.coreEnv
    );
    // The list moves her: the membership the admin added stays.
    await admin.api.onboarding.confirmRoster(listed(idOf("Finance")));
    const teams = await membersTeams(admin);

    expect({
      landed: landing.landed(),
      added: added.ok,
      sales: teams.get(`Sales ${tag}`)?.memberIds.includes(ann.userId),
      finance: teams.get(`Finance ${tag}`)?.memberIds.includes(ann.userId),
    }).toStrictEqual({
      landed: true,
      added: true,
      sales: true,
      finance: true,
    });
  });

  it("leave an admin's add back theirs when a confirm moving them lands just after Better Auth's insert", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const tag = unique();
    const roster = (annIn: string): RosterInput => ({
      teams: [
        { id: "sales", name: `Sales ${tag}`, lead: null },
        { id: "finance", name: `Finance ${tag}`, lead: null },
      ],
      people: [{ id: "ann", name: "Ann", email: emailOf(ann), team: annIn }],
    });
    const { roster: first } = await admin.api.onboarding.confirmRoster(
      roster("sales")
    );
    const idOf = (name: string): string =>
      first?.teams.find((each) => each.name === `${name} ${tag}`)?.id ?? "";
    const listed = (annIn: string): RosterInput => ({
      teams: [
        { id: idOf("Sales"), name: `Sales ${tag}`, lead: null },
        { id: idOf("Finance"), name: `Finance ${tag}`, lead: null },
      ],
      people: [{ id: "ann", name: "Ann", email: emailOf(ann), team: annIn }],
    });
    // The list's membership, taken away by hand, then added back by hand.
    await callAuth("/organization/remove-team-member", admin.session, {
      teamId: idOf("Sales"),
      userId: ann.userId,
    });
    const landing = landingAt(
      /insert into "team_members"/iu,
      "after",
      async () => {
        await admin.api.onboarding.confirmRoster(listed(idOf("Finance")));
      }
    );
    const added = await addByHand(
      admin,
      idOf("Sales"),
      ann.userId,
      landing.coreEnv
    );
    const teams = await membersTeams(admin);

    expect({
      landed: landing.landed(),
      added: added.ok,
      sales: teams.get(`Sales ${tag}`)?.memberIds.includes(ann.userId),
      finance: teams.get(`Finance ${tag}`)?.memberIds.includes(ann.userId),
    }).toStrictEqual({
      landed: true,
      added: true,
      sales: true,
      finance: true,
    });
  });

  it("never apply an older confirm after a newer one that landed before its writes: the newer list stands, every event says so", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const bea = await signedInApi(idp, "user");
    const tag = unique();
    const { roster: first } = await admin.api.onboarding.confirmRoster({
      teams: [
        { id: "sales", name: `Sales ${tag}`, lead: null },
        { id: "finance", name: `Finance ${tag}`, lead: null },
      ],
      people: [{ id: "bo", name: "Bo", team: "sales" }],
    });
    const idOf = (name: string): string =>
      first?.teams.find((each) => each.name === `${name} ${tag}`)?.id ?? "";
    const listed = (annIn: string, beaIn: string): RosterInput => ({
      teams: [
        { id: idOf("Sales"), name: `Sales ${tag}`, lead: null },
        { id: idOf("Finance"), name: `Finance ${tag}`, lead: null },
      ],
      people: [
        { id: "bo", name: "Bo", team: idOf("Sales") },
        { id: "ann", name: "Ann", email: emailOf(ann), team: annIn },
        { id: "bea", name: "Bea", email: emailOf(bea), team: beaIn },
      ],
    });
    const sales = idOf("Sales");
    const finance = idOf("Finance");
    // Ann: both confirms give Sales. Bea: the newer gives Finance, the
    // older Sales, whose writes would land last.
    const landing = landingAt(
      /insert into "team_primaries"/iu,
      "before",
      async () => {
        await admin.api.onboarding.confirmRoster(listed(sales, finance));
      }
    );
    const rejectedBefore = await rejectedCount();
    const audited = await auditedDuring(async () => {
      await confirmOn(admin, landing.coreEnv, listed(sales, sales));
    });
    const nameOf = new Map([
      [sales, "sales"],
      [finance, "finance"],
      [ann.userId, "ann"],
      [bea.userId, "bea"],
    ]);
    // Every event of both confirms, each naming what it did, and no gap.
    const events = audited
      .filter(
        ({ action }) =>
          action.startsWith("team.member.") || action === "audit.gap"
      )
      .map(
        ({ action, target, detail }) =>
          `${action} ${nameOf.get(target?.id ?? "") ?? target?.id} ${nameOf.get(String(detail?.userId)) ?? "?"}`
      )
      .toSorted();
    const rejected = (await rejectedCount()) - rejectedBefore;
    const overlapped = {
      ann: await primariesOf(ann.userId),
      bea: await primariesOf(bea.userId),
    };
    // A later move takes away what the list made, and leaves nothing stray.
    await admin.api.onboarding.confirmRoster(listed(finance, finance));
    const teams = await membersTeams(admin);
    const inTeams = (userId: string) =>
      [...teams]
        .filter(([, { memberIds }]) => memberIds.includes(userId))
        .map(([name]) => name);

    expect({
      landed: landing.landed(),
      overlapped,
      events,
      rejected,
      ann: inTeams(ann.userId),
      bea: inTeams(bea.userId),
    }).toStrictEqual({
      landed: true,
      overlapped: {
        ann: [{ team: sales, made: 1 }],
        bea: [{ team: finance, made: 1 }],
      },
      // The newer confirm placed both; the older one then wrote nothing.
      events: ["team.member.added finance bea", "team.member.added sales ann"],
      rejected: 0,
      ann: [`Finance ${tag}`],
      bea: [`Finance ${tag}`],
    });
  });

  it("make a team deleted while a save ran under a new id at the confirm, so nothing shared with the old one reaches its people", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const tag = unique();
    const marker = markerWord();
    const board = await settingsTeam(admin, `Board ${tag}`);
    await add(`Board minutes ${marker}`, { kind: "team", teamId: board });
    const roster = rosterSchema.parse({
      teams: [{ id: board, name: `Board ${tag}`, lead: null }],
      people: [{ id: "ann", name: "Ann", email: emailOf(ann), team: board }],
    });
    const by = { type: "person", userId: admin.userId } as const;
    const store = onboardingStore(env);
    // A draft save reads the members' teams, Board among them...
    const { roster: named, minted } = await intoMembersTeams(env, roster, by, {
      make: false,
      held: async () => await store.heldTeams(),
    });
    // ...an admin deletes Board in Settings before the store keeps it...
    const deleted = await callAuth("/organization/remove-team", admin.session, {
      teamId: board,
    });
    await store.saveRoster(named, by, { confirmed: false, minted });
    // ...and the next confirm sends the list as it read it back.
    const { roster: draft } = await admin.api.onboarding.view();
    if (draft === null) {
      throw new Error("The draft wasn't kept");
    }
    const { roster: kept } = await admin.api.onboarding.confirmRoster(draft);
    const again = kept?.teams.find(({ name }) => name === `Board ${tag}`)?.id;
    const teams = await membersTeams(admin);
    const texts = await textsFor(ann.userId, marker);

    expect({
      deleted: deleted.status,
      draftKeptOld: named.teams[0]?.id === board,
      newId: again !== undefined && again !== board,
      annIn: teams.get(`Board ${tag}`)?.memberIds.includes(ann.userId),
      reads: texts.some((text) => text.includes(marker)),
    }).toStrictEqual({
      deleted: 200,
      draftKeptOld: true,
      newId: true,
      annIn: true,
      reads: false,
    });
  });

  it("place nobody an admin removed while the confirm ran", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const tag = unique();
    const { roster: first } = await admin.api.onboarding.confirmRoster({
      teams: [{ id: "sales", name: `Sales ${tag}`, lead: null }],
      people: [{ id: "bo", name: "Bo", team: "sales" }],
    });
    const sales = first?.teams[0]?.id ?? "";
    // Removed just before the placing batch runs: its read still saw her.
    const landing = landingAt(
      /insert into "team_members"/iu,
      "before",
      async () => {
        await admin.api.members.remove(ann.userId);
      }
    );
    await confirmOn(admin, landing.coreEnv, {
      teams: [{ id: sales, name: `Sales ${tag}`, lead: null }],
      people: [
        { id: "bo", name: "Bo", team: sales },
        { id: "ann", name: "Ann", email: emailOf(ann), team: sales },
      ],
    });
    const teams = await membersTeams(admin);

    expect({
      landed: landing.landed(),
      inSales: teams.get(`Sales ${tag}`)?.memberIds.includes(ann.userId),
      primaries: await primariesOf(ann.userId),
    }).toStrictEqual({ landed: true, inSales: false, primaries: [] });
  });

  it("never make a team the list made once again under its id after an admin deleted it, though a stale confirm still holds it", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const tag = unique();
    const marker = markerWord();
    const by = { type: "person", userId: admin.userId } as const;
    const store = onboardingStore(env);
    const listed = (board: string, sales: string): RosterInput => ({
      teams: [
        { id: board, name: `Board ${tag}`, lead: null },
        { id: sales, name: `Sales ${tag}`, lead: null },
      ],
      people: [
        { id: "ann", name: "Ann", email: emailOf(ann), team: board },
        { id: "bo", name: "Bo", team: sales },
      ],
    });
    // A confirm makes Board under the id core minted; its minutes are shared.
    const { roster: first } = await admin.api.onboarding.confirmRoster(
      listed("board", "sales")
    );
    const idOf = (name: string): string =>
      first?.teams.find((team) => team.name === `${name} ${tag}`)?.id ?? "";
    const board = idOf("Board");
    const sales = idOf("Sales");
    await add(`Board minutes ${marker}`, { kind: "team", teamId: board });
    // A stale tab's confirm read the store while Board was on it...
    const staleHeld = await store.heldTeams();
    // ...then another save takes Board off and an admin deletes it...
    await admin.api.onboarding.saveRoster({
      teams: [{ id: sales, name: `Sales ${tag}`, lead: null }],
      people: [{ id: "bo", name: "Bo", team: sales }],
    });
    const deleted = await callAuth("/organization/remove-team", admin.session, {
      teamId: board,
    });
    // ...and the stale confirm goes on: Board held and minted, to it.
    const stale = rosterSchema.parse(listed(board, sales));
    const { roster: named, minted } = await intoMembersTeams(env, stale, by, {
      make: true,
      held: async () => await Promise.resolve(staleHeld),
    });
    await store.saveRoster(named, by, { confirmed: true, minted });
    await placePrimaries(env, by);
    const again = named.teams.find(({ name }) => name === `Board ${tag}`)?.id;
    const teams = await membersTeams(admin);
    const texts = await textsFor(ann.userId, marker);

    expect({
      deleted: deleted.status,
      newId: again !== undefined && again !== board,
      annIn: teams.get(`Board ${tag}`)?.memberIds.includes(ann.userId),
      reads: texts.some((text) => text.includes(marker)),
    }).toStrictEqual({ deleted: 200, newId: true, annIn: true, reads: false });
  });

  it("never make a team again under an id the list made while its confirm ran, when the admin deleted it in between", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const tag = unique();
    const marker = markerWord();
    const listed: RosterInput = {
      teams: [
        { id: "board", name: `Board ${tag}`, lead: null },
        { id: "sales", name: `Sales ${tag}`, lead: null },
      ],
      people: [
        { id: "ann", name: "Ann", email: emailOf(ann), team: "board" },
        { id: "bo", name: "Bo", team: "sales" },
      ],
    };
    // Board is only on a draft: no members' team yet, its id core's own.
    const { roster: drafted } = await admin.api.onboarding.saveRoster(listed);
    if (drafted === null) {
      throw new Error("The draft wasn't kept");
    }
    const board =
      drafted.teams.find(({ name }) => name === `Board ${tag}`)?.id ?? "";
    const sales =
      drafted.teams.find(({ name }) => name === `Sales ${tag}`)?.id ?? "";
    // A confirm from a stale tab read Board as still to make. Just before
    // it makes it, another confirm made it, its minutes were shared, it
    // was taken off the list and an admin deleted it.
    const landing = landingAt(/insert into "teams"/iu, "before", async () => {
      await admin.api.onboarding.confirmRoster(drafted);
      await add(`Board minutes ${marker}`, { kind: "team", teamId: board });
      await admin.api.onboarding.saveRoster({
        teams: [{ id: sales, name: `Sales ${tag}`, lead: null }],
        people: [{ id: "bo", name: "Bo", team: sales }],
      });
      await callAuth("/organization/remove-team", admin.session, {
        teamId: board,
      });
    });
    await confirmOn(admin, landing.coreEnv, drafted);
    const afterStale = await membersTeams(admin);
    // The next confirm gives Board a new id.
    const { roster: held } = await admin.api.onboarding.view();
    if (held === null) {
      throw new Error("No staff list");
    }
    const { roster: kept } = await admin.api.onboarding.confirmRoster(held);
    const again = kept?.teams.find(({ name }) => name === `Board ${tag}`)?.id;
    const teams = await membersTeams(admin);
    const texts = await textsFor(ann.userId, marker);

    expect({
      landed: landing.landed(),
      madeAgain: afterStale.get(`Board ${tag}`)?.id === board,
      newId: again !== undefined && again !== board,
      annIn: teams.get(`Board ${tag}`)?.memberIds.includes(ann.userId),
      reads: texts.some((text) => text.includes(marker)),
    }).toStrictEqual({
      landed: true,
      madeAgain: false,
      newId: true,
      annIn: true,
      reads: false,
    });
  });

  it("count each team's members as the newer confirm left them, when it lands inside an older one", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const tag = unique();
    const names = ["A", "B", "C"].map((letter) => `${letter} ${tag}`);
    const { roster: first } = await admin.api.onboarding.confirmRoster({
      teams: names.map((name, index) => ({
        id: `t${index}`,
        name,
        lead: null,
      })),
      people: [{ id: "ann", name: "Ann", email: emailOf(ann), team: "t0" }],
    });
    const ids = names.map(
      (name) => first?.teams.find((team) => team.name === name)?.id ?? ""
    );
    const listed = (annIn: number): RosterInput => ({
      teams: names.map((name, index) => ({
        id: ids[index] ?? "",
        name,
        lead: null,
      })),
      people: [
        { id: "ann", name: "Ann", email: emailOf(ann), team: ids[annIn] ?? "" },
      ],
    });
    // This confirm read Ann in A and moves her to B; just before its
    // writes, a newer one moved her to C: C stands.
    const landing = landingAt(
      /insert into "team_primaries"/iu,
      "before",
      async () => {
        await admin.api.onboarding.confirmRoster(listed(2));
      }
    );
    await confirmOn(admin, landing.coreEnv, listed(1));
    const { results } = await env.DB.prepare(
      `SELECT name, member_count AS counted,
         (SELECT count(*) FROM team_members WHERE team_id = teams.id) AS members
       FROM teams WHERE id IN (?, ?, ?) ORDER BY name`
    )
      .bind(...ids)
      .all<{ name: string; counted: number; members: number }>();

    expect({ landed: landing.landed(), results }).toStrictEqual({
      landed: true,
      results: [
        { name: names[0], counted: 0, members: 0 },
        { name: names[1], counted: 0, members: 0 },
        { name: names[2], counted: 1, members: 1 },
      ],
    });
  });

  it("never apply a confirm that saved its list before a newer one but placed after it", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const tag = unique();
    const { roster: first } = await admin.api.onboarding.confirmRoster({
      teams: [
        { id: "sales", name: `Sales ${tag}`, lead: null },
        { id: "finance", name: `Finance ${tag}`, lead: null },
      ],
      people: [{ id: "bo", name: "Bo", team: "sales" }],
    });
    const idOf = (name: string): string =>
      first?.teams.find((each) => each.name === `${name} ${tag}`)?.id ?? "";
    const listed = (annIn: string): RosterInput => ({
      teams: [
        { id: idOf("Sales"), name: `Sales ${tag}`, lead: null },
        { id: idOf("Finance"), name: `Finance ${tag}`, lead: null },
      ],
      people: [
        { id: "bo", name: "Bo", team: idOf("Sales") },
        { id: "ann", name: "Ann", email: emailOf(ann), team: annIn },
      ],
    });
    // Confirm A has saved Sales and pauses before it places; B saves
    // Finance and finishes; A goes on.
    const landing = landingAt(
      /insert into "staff_list_placed"/iu,
      "before",
      async () => {
        await admin.api.onboarding.confirmRoster(listed(idOf("Finance")));
      }
    );
    const audited = await auditedDuring(async () => {
      await confirmOn(admin, landing.coreEnv, listed(idOf("Sales")));
    });
    const { roster: saved } = await admin.api.onboarding.view();
    const teams = await membersTeams(admin);
    const sales = idOf("Sales");

    expect({
      landed: landing.landed(),
      // A placed nothing, not even for a moment: B's placing is all there is.
      events: audited
        .filter(({ action }) => action.startsWith("team.member."))
        .map(
          ({ action, target }) =>
            `${action} ${target?.id === sales ? "sales" : "finance"}`
        ),
      list: saved?.people.find(({ id }) => id === "ann")?.team,
      sales: teams.get(`Sales ${tag}`)?.memberIds.includes(ann.userId),
      finance: teams.get(`Finance ${tag}`)?.memberIds.includes(ann.userId),
      primaries: await primariesOf(ann.userId),
    }).toStrictEqual({
      landed: true,
      events: ["team.member.added finance"],
      list: idOf("Finance"),
      sales: false,
      finance: true,
      primaries: [{ team: idOf("Finance"), made: 1 }],
    });
  });

  it("never add back what an admin took away by hand from the team someone's primary already names", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const tag = unique();
    const listed = (ids: string[], annIn: number): RosterInput => ({
      teams: ["A", "B"].map((letter, index) => ({
        id: ids[index] ?? letter,
        name: `${letter} ${tag}`,
        lead: null,
      })),
      people: [
        { id: "ann", name: "Ann", email: emailOf(ann), team: ids[annIn] ?? "" },
      ],
    });
    const { roster: first } = await admin.api.onboarding.confirmRoster(
      listed(["A", "B"], 0)
    );
    const ids = ["A", "B"].map(
      (letter) =>
        first?.teams.find(({ name }) => name === `${letter} ${tag}`)?.id ?? ""
    );
    // This confirm read Ann's primary A and moves her to B. Just before
    // its writes, another confirm placed her in B and an admin took her
    // out of B by hand.
    const landing = landingAt(
      /insert into "team_primaries"/iu,
      "before",
      async () => {
        await admin.api.onboarding.confirmRoster(listed(ids, 1));
        await callAuth("/organization/remove-team-member", admin.session, {
          teamId: ids[1],
          userId: ann.userId,
        });
      }
    );
    await confirmOn(admin, landing.coreEnv, listed(ids, 1));
    const teams = await membersTeams(admin);

    expect({
      landed: landing.landed(),
      inB: teams.get(`B ${tag}`)?.memberIds.includes(ann.userId),
      inA: teams.get(`A ${tag}`)?.memberIds.includes(ann.userId),
    }).toStrictEqual({ landed: true, inB: false, inA: false });
  });

  it("keep a team an earlier release wrote, its interviews, map, works and held start, at the first confirm of the unchanged list", async () => {
    await aloneInTheStore();
    const admin = await signedInApi(idp, "admin");
    const store = onboardingStore(env);
    const ids = await teamOnTheList(["lea", "max", "mia"]);
    // Lea's map draws the team's works; Max tells his own work.
    await mapped(ids);
    await store.releaseDue(new Date(Date.now() + 10 * dayMs).toISOString());
    await agree(ids.max, [
      fact("f1", "system", "We log every ticket in Zendesk first."),
    ]);
    // Held to start later, as the admin set it.
    const { plan } = await store.view();
    const startsAt = new Date(Date.now() + 20 * dayMs).toISOString();
    if (plan === null) {
      throw new Error("No plan");
    }
    await store.savePlan(
      { ...plan, later: { [ids.team]: startsAt } },
      { type: "system" }
    );
    await asAnEarlierReleaseWrote();
    /** What the store holds of the team: whose interviews show, its map, its works. */
    const held = async () => {
      const sources = await store.interviewSources();
      const mappedRoster = await store.rosterAsMapped();
      return {
        sources: sources.map(({ team: of }) => of),
        does: mappedRoster?.teams[0]?.does,
        works: await worksOf(ids.team),
      };
    };
    const before = await held();

    const { roster } = await store.view();
    if (roster === null) {
      throw new Error("No staff list");
    }
    const { roster: kept, plan: after } =
      await admin.api.onboarding.confirmRoster(roster);

    expect({
      id: kept?.teams[0]?.id,
      ...(await held()),
      later: after?.later?.[ids.team],
    }).toStrictEqual({ id: ids.team, ...before, later: startsAt });
    expect(before.sources).toStrictEqual([ids.team]);
    expect(before.works).toBeGreaterThan(0);
  });

  it("never make a Settings team again under its id once it is deleted, though a store row an earlier release wrote still names it", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const tag = unique();
    const marker = markerWord();
    const by = { type: "person", userId: admin.userId } as const;
    const store = onboardingStore(env);
    const board = await settingsTeam(admin, `Board ${tag}`);
    await add(`Board minutes ${marker}`, { kind: "team", teamId: board });
    const listed = rosterSchema.parse({
      teams: [{ id: board, name: `Board ${tag}`, lead: null }],
      people: [{ id: "ann", name: "Ann", email: emailOf(ann), team: board }],
    });
    // On the list under the Settings team's own id, as an earlier release
    // could have written it: minted, by the column's default.
    await store.saveRoster(listed, { type: "system" });
    await asAnEarlierReleaseWrote();
    // A stale tab's confirm read the store then...
    const staleHeld = await store.heldTeams();
    // ...the admin takes Board off the list and deletes it in Settings...
    await admin.api.onboarding.saveRoster({
      teams: [{ id: "desk", name: `Desk ${tag}`, lead: null }],
      people: [{ id: "bo", name: "Bo", team: "desk" }],
    });
    const deleted = await callAuth("/organization/remove-team", admin.session, {
      teamId: board,
    });
    // ...and the stale confirm goes on, Board held and minted.
    const { roster: named, minted } = await intoMembersTeams(env, listed, by, {
      make: true,
      held: async () => await Promise.resolve(staleHeld),
    });
    await store.saveRoster(named, by, { confirmed: true, minted });
    await placePrimaries(env, by);
    const again = named.teams[0]?.id;
    const teams = await membersTeams(admin);
    const texts = await textsFor(ann.userId, marker);

    expect({
      wasMinted: staleHeld.find(({ id }) => id === board)?.minted,
      deleted: deleted.status,
      newId: again !== undefined && again !== board,
      annIn: teams.get(`Board ${tag}`)?.memberIds.includes(ann.userId),
      reads: texts.some((text) => text.includes(marker)),
    }).toStrictEqual({
      wasMinted: true,
      deleted: 200,
      newId: true,
      annIn: true,
      reads: false,
    });
  });
});
