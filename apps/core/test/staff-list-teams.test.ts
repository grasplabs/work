import { rosterSchema } from "@grasp-os/shared/onboarding";
import type { RosterInput } from "@grasp-os/shared/onboarding";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import { intoMembersTeams, placePrimaries } from "../src/staff-list-teams.ts";
import { adminCommands, adminSnapshotText } from "./admin-command.ts";
import { add, markerWord, textsFor } from "./brain-next-leaks-harness.ts";
import { landingAt } from "./d1-landing.ts";
import { mockIdp } from "./idp.ts";
import { aloneInTheStore } from "./interview-link.ts";
import { runMinuteTasks } from "./maintenance.ts";
import {
  agree,
  fact,
  mapped,
  team as teamOnTheList,
} from "./onboarding-team.ts";
import { acmeTenant, clientOrigin, otherTenant } from "./sign-in-config.ts";
import {
  auditedDuring,
  callAuth,
  entraPerson,
  googlePerson,
  openRpc,
  outcome,
  routed,
  signIn,
  signedIn,
  signedInApi,
  unique,
  whoami,
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
const emailOf = (person: Admin): string =>
  z.string().parse(person.person.email);

/**
 * Someone's entry on a staff list as the directory read gives it: their
 * address, and for a Microsoft sign-in their account in the company's
 * directory, by which the list places them (GRA-2055).
 */
const onList = (person: Admin) => {
  const { oid } = z.object({ oid: z.string().optional() }).parse(person.person);
  return {
    email: emailOf(person),
    ...(oid === undefined ? {} : { entra: { tenant: acmeTenant, oid } }),
  };
};

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

/**
 * `count` members of the organization, written as a Google sign-in writes
 * them, their addresses proved now: their ids, `prefix` first, and
 * addresses.
 */
const manyMembers = async (count: number, prefix = "member-") => {
  const now = Date.now();
  const people = Array.from({ length: count }, () => {
    const id = `${prefix}${unique()}`;
    return { id, email: `${id}@acme.test` };
  });
  await env.DB.batch(
    people.flatMap(({ id, email }) => [
      env.DB.prepare(
        "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Member', ?, 1, ?, ?)"
      ).bind(id, email, now, now),
      env.DB.prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, 'user', ?)"
      ).bind(`membership-${id}`, id, now),
      env.DB.prepare(
        "INSERT INTO accounts (id, account_id, provider_id, user_id, verified_email, verified_email_at, verified_tenant, created_at, updated_at) VALUES (?, ?, 'google', ?, ?, ?, 'acme.test', ?, ?)"
      ).bind(`account-${id}`, `google-sub-${id}`, id, email, now, now, now),
    ])
  );
  return people;
};

/**
 * An erasure, then a newcomer with the erased person's address: Ann on
 * the list (confirmed or only drafted, `confirmedFirst`), signed in
 * through `provider` (through Microsoft, her entry carries her directory
 * account and the directory's own address for her), removed and erased;
 * the admin confirms the list again for another change; her address
 * released, someone new proves the entry's address through Google, and
 * the admin confirms again. Her entry as the store keeps it, and where the
 * newcomer is placed.
 */
