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

/** A Settings › Members answer: its status and Better Auth's error code, if any. */
const answerOf = async (response: Response) => {
  const { code } = z
    .object({ code: z.string().optional() })
    .parse(await response.json());
  return { status: response.status, code };
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
      // Under the Settings team's id, and its name: the members' team
      // owns the name, the list follows it.
      support: list.get(`Support ${tag}`),
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
    // Renamed on the list once it is a members' team: its name changes in
    // Settings alone, and the list takes it from there.
    const { roster: renamedOnList } = await admin.api.onboarding.confirmRoster({
      teams: [{ id: support, name: `Help ${tag}`, lead: null }],
      people: [{ id: `bo-${tag}`, name: "Bo", team: support }],
    });
    const kept = await membersTeams(admin);
    expect({
      settings: [...kept].find(([, team]) => team.id === support)?.[0],
      list: renamedOnList?.teams[0]?.name,
    }).toStrictEqual({ settings: `Support ${tag}`, list: `Support ${tag}` });
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
      read: read.find(({ id }) => id === ops)?.name,
      refused: await answerOf(refused),
      removed: removed.status,
      again: again !== undefined && again !== old,
      drafted: drafted !== undefined && drafted !== old,
    }).toStrictEqual({
      listed: ops,
      read: `Operations ${tag}`,
      refused: { status: 409, code: "STAFF_LIST_TEAM_ON_LIST" },
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

  it("make no team a newer confirm's list leaves out, though an older confirm that had it reaches its writes after", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const withExtra: RosterInput = {
      teams: [
        { id: "sales", name: `Sales ${tag}`, lead: null },
        { id: "extra", name: `Extra ${tag}`, lead: null },
      ],
      people: [{ id: `bo-${tag}`, name: "Bo", team: "sales" }],
    };
    const { roster: drafted } =
      await admin.api.onboarding.saveRoster(withExtra);
    if (drafted === null) {
      throw new Error("The draft wasn't kept");
    }
    const sales = drafted.teams.find(({ name }) => name === `Sales ${tag}`);
    // Confirm A, with Extra, reaches its writes only after confirm B,
    // without it, made the teams.
    const landing = landingAt(
      /insert into "staff_list_synced"/iu,
      "before",
      async () => {
        await admin.api.onboarding.confirmRoster({
          teams: sales === undefined ? [] : [sales],
          people: [{ id: `bo-${tag}`, name: "Bo", team: sales?.id ?? "" }],
        });
      }
    );
    await confirmOn(admin, landing.coreEnv, drafted);
    const teams = await membersTeams(admin);

    expect({
      landed: landing.landed(),
      sales: teams.has(`Sales ${tag}`),
      extra: teams.has(`Extra ${tag}`),
    }).toStrictEqual({ landed: true, sales: true, extra: false });
  });

  it("keep a team's name as renamed in Settings though a page opened before the rename confirms the list with the old one", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const { roster: first } = await admin.api.onboarding.confirmRoster({
      teams: [{ id: "team", name: `Team ${tag}`, lead: null }],
      people: [{ id: `bo-${tag}`, name: "Bo", team: "team" }],
    });
    if (first === null) {
      throw new Error("No staff list");
    }
    const id = first.teams[0]?.id ?? "";
    // The page holds the list as it was; the team is renamed in Settings.
    await callAuth("/organization/update-team", admin.session, {
      teamId: id,
      data: { name: `Revenue ${tag}` },
    });
    const { roster: confirmed } =
      await admin.api.onboarding.confirmRoster(first);
    const teams = await membersTeams(admin);

    expect({
      settings: [...teams].find(([, team]) => team.id === id)?.[0],
      list: confirmed?.teams[0]?.name,
    }).toStrictEqual({ settings: `Revenue ${tag}`, list: `Revenue ${tag}` });
  });

  it("make a team only on the list under the name the list gave it last, renamed there before the confirm", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const listed = (id: string, name: string): RosterInput => ({
      teams: [{ id, name, lead: null }],
      people: [{ id: `bo-${tag}`, name: "Bo", team: id }],
    });
    const { roster: drafted } = await admin.api.onboarding.saveRoster(
      listed("team", `Salse ${tag}`)
    );
    const id = drafted?.teams[0]?.id ?? "";
    const { roster: confirmed } = await admin.api.onboarding.confirmRoster(
      listed(id, `Sales ${tag}`)
    );
    const teams = await membersTeams(admin);

    expect({
      sameId: confirmed?.teams[0]?.id === id,
      settings: [...teams].find(([, team]) => team.id === id)?.[0],
    }).toStrictEqual({ sameId: true, settings: `Sales ${tag}` });
  });

  it("refuse to make or rename a team in Settings under a name the list gives a team it hasn't made yet, in any case or Unicode form, and keep the list's team its one", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const ops = await settingsTeam(admin, `Ops ${tag}`);
    const listed: RosterInput = {
      teams: [{ id: "cafe", name: `Caf\u00E9 ${tag}`, lead: null }],
      people: [{ id: `bo-${tag}`, name: "Bo", team: "cafe" }],
    };
    const { roster: drafted } = await admin.api.onboarding.saveRoster(listed);
    const create = async (name: string) =>
      await answerOf(
        await callAuth("/organization/create-team", admin.session, { name })
      );
    const rename = async (name: string) =>
      await answerOf(
        await callAuth("/organization/update-team", admin.session, {
          teamId: ops,
          data: { name },
        })
      );
    const refused = {
      same: await create(`Caf\u00E9 ${tag}`),
      otherCase: await create(` CAFE\u0301 ${tag.toUpperCase()}`),
      renamed: await rename(`Caf\u00E9 ${tag}`),
    };
    // A free name, then only its own name in another case: both go through.
    const free = await rename(`Operations ${tag}`);
    const ownInCaps = await rename(`OPERATIONS ${tag}`);
    const passed = [free.status, ownInCaps.status];
    const { roster: confirmed } = await admin.api.onboarding.confirmRoster(
      drafted ?? listed
    );
    const teams = await admin.api.members.teams();
    const notMadeYet = {
      status: 409,
      code: "STAFF_LIST_TEAM_NOT_MADE_YET",
    };

    expect({
      refused,
      passed,
      named: teams.filter(({ name }) => name === `Caf\u00E9 ${tag}`).length,
      sameId: confirmed?.teams[0]?.id === drafted?.teams[0]?.id,
    }).toStrictEqual({
      refused: { same: notMadeYet, otherCase: notMadeYet, renamed: notMadeYet },
      passed: [200, 200],
      named: 1,
      sameId: true,
    });
  });

  it("keep two teams as renamed in Settings though the list's copy of the first rename was lost and the second came after: Settings answers both, and the next save takes them", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const { roster: first } = await admin.api.onboarding.confirmRoster({
      teams: [
        { id: "one", name: `One ${tag}`, lead: null },
        { id: "two", name: `Two ${tag}`, lead: null },
      ],
      people: [{ id: `bo-${tag}`, name: "Bo", team: "one" }],
    });
    const [one, two] = (first?.teams ?? []).map(({ id }) => id);
    const rename = async (teamId: string | undefined, name: string, on: Env) =>
      await routed(
        "/api/auth/organization/update-team",
        {
          method: "POST",
          headers: {
            origin: clientOrigin,
            cookie: admin.session,
            "content-type": "application/json",
          },
          body: JSON.stringify({ teamId, data: { name } }),
        },
        on
      );
    // The list's copy of the first rename is lost; the second goes through.
    const lostRename = await rename(one, `Uno ${tag}`, withOneRenameLost());
    const nextRename = await rename(two, `Dos ${tag}`, env);
    const answered = [lostRename.status, nextRename.status];
    const settingsNames = async () => {
      const teams = await membersTeams(admin);
      return [one, two].map(
        (id) => [...teams].find(([, team]) => team.id === id)?.[0]
      );
    };
    const before = await settingsNames();
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

    expect({
      answered,
      lostCopy: lost.teams.map(({ name }) => name),
      before,
      saved: saved.teams.map(({ name }) => name),
      after: await settingsNames(),
    }).toStrictEqual({
      answered: [200, 200],
      lostCopy: [`One ${tag}`, `Dos ${tag}`],
      before: [`Uno ${tag}`, `Dos ${tag}`],
      saved: [`Uno ${tag}`, `Dos ${tag}`],
      after: [`Uno ${tag}`, `Dos ${tag}`],
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

    expect({
      refused: await answerOf(refused),
      madeAgain: row !== null,
    }).toStrictEqual({
      refused: { status: 409, code: "STAFF_LIST_TEAM_ON_LIST" },
      madeAgain: false,
    });
  });
});
