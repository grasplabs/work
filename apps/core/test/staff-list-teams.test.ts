import { rosterSchema } from "@grasp-os/shared/onboarding";
import type { RosterInput } from "@grasp-os/shared/onboarding";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import { intoMembersTeams, syncTeams } from "../src/staff-list-teams.ts";
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
// staff list doesn't follow, or one the list writes back over; a team
// deleted while the list still names it; two confirms leaving a team's
// name in Settings other than the list's. A confirm changes no
// membership.

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
const emailOf = (person: Admin): string =>
  z.string().parse(person.person.email);

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

/** Puts `userId` in the members' team named `name` by hand, as an admin does in Settings: the teams after. */
const inTeamByHand = async (admin: Admin, name: string, userId: string) => {
  const before = await membersTeams(admin);
  await callAuth("/organization/add-team-member", admin.session, {
    teamId: before.get(name)?.id,
    userId,
  });
  return await membersTeams(admin);
};

/**
 * `env` whose onboarding store loses one `renameTeam` call (it throws),
 * as a call to it that never arrived.
 */
const withOneRenameLost = (): Env => {
  let lost = false;
  const store = (stub: object): object =>
    new Proxy(stub, {
      get: (target, key) => {
        if (key === "renameTeam" && !lost) {
          lost = true;
          return async () =>
            await Promise.reject(new Error("The store went away"));
        }
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
  const namespace = <T extends object>(inner: T): T =>
    new Proxy(inner, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]): unknown => {
          const result: unknown = Reflect.apply(value, target, args);
          if (
            key === "jurisdiction" &&
            typeof result === "object" &&
            result !== null
          ) {
            return namespace(result);
          }
          return key === "getByName" &&
            typeof result === "object" &&
            result !== null
            ? store(result)
            : result;
        };
      },
    });
  return { ...env, ONBOARDING: namespace(env.ONBOARDING) };
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
    const { roster: named, minted } = await intoMembersTeams(env, roster, {
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
    // Ann put in the team as it is now, by hand: nothing shared with the
    // old one reaches her.
    const teams = await inTeamByHand(admin, `Board ${tag}`, ann.userId);
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

  it("never make a team the list made once again under its id once it was deleted, though a stale confirm still holds it", async () => {
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
    // Settings refuses, the confirmed list naming it; code of an earlier
    // release deletes it all the same.
    const deleted = await callAuth("/organization/remove-team", admin.session, {
      teamId: board,
    });
    await env.DB.prepare("DELETE FROM teams WHERE id = ?").bind(board).run();
    // ...and the stale confirm goes on: Board held and minted, to it.
    const stale = rosterSchema.parse(listed(board, sales));
    const { roster: named, minted } = await intoMembersTeams(env, stale, {
      held: async () => await Promise.resolve(staleHeld),
    });
    await store.saveRoster(named, by, { confirmed: true, minted });
    await syncTeams(env, by);
    const again = named.teams.find(({ name }) => name === `Board ${tag}`)?.id;
    // Ann put in the team as it is now, by hand: nothing shared with the
    // old one reaches her.
    const teams = await inTeamByHand(admin, `Board ${tag}`, ann.userId);
    const texts = await textsFor(ann.userId, marker);

    expect({
      deleted: deleted.status,
      newId: again !== undefined && again !== board,
      annIn: teams.get(`Board ${tag}`)?.memberIds.includes(ann.userId),
      reads: texts.some((text) => text.includes(marker)),
    }).toStrictEqual({ deleted: 409, newId: true, annIn: true, reads: false });
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
    // was taken off the list and deleted.
    const landing = landingAt(/insert into "teams"/iu, "before", async () => {
      await admin.api.onboarding.confirmRoster(drafted);
      await add(`Board minutes ${marker}`, { kind: "team", teamId: board });
      await admin.api.onboarding.saveRoster({
        teams: [{ id: sales, name: `Sales ${tag}`, lead: null }],
        people: [{ id: "bo", name: "Bo", team: sales }],
      });
      // Deleted by code of an earlier release: Settings refuses while the
      // confirmed list names it.
      await env.DB.prepare("DELETE FROM teams WHERE id = ?").bind(board).run();
    });
    await confirmOn(admin, landing.coreEnv, drafted);
    const afterStale = await membersTeams(admin);
    // The stale tab confirms again, Board under its old id: it gets a new
    // one.
    const { roster: kept } = await admin.api.onboarding.confirmRoster(drafted);
    const again = kept?.teams.find(({ name }) => name === `Board ${tag}`)?.id;
    // Ann put in the team as it is now, by hand: nothing shared with the
    // old one reaches her.
    const teams = await inTeamByHand(admin, `Board ${tag}`, ann.userId);
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

  it("never make a Settings team again under its id once any release's code deleted it, though a store row an earlier release wrote still names it", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const tag = unique();
    const marker = markerWord();
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
    const held = await store.heldTeams();
    const wasMinted = held.find(({ id }) => id === board)?.minted;
    // Deleted as a release without this one's hooks deletes it (a
    // rollback), though the list still names it.
    await env.DB.prepare("DELETE FROM teams WHERE id = ?").bind(board).run();
    const { roster: confirmed } =
      await admin.api.onboarding.confirmRoster(listed);
    const again = confirmed?.teams[0]?.id;
    // Ann put in the team as it is now, by hand: nothing shared with the
    // old one reaches her.
    const teams = await inTeamByHand(admin, `Board ${tag}`, ann.userId);
    const texts = await textsFor(ann.userId, marker);

    expect({
      wasMinted,
      newId: again !== undefined && again !== board,
      annIn: teams.get(`Board ${tag}`)?.memberIds.includes(ann.userId),
      reads: texts.some((text) => text.includes(marker)),
    }).toStrictEqual({
      wasMinted: true,
      newId: true,
      annIn: true,
      reads: false,
    });
  });

  it("name a team in Settings as the staff list names it, though two confirms rename it in opposite orders", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const named = (id: string, name: string): RosterInput => ({
      teams: [{ id, name, lead: null }],
      people: [{ id: `bo-${tag}`, name: "Bo", team: id }],
    });
    const { roster: first } = await admin.api.onboarding.confirmRoster(
      named("team", `Team ${tag}`)
    );
    const id = first?.teams[0]?.id ?? "";
    /**
     * Confirm A renames it to Sales; just `when` its rename, confirm B
     * renames it to Revenue and finishes; then A goes on. Whether the
     * team's name and the list's agree after.
     */
    const agreeWhen = async (when: "before" | "after") => {
      const landing = landingAt(
        /^update "teams" set "name"/iu,
        when,
        async () => {
          await admin.api.onboarding.confirmRoster(
            named(id, `Revenue ${when} ${tag}`)
          );
        }
      );
      await confirmOn(
        admin,
        landing.coreEnv,
        named(id, `Sales ${when} ${tag}`)
      );
      const { roster } = await admin.api.onboarding.view();
      const row = await env.DB.prepare("SELECT name FROM teams WHERE id = ?")
        .bind(id)
        .first<{ name: string }>();
      return landing.landed() && row?.name === roster?.teams[0]?.name;
    };

    expect({
      after: await agreeWhen("after"),
      before: await agreeWhen("before"),
    }).toStrictEqual({ after: true, before: true });
  });

  it("name a team as a rename in Settings did, though a confirm's placing that read the list's older name was under way", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const named = (id: string, name: string): RosterInput => ({
      teams: [{ id, name, lead: null }],
      people: [{ id: `bo-${tag}`, name: "Bo", team: id }],
    });
    const { roster: first } = await admin.api.onboarding.confirmRoster(
      named("team", `Team ${tag}`)
    );
    const id = first?.teams[0]?.id ?? "";
    // A confirm renames it Sales; just before its placing writes that, an
    // admin renames it Revenue in Settings.
    const landing = landingAt(
      /^update "teams" set "name"/iu,
      "before",
      async () => {
        await callAuth("/organization/update-team", admin.session, {
          teamId: id,
          data: { name: `Revenue ${tag}` },
        });
      }
    );
    await confirmOn(admin, landing.coreEnv, named(id, `Sales ${tag}`));
    const { roster } = await admin.api.onboarding.view();
    const row = await env.DB.prepare("SELECT name FROM teams WHERE id = ?")
      .bind(id)
      .first<{ name: string }>();

    expect({
      landed: landing.landed(),
      settings: row?.name,
      list: roster?.teams[0]?.name,
    }).toStrictEqual({
      landed: true,
      settings: `Revenue ${tag}`,
      list: `Revenue ${tag}`,
    });
  });

  it("give the staff list a team's name as renamed in Settings though the list's copy of the rename was lost: Settings answers the rename, and the next save takes it", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const { roster: first } = await admin.api.onboarding.confirmRoster({
      teams: [{ id: "team", name: `Team ${tag}`, lead: null }],
      people: [{ id: `bo-${tag}`, name: "Bo", team: "team" }],
    });
    const id = first?.teams[0]?.id ?? "";
    const renamed = await routed(
      "/api/auth/organization/update-team",
      {
        method: "POST",
        headers: {
          origin: clientOrigin,
          cookie: admin.session,
          "content-type": "application/json",
        },
        body: JSON.stringify({ teamId: id, data: { name: `Revenue ${tag}` } }),
      },
      withOneRenameLost()
    );
    const { roster: lost } = await admin.api.onboarding.view();
    if (lost === null) {
      throw new Error("No staff list");
    }
    // The admin's page saves the list as it shows it, then confirms it.
    await admin.api.onboarding.saveRoster(lost);
    const { roster: saved } = await admin.api.onboarding.view();
    if (saved === null) {
      throw new Error("No staff list");
    }
    await admin.api.onboarding.confirmRoster(saved);
    const { roster: confirmed } = await admin.api.onboarding.view();
    const teams = await membersTeams(admin);

    expect({
      answered: renamed.status,
      lostCopy: lost.teams[0]?.name,
      saved: saved.teams[0]?.name,
      confirmed: confirmed?.teams[0]?.name,
      settings: [...teams].find(([, team]) => team.id === id)?.[0],
    }).toStrictEqual({
      answered: 200,
      lostCopy: `Team ${tag}`,
      saved: `Revenue ${tag}`,
      confirmed: `Revenue ${tag}`,
      settings: `Revenue ${tag}`,
    });
  });

  it("refuse to delete in Settings a team the confirmed list names, though a draft since leaves it out; and never make it again under its id once older code deleted it", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const marker = markerWord();
    const listed = (
      ids: readonly string[],
      withBoard: boolean
    ): RosterInput => ({
      teams: [
        { id: ids[0] ?? "sales", name: `Sales ${tag}`, lead: null },
        ...(withBoard
          ? [{ id: ids[1] ?? "board", name: `Board ${tag}`, lead: null }]
          : []),
      ],
      people: [{ id: `ann-${tag}`, name: "Ann", team: ids[0] ?? "sales" }],
    });
    const { roster: first } = await admin.api.onboarding.confirmRoster(
      listed(["sales", "board"], true)
    );
    const ids = ["Sales", "Board"].map(
      (name) =>
        first?.teams.find((team) => team.name === `${name} ${tag}`)?.id ?? ""
    );
    const board = ids[1] ?? "";
    await add(`Board minutes ${marker}`, { kind: "team", teamId: board });
    // A draft leaves Board out; the confirmed list still names it.
    await admin.api.onboarding.saveRoster(listed(ids, false));
    const refused = await callAuth("/organization/remove-team", admin.session, {
      teamId: board,
    });
    // Code of a release before this one deletes it all the same; then a
    // rename in Settings makes the confirmed list's teams again.
    await env.DB.prepare("DELETE FROM teams WHERE id = ?").bind(board).run();
    await callAuth("/organization/update-team", admin.session, {
      teamId: ids[0],
      data: { name: `Revenue ${tag}` },
    });
    const row = await env.DB.prepare("SELECT id FROM teams WHERE id = ?")
      .bind(board)
      .first();

    expect({ refused: refused.status, madeAgain: row !== null }).toStrictEqual({
      refused: 409,
      madeAgain: false,
    });
  });
});
