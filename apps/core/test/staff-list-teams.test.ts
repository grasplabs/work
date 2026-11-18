import type { RosterInput } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import { adminCommands } from "./admin-command.ts";
import { mockIdp } from "./idp.ts";
import { agree, fact, team as teamOnTheList } from "./onboarding-team.ts";
import { clientOrigin } from "./sign-in-config.ts";
import {
  auditedDuring,
  callAuth,
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

/**
 * `env` with its D1 binding running `land` once, around the first
 * statement whose SQL `matches`: just before it runs, or just after. Every
 * statement still runs on the real database, in the order the code under
 * test sends it; only `land` comes in between, through its own requests.
 * `landed` says whether it came at all.
 */
const landingAt = (
  matches: RegExp,
  when: "before" | "after",
  land: () => Promise<unknown>
): { coreEnv: Env; landed: () => boolean } => {
  let landed = false;
  const once = async (): Promise<void> => {
    if (!landed) {
      landed = true;
      await land();
    }
  };
  const real = new WeakMap<object, D1PreparedStatement>();
  const runs = new Set<PropertyKey>(["run", "all", "raw", "first"]);
  const watched = (
    statement: D1PreparedStatement,
    query: string
  ): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get: (target, key) => {
        if (key === "bind") {
          return (...values: unknown[]) =>
            watched(target.bind(...values), query);
        }
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") {
          return value;
        }
        if (runs.has(key) && matches.test(query)) {
          return async (...args: unknown[]): Promise<unknown> => {
            if (when === "before") {
              await once();
            }
            const result: unknown = await Reflect.apply(value, target, args);
            if (when === "after") {
              await once();
            }
            return result;
          };
        }
        return (...args: unknown[]): unknown =>
          Reflect.apply(value, target, args);
      },
    });
    real.set(wrapped, statement);
    return wrapped;
  };
  const db = new Proxy(env.DB, {
    get: (target, key) => {
      if (key === "prepare") {
        return (query: string) => watched(target.prepare(query), query);
      }
      if (key === "batch") {
        return async (statements: D1PreparedStatement[]) =>
          await target.batch(
            statements.map((statement) => real.get(statement) ?? statement)
          );
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
  return { coreEnv: { ...env, DB: db }, landed: () => landed };
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
});