const erasedThenNewcomer = async (
  confirmedFirst: boolean,
  provider: "google" | "microsoft" = "google"
) => {
  const admin = await signedInApi(idp, "admin");
  const ann = await signedInApi(idp, "user", provider);
  const cy = await signedInApi(idp, "user", "google");
  const tag = unique();
  const { email, entra } = onList(ann);
  const listedAs = entra === undefined ? email : `ann-${tag}@acme.test`;
  const firstList: RosterInput = {
    teams: [{ id: "finance", name: `Finance ${tag}`, lead: null }],
    people: [
      // Ids of their own: an erased entry's mark stays while it is listed.
      {
        id: `ann-${tag}`,
        name: "Ann",
        email: listedAs,
        entra,
        team: "finance",
      },
      { id: `bo-${tag}`, name: "Bo", team: "finance" },
    ],
  };
  await (confirmedFirst
    ? admin.api.onboarding.confirmRoster(firstList)
    : admin.api.onboarding.saveRoster(firstList));
  await admin.api.members.remove(ann.userId);
  await admin.api.members.erase(ann.userId, String(ann.person.name));
  /** The list as the admin's page has it now, confirmed with Cy in its team. */
  const confirmAsSaved = async () => {
    const { roster } = await admin.api.onboarding.view();
    if (roster === null) {
      throw new Error("No staff list");
    }
    const team = roster.teams[0]?.id ?? "";
    return await admin.api.onboarding.confirmRoster({
      ...roster,
      people: [
        ...roster.people.filter(({ id }) => id !== `cy-${tag}`),
        { id: `cy-${tag}`, name: "Cy", ...onList(cy), team },
      ],
    });
  };
  const { roster: kept } = await confirmAsSaved();
  const entry = kept?.people.find(({ name }) => name === "Ann");
  await admin.api.members.releaseAddress(email);
  const { userId: newcomer } = await whoami(
    await signedIn(idp, "google", googlePerson({ email: listedAs }))
  );
  await confirmAsSaved();
  const teams = await membersTeams(admin);
  return {
    entry:
      entry === undefined
        ? undefined
        : { email: entry.email, entra: entry.entra },
    newcomerIn: [...teams]
      .filter(([, { memberIds }]) => memberIds.includes(newcomer ?? ""))
      .map(([name]) => name),
    cyIn: teams.get(`Finance ${tag}`)?.memberIds.includes(cy.userId),
    expected: {
      entry: { email: listedAs, entra },
      newcomerIn: [],
      cyIn: true,
    },
  };
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

  it("place only a member whose sign-in proved the address the list names, whenever it did: never by an address no sign-in proved, or another tenant's", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    // Signs in with Microsoft: their address is Entra's `email` claim,
    // which proves nothing.
    const entra = await signedInApi(idp, "user");
    const google = await signedInApi(idp, "user", "google");
    // Google accounts whose proof is another tenant's, or two days old:
    // the reader lists' day is for reading, not for a lasting membership.
    const [elsewhere, stale] = await manyMembers(2);
    const twoDays = Date.now() - 2 * dayMs;
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE accounts SET verified_tenant = 'other.test' WHERE user_id = ?"
      ).bind(elsewhere?.id ?? ""),
      env.DB.prepare(
        "UPDATE accounts SET verified_email_at = ? WHERE user_id = ?"
      ).bind(twoDays, stale?.id ?? ""),
    ]);
    const listed = (finance: string): RosterInput => ({
      teams: [{ id: finance, name: `Finance ${tag}`, lead: null }],
      people: [
        // Only the address: no directory account on the entry.
        { id: "entra", name: "Eli", email: emailOf(entra), team: finance },
        { id: "google", name: "Gus", ...onList(google), team: finance },
        ...[elsewhere, stale].map((person, index) => ({
          id: `p${index}`,
          name: "Member",
          email: person?.email ?? "",
          team: finance,
        })),
      ],
    });
    await admin.api.onboarding.confirmRoster(listed("finance"));
    const teams = await membersTeams(admin);

    expect(teams.get(`Finance ${tag}`)?.memberIds).toStrictEqual(
      [google.userId, stale?.id ?? ""].toSorted()
    );
  });

  it("change nothing for a member when their sign-in proves nothing now: an unchanged list keeps them, and an admin's removal by hand stands after their next sign-in and a further confirm", async () => {
    const admin = await signedInApi(idp, "admin");
    const gus = await signedInApi(idp, "user", "google");
    const ann = await signedInApi(idp, "user", "google");
    const tag = unique();
    const listed = (finance: string, withBo: boolean): RosterInput => ({
      teams: [{ id: finance, name: `Finance ${tag}`, lead: null }],
      people: [
        { id: `gus-${tag}`, name: "Gus", ...onList(gus), team: finance },
        { id: `ann-${tag}`, name: "Ann", ...onList(ann), team: finance },
        ...(withBo ? [{ id: `bo-${tag}`, name: "Bo", team: finance }] : []),
      ],
    });
    const { roster: first } = await admin.api.onboarding.confirmRoster(
      listed("finance", false)
    );
    const finance = first?.teams[0]?.id ?? "";
    await callAuth("/organization/remove-team-member", admin.session, {
      teamId: finance,
      userId: ann.userId,
    });
    // Gus last signed in two days ago; nothing proves Ann's address now.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE accounts SET verified_email_at = ? WHERE user_id = ?"
      ).bind(Date.now() - 2 * dayMs, gus.userId),
      env.DB.prepare(
        "UPDATE accounts SET verified_email = NULL WHERE user_id = ?"
      ).bind(ann.userId),
    ]);
    const inFinance = async () => {
      const teams = await membersTeams(admin);
      return teams.get(`Finance ${tag}`)?.memberIds;
    };
    // The admin adds a colleague and confirms.
    const events = await auditedDuring(async () => {
      await admin.api.onboarding.confirmRoster(listed(finance, true));
    });
    const unproved = await inFinance();
    // Ann signs in again, and the admin confirms once more.
    await signedIn(idp, "google", ann.person);
    await admin.api.onboarding.confirmRoster(listed(finance, true));

    expect({
      events: events.filter(({ action }) => action.startsWith("team.member.")),
      unproved,
      provedAgain: await inFinance(),
      primaries: {
        gus: await primariesOf(gus.userId),
        ann: await primariesOf(ann.userId),
      },
    }).toStrictEqual({
      events: [],
      unproved: [gus.userId],
      provedAgain: [gus.userId],
      primaries: {
        gus: [{ team: finance, made: 1 }],
        ann: [{ team: finance, made: 1 }],
      },
    });
  });

  it("keep a member in their team once their address changes at Google and on the list, though the old address comes back later for someone in another team", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user", "google");
    const tag = unique();
    const oldAddress = emailOf(ann);
    const newAddress = `ann-new-${tag}@acme.test`;
    const listed = (
      ids: readonly string[],
      annAt: string,
      withBob: boolean
    ): RosterInput => ({
      teams: ["Finance", "Sales"].map((name, index) => ({
        id: ids[index] ?? `t${index}`,
        name: `${name} ${tag}`,
        lead: null,
      })),
      people: [
        { id: `ann-${tag}`, name: "Ann", email: annAt, team: ids[0] ?? "" },
        ...(withBob
          ? [
              {
                id: `bob-${tag}`,
                name: "Bob",
                email: oldAddress,
                team: ids[1] ?? "",
              },
            ]
          : []),
      ],
    });
    const { roster: first } = await admin.api.onboarding.confirmRoster(
      listed(["t0", "t1"], oldAddress, false)
    );
    const ids = ["Finance", "Sales"].map(
      (name) =>
        first?.teams.find((team) => team.name === `${name} ${tag}`)?.id ?? ""
    );
    // Her address changes at Google and on the list; her team stays.
    await env.DB.prepare(
      "UPDATE accounts SET verified_email = ? WHERE user_id = ?"
    )
      .bind(newAddress, ann.userId)
      .run();
    await admin.api.onboarding.confirmRoster(listed(ids, newAddress, false));
    // Later her old address is Bob's, at Google and on the list, in Sales.
    const [bob] = await manyMembers(1);
    await env.DB.prepare(
      "UPDATE accounts SET verified_email = ? WHERE user_id = ?"
    )
      .bind(oldAddress, bob?.id ?? "")
      .run();
    await admin.api.onboarding.confirmRoster(listed(ids, newAddress, true));
    const teams = await membersTeams(admin);

    expect({
      finance: teams.get(`Finance ${tag}`)?.memberIds,
      sales: teams.get(`Sales ${tag}`)?.memberIds,
    }).toStrictEqual({ finance: [ann.userId], sales: [bob?.id] });
  });

  it("take a member out of the team the list moved them from, though nothing proves them now, and add them to the new one only once their sign-in does", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user", "google");
    const tag = unique();
    const listed = (ids: readonly string[], annIn: number): RosterInput => ({
      teams: ["Sales", "Finance"].map((name, index) => ({
        id: ids[index] ?? `t${index}`,
        name: `${name} ${tag}`,
        lead: null,
      })),
      people: [
        {
          id: `ann-${tag}`,
          name: "Ann",
          ...onList(ann),
          team: ids[annIn] ?? "",
        },
      ],
    });
    const { roster: first } = await admin.api.onboarding.confirmRoster(
      listed(["t0", "t1"], 0)
    );
    const ids = ["Sales", "Finance"].map(
      (name) =>
        first?.teams.find((team) => team.name === `${name} ${tag}`)?.id ?? ""
    );
    const annIn = async () => {
      const teams = await membersTeams(admin);
      return [...teams]
        .filter(([, { memberIds }]) => memberIds.includes(ann.userId))
        .map(([name]) => name);
    };
    await env.DB.prepare(
      "UPDATE accounts SET verified_email = NULL WHERE user_id = ?"
    )
      .bind(ann.userId)
      .run();
    // The list moves her to Finance while nothing proves her address.
    await admin.api.onboarding.confirmRoster(listed(ids, 1));
    const moved = await annIn();
    // Unchanged list, and still unproved: nothing more.
    await admin.api.onboarding.confirmRoster(listed(ids, 1));
    const still = await annIn();
    // She signs in again; the next confirm adds her to Finance.
    await signedIn(idp, "google", ann.person);
    await admin.api.onboarding.confirmRoster(listed(ids, 1));

    expect({ moved, still, proved: await annIn() }).toStrictEqual({
      moved: [],
      still: [],
      proved: [`Finance ${tag}`],
    });
  });

  it("leave out a member the list gave a team while nothing proved them, once an admin removed them from it by hand, also after adding them by hand first", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    /**
     * Ann placed in Sales, then moved by the list to Finance while nothing
     * proves her (her Finance membership waits), with `byHand` done to her
     * Finance membership meanwhile; then she signs in and the admin
     * confirms the unchanged list. Whether she is in Finance after.
     */
    const inFinanceAfter = async (byHand: "add then remove" | "remove") => {
      const ann = await signedInApi(idp, "user", "google");
      const run = unique();
      const listed = (ids: readonly string[], annIn: number): RosterInput => ({
        teams: ["Sales", "Finance"].map((name, index) => ({
          id: ids[index] ?? `t${index}`,
          name: `${name} ${run} ${tag}`,
          lead: null,
        })),
        people: [
          {
            id: `ann-${run}`,
            name: "Ann",
            ...onList(ann),
            team: ids[annIn] ?? "",
          },
        ],
      });
      const { roster: first } = await admin.api.onboarding.confirmRoster(
        listed(["t0", "t1"], 0)
      );
      const ids = ["Sales", "Finance"].map(
        (name) =>
          first?.teams.find((team) => team.name === `${name} ${run} ${tag}`)
            ?.id ?? ""
      );
      const finance = ids[1] ?? "";
      const handAdd = async () =>
        await callAuth("/organization/add-team-member", admin.session, {
          teamId: finance,
          userId: ann.userId,
        });
      if (byHand === "remove") {
        // In Finance by hand already, before the list moves her there.
        await handAdd();
      }
      await env.DB.prepare(
        "UPDATE accounts SET verified_email = NULL WHERE user_id = ?"
      )
        .bind(ann.userId)
        .run();
      await admin.api.onboarding.confirmRoster(listed(ids, 1));
      if (byHand === "add then remove") {
        await handAdd();
      }
      await callAuth("/organization/remove-team-member", admin.session, {
        teamId: finance,
        userId: ann.userId,
      });
      await signedIn(idp, "google", ann.person);
      await admin.api.onboarding.confirmRoster(listed(ids, 1));
      const teams = await membersTeams(admin);
      return teams.get(`Finance ${run} ${tag}`)?.memberIds.includes(ann.userId);
    };

    expect({
      addThenRemove: await inFinanceAfter("add then remove"),
      remove: await inFinanceAfter("remove"),
    }).toStrictEqual({ addThenRemove: false, remove: false });
  });

  it("place a Microsoft member by the directory account their entry carries: never by an address alone, another tenant's account or a guest's, and still once their address changes at the directory", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const eli = await signedInApi(idp, "user");
    // Signs in with Microsoft too; their entry has only their address.
    const max = await signedInApi(idp, "user");
    // An account of another tenant under the object id Ola's entry names.
    const [elsewhere] = await manyMembers(1);
    const otherOid = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO accounts (id, account_id, provider_id, user_id, oid, verified_tenant, created_at, updated_at) VALUES (?, ?, 'microsoft', ?, ?, ?, ?, ?)"
    )
      .bind(
        `account-ms-${tag}`,
        `ms-${tag}`,
        elsewhere?.id ?? "",
        otherOid,
        otherTenant,
        now,
        now
      )
      .run();
    // A guest of the company's tenant, refused at sign-in.
    const guest = entraPerson(acmeTenant, "acme.test", { acct: 1 });
    const { session: guestSession } = await signIn(idp, "microsoft", guest);
    const { email: eliEmail, entra: eliAccount } = onList(eli);
    const listed = (finance: string, email: string): RosterInput => ({
      teams: [{ id: finance, name: `Finance ${tag}`, lead: null }],
      people: [
        { id: "eli", name: "Eli", email, entra: eliAccount, team: finance },
        { id: "max", name: "Max", email: emailOf(max), team: finance },
        {
          id: "ola",
          name: "Ola",
          // Not the address that account's own Google sign-in proved.
          email: `ola-${tag}@acme.test`,
          entra: { tenant: acmeTenant, oid: otherOid },
          team: finance,
        },
        {
          id: "gia",
          name: "Gia",
          email: String(guest.email),
          entra: { tenant: acmeTenant, oid: String(guest.oid) },
          team: finance,
        },
      ],
    });
    const { roster: first } = await admin.api.onboarding.confirmRoster(
      listed("finance", eliEmail)
    );
    const finance = first?.teams[0]?.id ?? "";
    const inFinance = async () => {
      const teams = await membersTeams(admin);
      return teams.get(`Finance ${tag}`)?.memberIds;
    };
    const placed = await inFinance();
    // At the directory, Eli's address changes; her account stays.
    const events = await auditedDuring(async () => {
      await admin.api.onboarding.confirmRoster(
        listed(finance, `renamed-${tag}@acme.test`)
      );
    });
    const renamed = await inFinance();

    expect({
      guestRefused: guestSession === undefined,
      placed,
      renamed,
      eliMoved: events.filter(
        ({ action, detail }) =>
          action.startsWith("team.member.") && detail?.userId === eli.userId
      ),
    }).toStrictEqual({
      guestRefused: true,
      placed: [eli.userId],
      renamed: [eli.userId],
      eliMoved: [],
    });
  });

  it("keep a Microsoft member's directory account on their entry when a save leaves it out, so the member stays placed", async () => {
    const admin = await signedInApi(idp, "admin");
    const eli = await signedInApi(idp, "user");
    const tag = unique();
    const { email, entra } = onList(eli);
    const listed = (finance: string, withAccount: boolean): RosterInput => ({
      teams: [{ id: finance, name: `Finance ${tag}`, lead: null }],
      people: [
        {
          id: `eli-${tag}`,
          name: "Eli",
          email,
          ...(withAccount ? { entra } : {}),
          team: finance,
        },
      ],
    });
    const { roster: first } = await admin.api.onboarding.confirmRoster(
      listed("finance", true)
    );
    const finance = first?.teams[0]?.id ?? "";
    // A page that left the account out (a file read, say) confirms again.
    const events = await auditedDuring(async () => {
      await admin.api.onboarding.confirmRoster(listed(finance, false));
    });
    const { roster } = await admin.api.onboarding.view();
    const teams = await membersTeams(admin);

    expect({
      kept: roster?.people.find(({ id }) => id === `eli-${tag}`)?.entra,
      inFinance: teams.get(`Finance ${tag}`)?.memberIds,
      events: events.filter(({ action }) => action.startsWith("team.member.")),
    }).toStrictEqual({ kept: entra, inFinance: [eli.userId], events: [] });
  });

  it("keep a Microsoft member's directory account out of Grasp's staff view of the staff list", async () => {
    const admin = await signedInApi(idp, "admin");
    const eli = await signedInApi(idp, "user");
    const tag = unique();
    const { entra } = onList(eli);
    await admin.api.onboarding.confirmRoster({
      teams: [{ id: "finance", name: `Finance ${tag}`, lead: null }],
      people: [
        { id: `eli-${tag}`, name: "Eli", ...onList(eli), team: "finance" },
      ],
    });
    const { roster } = await admin.api.onboarding.view();
    const staffView = await adminSnapshotText();

    expect({
      // The admin's page has it, beside the directory's people it came from.
      admin: roster?.people.find(({ id }) => id === `eli-${tag}`)?.entra,
      staff: staffView.includes(entra?.oid ?? "none"),
      staffHasEli: staffView.includes(`eli-${tag}`),
    }).toStrictEqual({ admin: entra, staff: false, staffHasEli: true });
  });

  it("place a member in their team once the admin confirms, by their sign-in's address only", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user", "google");
    const removed = await signedInApi(idp, "user", "google");
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
          ...onList(removed),
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
        .filter(
          ({ action, detail }) =>
            action.startsWith("team.member.") &&
            [ann.userId, removed.userId].includes(String(detail?.userId))
        )
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
        { id: "ann", name: "Ann", ...onList(ann), team },
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
        { id: "ann", name: "Ann", ...onList(ann), team: kept[team] },
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
      people: [{ id: "ann", name: "Ann", ...onList(ann), team: "sales" }],
    });
    const kept = await listTeams(admin);
    const sales = kept.get(`Sales ${tag}`) ?? "";
    const finance = kept.get(`Finance ${tag}`) ?? "";
    const listed = (team: string): RosterInput => ({
      teams: [
        { id: sales, name: `Sales ${tag}`, lead: null },
        { id: finance, name: `Finance ${tag}`, lead: null },
      ],
      people: [{ id: "ann", name: "Ann", ...onList(ann), team }],
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
      people: [{ id: "ann", name: "Ann", ...onList(ann), team: sales }],
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
        { id: "ann", name: "Ann", ...onList(ann), team: annIn },
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
      people: [{ id: "ann", name: "Ann", ...onList(ann), team: annIn }],
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
      people: [{ id: "ann", name: "Ann", ...onList(ann), team: annIn }],
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
        { id: "ann", name: "Ann", ...onList(ann), team: annIn },
        { id: "bea", name: "Bea", ...onList(bea), team: beaIn },
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
      people: [{ id: "ann", name: "Ann", ...onList(ann), team: board }],
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
        { id: "ann", name: "Ann", ...onList(ann), team: sales },
      ],
    });
    const teams = await membersTeams(admin);

    expect({
      landed: landing.landed(),
      inSales: teams.get(`Sales ${tag}`)?.memberIds.includes(ann.userId),
      primaries: await primariesOf(ann.userId),
    }).toStrictEqual({ landed: true, inSales: false, primaries: [] });
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
        { id: "ann", name: "Ann", ...onList(ann), team: board },
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
    await placePrimaries(env, by);
    const again = named.teams.find(({ name }) => name === `Board ${tag}`)?.id;
    const teams = await membersTeams(admin);
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
        { id: "ann", name: "Ann", ...onList(ann), team: "board" },
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
      people: [{ id: "ann", name: "Ann", ...onList(ann), team: "t0" }],
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
        { id: "ann", name: "Ann", ...onList(ann), team: ids[annIn] ?? "" },
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
        { id: "ann", name: "Ann", ...onList(ann), team: annIn },
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
        { id: "ann", name: "Ann", ...onList(ann), team: ids[annIn] ?? "" },
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
      people: [{ id: "ann", name: "Ann", ...onList(ann), team: board }],
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
    const teams = await membersTeams(admin);
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

  it("place a confirmed list whose placing stopped part way: the confirm hears the teams follow, and the clock finishes it, every team's count right", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    // Changes go by member id: the first batch is the fifty in Old alone.
    const inOld = await manyMembers(50, "0-");
    const inFinance = await manyMembers(11, "1-");
    const names = ["Sales", "Finance", "Old"].map((name) => `${name} ${tag}`);
    const listed = (ids: readonly string[], moved: boolean): RosterInput => ({
      teams: names.map((name, index) => ({
        id: ids[index] ?? `t${index}`,
        name,
        lead: null,
      })),
      people: [
        ...inOld.map(({ id, email }) => ({
          id,
          name: "Member",
          email,
          team: (moved ? ids[0] : ids[2]) ?? "",
        })),
        ...inFinance.map(({ id, email }) => ({
          id,
          name: "Member",
          email,
          team: (moved ? ids[0] : ids[1]) ?? "",
        })),
      ],
    });
    const { roster: first } = await admin.api.onboarding.confirmRoster(
      listed(["t0", "t1", "t2"], false)
    );
    const ids = names.map(
      (name) => first?.teams.find((team) => team.name === name)?.id ?? ""
    );
    // Everyone moves to Sales; the database fails right after the first
    // batch of the placing committed.
    const failing = landingAt(
      /insert into "team_members"/iu,
      "after",
      async () => await Promise.reject(new Error("The database went away"))
    );
    const answered = await outcome(
      confirmOn(admin, failing.coreEnv, listed(ids, true))
    );
    // Each team's members, and the count Better Auth keeps on it.
    const counted = async () => {
      const teams = await membersTeams(admin);
      const { results } = await env.DB.prepare(
        `SELECT name, member_count AS n FROM teams WHERE id IN (${ids.map(() => "?").join(", ")})`
      )
        .bind(...ids)
        .all<{ name: string; n: number }>();
      return names.map((name) => ({
        members: teams.get(name)?.memberIds.length,
        count: results.find((row) => row.name === name)?.n,
      }));
    };
    const stopped = await counted();

    await runMinuteTasks();

    expect({
      landed: failing.landed(),
      answered,
      stopped,
      finished: await counted(),
    }).toStrictEqual({
      landed: true,
      answered: "onboarding.teams_follow",
      // The first batch moved Old's fifty; Finance's eleven waited.
      stopped: [
        { members: 50, count: 50 },
        { members: 11, count: 11 },
        { members: 0, count: 0 },
      ],
      finished: [
        { members: 61, count: 61 },
        { members: 0, count: 0 },
        { members: 0, count: 0 },
      ],
    });
  });

  it("place nobody by an address forgotten while a placing of the list that had it was under way, though someone else proves it before that placing reads", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user", "google");
    const bo = await signedInApi(idp, "user", "google");
    const tag = unique();
    const email = emailOf(ann);
    const listed = (finance: string): RosterInput => ({
      teams: [{ id: finance, name: `Finance ${tag}`, lead: null }],
      people: [
        { id: "ann", name: "Ann", email, team: finance },
        { id: "bo", name: "Bo", ...onList(bo), team: finance },
      ],
    });
    const { roster: first } = await admin.api.onboarding.confirmRoster(
      listed("finance")
    );
    const finance = first?.teams[0]?.id ?? "";
    await admin.api.members.remove(ann.userId);
    // The admin confirms the list again, Ann's entry kept (the company's).
    // Its placing has claimed it and read the store; just before it reads
    // who proved an address on it, Ann is erased, her address released, and someone
    // new signs in with it.
    let again = "";
    const landing = landingAt(
      /^select .* from "accounts"/iu,
      "before",
      async () => {
        await admin.api.members.erase(ann.userId, String(ann.person.name));
        await admin.api.members.releaseAddress(email);
        const { userId } = await whoami(
          await signedIn(idp, "google", googlePerson({ email }))
        );
        again = userId ?? "";
      }
    );
    let answered = "";
    const audited = await auditedDuring(async () => {
      answered = await outcome(
        confirmOn(admin, landing.coreEnv, listed(finance))
      );
    });
    // Right after the confirm, before any clock's run puts it right.
    const teams = await membersTeams(admin);
    const inFinance = teams.get(`Finance ${tag}`)?.memberIds;

    expect({
      landed: landing.landed(),
      answered,
      again: inFinance?.includes(again),
      // Not even for a moment: no event of theirs.
      events: audited.filter(
        ({ action, detail }) =>
          action.startsWith("team.member.") && detail?.userId === again
      ),
      bo: inFinance?.includes(bo.userId),
    }).toStrictEqual({
      landed: true,
      answered: "ok",
      again: false,
      events: [],
      bo: true,
    });
  });

  it("tell a confirm its list is placed only once it is, though another confirm's placing holds a newer list when it looks", async () => {
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
        { id: "ann", name: "Ann", ...onList(ann), team: annIn },
      ],
    });
    // Confirm B saves Sales and waits just before it claims it...
    const { promise: atClaim, resolve: reached } = Promise.withResolvers();
    const { promise: gate, resolve: open } = Promise.withResolvers();
    const waiting = landingAt(
      /insert into "staff_list_placed"/iu,
      "before",
      async () => {
        reached(null);
        await gate;
      }
    );
    const second = outcome(
      confirmOn(admin, waiting.coreEnv, listed(idOf("Sales")))
    );
    await atClaim;
    // ...confirm A saves Finance, claims it, and fails before its writes:
    // B looks while A's placing still holds Finance.
    const failing = landingAt(
      /insert into "team_members"/iu,
      "before",
      async () => {
        open(null);
        await second;
        throw new Error("The database went away");
      }
    );
    const firstAnswer = await outcome(
      confirmOn(admin, failing.coreEnv, listed(idOf("Finance")))
    );
    const annInFinance = async () => {
      const teams = await membersTeams(admin);
      return teams.get(`Finance ${tag}`)?.memberIds.includes(ann.userId);
    };
    const before = await annInFinance();

    await runMinuteTasks();

    expect({
      landed: waiting.landed() && failing.landed(),
      first: firstAnswer,
      second: await second,
      before,
      after: await annInFinance(),
    }).toStrictEqual({
      landed: true,
      first: "onboarding.teams_follow",
      second: "onboarding.teams_follow",
      before: false,
      after: true,
    });
  });

  it("place nobody by the address of someone erased or removed, though the list the admin confirmed names it", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user", "google");
    const bea = await signedInApi(idp, "user");
    const cy = await signedInApi(idp, "user");
    const tag = unique();
    const store = onboardingStore(env);
    const listed = (finance: string, withCy: boolean): RosterInput => ({
      teams: [{ id: finance, name: `Finance ${tag}`, lead: null }],
      people: [
        { id: "ann", name: "Ann", ...onList(ann), team: finance },
        { id: "bea", name: "Bea", ...onList(bea), team: finance },
        ...(withCy
          ? [{ id: "cy", name: "Cy", ...onList(cy), team: finance }]
          : []),
      ],
    });
    const { roster: first } = await admin.api.onboarding.confirmRoster(
      listed("finance", false)
    );
    const finance = first?.teams[0]?.id ?? "";
    /** Whose address or directory account the confirmed places hold. */
    const theirs = async () => {
      const confirmed = await store.confirmedPlaces();
      const places = confirmed?.places ?? [];
      return [ann, bea].flatMap((person) => {
        const { email, entra } = onList(person);
        return places.some(
          (place) =>
            place.email === email.toLowerCase() ||
            (entra !== undefined && place.entra?.oid === entra.oid)
        )
          ? [person.person.name]
          : [];
      });
    };
    await admin.api.members.remove(ann.userId);
    await admin.api.members.remove(bea.userId);
    const removed = await theirs();
    // The admin confirms the list again, its entries for them kept (the
    // company's), Cy new on it; its placing fails before it writes.
    const failing = landingAt(
      /insert into "team_members"/iu,
      "before",
      async () => await Promise.reject(new Error("The database went away"))
    );
    const answered = await outcome(
      confirmOn(admin, failing.coreEnv, listed(finance, true))
    );
    await admin.api.members.erase(ann.userId, String(ann.person.name));
    const erased = await theirs();
    // Ann's address released, someone signs in with it before the clock
    // places the list.
    await admin.api.members.releaseAddress(emailOf(ann));
    const { userId: again } = await whoami(
      await signedIn(idp, "google", googlePerson({ email: emailOf(ann) }))
    );

    await runMinuteTasks();
    const teams = await membersTeams(admin);
    const inFinance = teams.get(`Finance ${tag}`)?.memberIds;

    expect({
      removed,
      answered,
      erased,
      again: inFinance?.includes(again ?? ""),
      cy: inFinance?.includes(cy.userId),
    }).toStrictEqual({
      removed: [],
      answered: "onboarding.teams_follow",
      // Bea's entry is on the list again, with her address and account:
      // removed, she is placed nowhere.
      erased: [bea.person.name],
      again: false,
      cy: true,
    });
  });

  it("place nobody by an erased person's entry, erased after a confirm: a newcomer proving its address is in no team, the entry kept as it was", async () => {
    const { expected, ...found } = await erasedThenNewcomer(true);
    expect(found).toStrictEqual(expected);
  });

  it("place nobody by an erased person's entry, erased before any confirm: a newcomer proving its address is in no team, the entry kept as it was", async () => {
    const { expected, ...found } = await erasedThenNewcomer(false);
    expect(found).toStrictEqual(expected);
  });

  it("place nobody by an erased Microsoft member's entry, erased after a confirm or before any, though it is found by their account alone", async () => {
    for (const confirmedFirst of [true, false]) {
      // oxlint-disable-next-line no-await-in-loop -- one order at a time
      const { expected, ...found } = await erasedThenNewcomer(
        confirmedFirst,
        "microsoft"
      );
      expect(found).toStrictEqual(expected);
    }
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

  it("refuse to delete in Settings a team the confirmed list names, though a draft since leaves it out; and never make it again under its id once older code deleted it", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user", "google");
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
      people: [
        {
          id: `ann-${tag}`,
          name: "Ann",
          ...onList(ann),
          team: ids[0] ?? "sales",
        },
      ],
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
    // member's removal changes the confirmed list, and the clock places it.
    await env.DB.prepare("DELETE FROM teams WHERE id = ?").bind(board).run();
    await admin.api.members.remove(ann.userId);
    await runMinuteTasks();
    const row = await env.DB.prepare("SELECT id FROM teams WHERE id = ?")
      .bind(board)
      .first();

    expect({ refused: refused.status, madeAgain: row !== null }).toStrictEqual({
      refused: 409,
      madeAgain: false,
    });
  });

  it("finish placing a list though a team someone waits for is deleted as the confirm saves", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user", "google");
    const tag = unique();
    const store = onboardingStore(env);
    const listed = (ids: readonly string[], annIn: number): RosterInput => ({
      teams: ["Sales", "Finance"].map((name, index) => ({
        id: ids[index] ?? `t${index}`,
        name: `${name} ${tag}`,
        lead: null,
      })),
      people: [
        {
          id: `ann-${tag}`,
          name: "Ann",
          ...onList(ann),
          team: ids[annIn] ?? "",
        },
      ],
    });
    const { roster: first } = await admin.api.onboarding.confirmRoster(
      listed(["t0", "t1"], 0)
    );
    const ids = ["Sales", "Finance"].map(
      (name) =>
        first?.teams.find((team) => team.name === `${name} ${tag}`)?.id ?? ""
    );
    await env.DB.prepare(
      "UPDATE accounts SET verified_email = NULL WHERE user_id = ?"
    )
      .bind(ann.userId)
      .run();
    // The list moves Ann, unproved, to Finance; just before the placing
    // writes her waiting row, code of an older release deletes Finance.
    const landing = landingAt(
      /insert into "team_primaries"/iu,
      "before",
      async () => {
        await env.DB.prepare("DELETE FROM teams WHERE id = ?")
          .bind(ids[1] ?? "")
          .run();
      }
    );
    const answered = await outcome(
      confirmOn(admin, landing.coreEnv, listed(ids, 1))
    );
    const placed = await env.DB.prepare(
      "SELECT placed FROM staff_list_placed"
    ).first<{ placed: number }>();

    expect({
      landed: landing.landed(),
      answered,
      placed: placed?.placed === (await store.confirmedVersion()),
    }).toStrictEqual({ landed: true, answered: "ok", placed: true });
  });

  it("leave a confirm's placing its list while its lease is live: the clock takes nothing, and the confirm finishes and answers done", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const tag = unique();
    // The clock's minute lands just before the confirm's first batch.
    const landing = landingAt(
      /insert into "team_members"/iu,
      "before",
      async () => {
        await runMinuteTasks();
      }
    );
    let answered = "";
    const audited = await auditedDuring(async () => {
      answered = await outcome(
        confirmOn(admin, landing.coreEnv, {
          teams: [{ id: "finance", name: `Finance ${tag}`, lead: null }],
          people: [{ id: "ann", name: "Ann", ...onList(ann), team: "finance" }],
        })
      );
    });
    const added = audited.filter(
      ({ action, detail }) =>
        action === "team.member.added" && detail?.userId === ann.userId
    );

    expect({
      landed: landing.landed(),
      answered,
      // Placed once, by the confirm, not by the clock.
      by: added.map(({ actor }) => actor),
    }).toStrictEqual({
      landed: true,
      answered: "ok",
      by: [{ type: "person", userId: admin.userId }],
    });
  });

  it("never mark an older list placed after a newer one claimed: the placed version never goes back", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const tag = unique();
    const store = onboardingStore(env);
    const listed = (team: string): RosterInput => ({
      teams: [
        { id: "sales", name: `Sales ${tag}`, lead: null },
        { id: "finance", name: `Finance ${tag}`, lead: null },
      ],
      people: [{ id: "ann", name: "Ann", ...onList(ann), team }],
    });
    // Every mark as it is written, in order.
    const log = `placed_log_${tag.replaceAll("-", "_")}`;
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE ${log} (placed integer NOT NULL)`),
      env.DB.prepare(
        `CREATE TRIGGER ${log}_marks AFTER UPDATE OF placed ON staff_list_placed
         BEGIN INSERT INTO ${log} VALUES (NEW.placed); END`
      ),
    ]);
    onTestFinished(async () => {
      await env.DB.batch([
        env.DB.prepare(`DROP TRIGGER ${log}_marks`),
        env.DB.prepare(`DROP TABLE ${log}`),
      ]);
    });
    let newer = 0;
    // Just before the older list's one batch, which would mark it placed,
    // a newer confirm claims, places and marks its own.
    const landing = landingAt(
      /insert into "team_members"/iu,
      "before",
      async () => {
        await admin.api.onboarding.confirmRoster(listed("finance"));
        newer = await store.confirmedVersion();
      }
    );
    const answered = await outcome(
      confirmOn(admin, landing.coreEnv, listed("sales"))
    );
    const row = await env.DB.prepare(
      "SELECT version, placed, lease_id AS lease FROM staff_list_placed"
    ).first<{ version: number; placed: number; lease: string | null }>();

    const { results: marks } = await env.DB.prepare(
      `SELECT placed FROM ${log} ORDER BY rowid`
    ).all<{ placed: number }>();

    expect({
      landed: landing.landed(),
      answered,
      row,
      marks: marks.map(({ placed }) => placed),
    }).toStrictEqual({
      landed: true,
      answered: "ok",
      row: { version: newer, placed: newer, lease: null },
      marks: [newer],
    });
  });
});
