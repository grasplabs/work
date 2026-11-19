import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { landingAt } from "./d1-landing.ts";
import {
  connectedDirectory,
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
  signedIn,
  whoami,
  withSignIn,
} from "./sign-in.ts";

// Each member tied to a directory person in the team their department
// fills (GRA-2056, slice 2): the first part of the directory's read that
// changes who is in a team, and so who reads what. Only Microsoft Graph is
// faked. The ways it could go wrong come first: an admin's hand change
// undone, a membership made by hand taken away, a change landing mid-read
// lost or doubled, a department taken for the wrong team.

const idp = mockIdp();
const dayMs = 24 * 60 * 60 * 1000;

let days = 0;
/** A time past every read so far by more than a day: a read is due then. */
const nextDay = (): Date => {
  days += 2;
  return new Date(Date.now() + days * dayMs);
};

/** The clock's daily read, run for the slot at `at`. */
const readAt = async (at: Date, changes: Partial<Env> = {}): Promise<void> => {
  await runClockTask("directory.people", changes, at);
};

/** Someone who signed in with Microsoft under `oid`, as a member. */
const memberWith = async (oid: string) => {
  const person = entraPerson(acmeTenant, "acme.test", { oid });
  const session = await signedIn(idp, "microsoft", person, {
    coreEnv: withSignIn({
      admins: [String(person.email)],
      entra: { tenantId: acmeTenant, clientId: entraClient.id },
    }),
  });
  const { userId } = await whoami(session);
  return { oid, userId, name: String(person.name) };
};

const idSchema = z.object({ id: z.string() });

/** A members' team an admin made in Settings › Members, by `name`. */
const teamNamed = async (session: string, name: string): Promise<string> => {
  const made = await callAuth("/organization/create-team", session, { name });
  return idSchema.parse(await made.json()).id;
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

interface Membership {
  teamId: string;
  key: string | null;
  made: number;
}

/** The teams `userId` is in, and whether the directory's read made each. */
const membershipsOf = async (userId: string): Promise<Membership[]> => {
  const { results } = await env.DB.prepare(
    `SELECT tm.team_id AS teamId, tm.membership_key AS key,
        EXISTS (SELECT 1 FROM directory_memberships m WHERE m.membership_key = tm.membership_key) AS made
      FROM team_members tm WHERE tm.user_id = ? ORDER BY tm.team_id`
  )
    .bind(userId)
    .all<Membership>();
  return results;
};

/** The teams `userId` is in. */
const teamsOf = async (userId: string): Promise<string[]> => {
  const memberships = await membershipsOf(userId);
  return memberships.map(({ teamId }) => teamId);
};

/** `ids` in the order `teamsOf` answers. */
const sorted = (...ids: string[]): string[] => ids.toSorted();

/** Each team's member count as kept, and as counted. */
const countsOf = async (...teamIds: string[]) => {
  const { results } = await env.DB.prepare(
    `SELECT id, member_count AS kept,
        (SELECT count(*) FROM team_members WHERE team_id = teams.id) AS counted
      FROM teams WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`
  )
    .bind(JSON.stringify(teamIds))
    .all<{ id: string; kept: number; counted: number }>();
  return results;
};

/** D1 refusing every batch, as it would one past its limits. */
const refusingBatches = new Proxy(env.DB, {
  get: (target, key) => {
    if (key === "batch") {
      return async (): Promise<never> =>
        await Promise.reject(new Error("D1_ERROR: refused"));
    }
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function"
      ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
      : value;
  },
});

/** The read's batch, as its first statement shows it. */
const readsBatch = /insert into "directory_reads"/u;

describe("the directory's teams", () => {
  it("puts a tied member in the team their department names, linked by name once and by id after the team's rename, recorded as the system's", async () => {
    const { admin } = await connectedDirectory(idp);
    const finance = await teamNamed(admin.session, "Finance");
    const [ann, ben] = [
      await memberWith(crypto.randomUUID()),
      await memberWith(crypto.randomUUID()),
    ];
    await directoryHolds([user({ id: ann.oid, department: "Finance" })]);

    const events = await auditedDuring(async () => {
      await readAt(nextDay());
    });
    const renamed = await callAuth("/organization/update-team", admin.session, {
      teamId: finance,
      data: { name: "Finance and control" },
    });
    await renamed.body?.cancel();
    await directoryHolds([
      user({ id: ann.oid, department: "Finance" }),
      user({ id: ben.oid, department: "Finance" }),
    ]);
    await readAt(nextDay());

    expect({
      ann: await teamsOf(ann.userId),
      ben: await teamsOf(ben.userId),
      recorded: events
        .filter(({ action }) =>
          ["team.member.added", "directory.department_linked"].includes(action)
        )
        .map(({ actor, action, target, detail }) => ({
          actor,
          action,
          target,
          detail,
        })),
    }).toStrictEqual({
      ann: [finance],
      ben: [finance],
      recorded: [
        {
          actor: { type: "system" },
          action: "directory.department_linked",
          target: { type: "team", id: finance },
          detail: { provider: "microsoft-directory" },
        },
        {
          actor: { type: "system" },
          action: "team.member.added",
          target: { type: "team", id: finance },
          detail: { userId: ann.userId, via: "directory" },
        },
      ],
    });
  });

  it("moves a mover out of the team the read put them in and into their new department's, keeping the team an admin added them to", async () => {
    const { admin } = await connectedDirectory(idp);
    const [finance, sales, projects] = [
      await teamNamed(admin.session, `Finance ${crypto.randomUUID()}`),
      await teamNamed(admin.session, `Sales ${crypto.randomUUID()}`),
      await teamNamed(admin.session, `Projects ${crypto.randomUUID()}`),
    ];
    const names = await env.DB.prepare(
      "SELECT id, name FROM teams WHERE id IN (?, ?)"
    )
      .bind(finance, sales)
      .all<{ id: string; name: string }>();
    const nameOf = (id: string) =>
      names.results.find((team) => team.id === id)?.name ?? "";
    const cas = await memberWith(crypto.randomUUID());
    await directoryHolds([user({ id: cas.oid, department: nameOf(finance) })]);
    await readAt(nextDay());
    await byHand(admin.session, "add", projects, cas.userId);
    await directoryHolds([user({ id: cas.oid, department: nameOf(sales) })]);

    const events = await auditedDuring(async () => {
      await readAt(nextDay());
    });
    const moved = await teamsOf(cas.userId);
    // Released, the team an admin added stays: the read never made it.
    await admin.api.members.releaseTeamPin(cas.userId, projects);
    await readAt(nextDay());
    const released = await teamsOf(cas.userId);
    // A department cleared takes nobody out of the team the read put them in.
    await directoryHolds([user({ id: cas.oid, department: null })]);
    await readAt(nextDay());

    expect({
      moved,
      released,
      cleared: await teamsOf(cas.userId),
      removed: events
        .filter(({ action }) => action === "team.member.removed")
        .map(({ actor, target, detail }) => ({ actor, target, detail })),
    }).toStrictEqual({
      moved: sorted(sales, projects),
      released: sorted(sales, projects),
      cleared: sorted(sales, projects),
      removed: [
        {
          actor: { type: "system" },
          target: { type: "team", id: finance },
          detail: { userId: cas.userId, via: "directory" },
        },
      ],
    });
  });

  it("never adds back a membership an admin removed by hand until an admin lets the directory decide, and records both as the admin's", async () => {
    const { admin } = await connectedDirectory(idp);
    const legal = await teamNamed(
      admin.session,
      `Legal ${crypto.randomUUID()}`
    );
    const name = await env.DB.prepare("SELECT name FROM teams WHERE id = ?")
      .bind(legal)
      .first<string>("name");
    const dirk = await memberWith(crypto.randomUUID());
    await directoryHolds([user({ id: dirk.oid, department: name ?? "" })]);
    await readAt(nextDay());

    const pinned = await auditedDuring(async () => {
      await byHand(admin.session, "remove", legal, dirk.userId);
    });
    await readAt(nextDay());
    const keptOut = await teamsOf(dirk.userId);
    const released = await auditedDuring(async () => {
      await admin.api.members.releaseTeamPin(dirk.userId, legal);
    });
    await readAt(nextDay());

    const actor = { type: "person", userId: admin.userId };
    expect({
      keptOut,
      after: await teamsOf(dirk.userId),
      recorded: [...pinned, ...released]
        .filter(({ action }) => action.startsWith("team.member."))
        .map(({ actor: by, action, target, detail }) => ({
          by,
          action,
          target,
          detail,
        })),
    }).toStrictEqual({
      keptOut: [],
      after: [legal],
      recorded: [
        {
          by: actor,
          action: "team.member.removed",
          target: { type: "team", id: legal },
          detail: { userId: dirk.userId, pinned: "out" },
        },
        {
          by: actor,
          action: "team.member.pin_released",
          target: { type: "team", id: legal },
          detail: { userId: dirk.userId },
        },
      ],
    });
  });

  it("writes the membership key Better Auth writes for the same pair, so Better Auth finds the read's membership as its own", async () => {
    const { admin } = await connectedDirectory(idp);
    const ops = await teamNamed(admin.session, `Ops ${crypto.randomUUID()}`);
    const name = await env.DB.prepare("SELECT name FROM teams WHERE id = ?")
      .bind(ops)
      .first<string>("name");
    const eva = await memberWith(crypto.randomUUID());
    await byHand(admin.session, "add", ops, eva.userId);
    const [byBetterAuth] = await membershipsOf(eva.userId);
    await byHand(admin.session, "remove", ops, eva.userId);
    await admin.api.members.releaseTeamPin(eva.userId, ops);
    await directoryHolds([user({ id: eva.oid, department: name ?? "" })]);
    await readAt(nextDay());
    const [byRead] = await membershipsOf(eva.userId);

    // Better Auth's own add finds it, and makes no second.
    const addedAgain = await byHand(admin.session, "add", ops, eva.userId);

    expect({
      byRead,
      addedAgain,
      after: await membershipsOf(eva.userId),
    }).toStrictEqual({
      byRead: { teamId: ops, key: byBetterAuth?.key, made: 1 },
      addedAgain: 200,
      after: [{ teamId: ops, key: byBetterAuth?.key, made: 1 }],
    });
  });

  it("leaves a hand removal or a hand add that lands just before the read's batch as the admin made it", async () => {
    const { admin } = await connectedDirectory(idp);
    const [finance, sales] = [
      await teamNamed(admin.session, `Finance ${crypto.randomUUID()}`),
      await teamNamed(admin.session, `Sales ${crypto.randomUUID()}`),
    ];
    const names = await env.DB.prepare(
      "SELECT id, name FROM teams WHERE id IN (?, ?)"
    )
      .bind(finance, sales)
      .all<{ id: string; name: string }>();
    const nameOf = (id: string) =>
      names.results.find((team) => team.id === id)?.name ?? "";
    const [fay, gus] = [
      await memberWith(crypto.randomUUID()),
      await memberWith(crypto.randomUUID()),
    ];
    await directoryHolds([
      user({ id: fay.oid, department: nameOf(finance) }),
      user({ id: gus.oid, department: nameOf(finance) }),
    ]);
    await readAt(nextDay());
    // Gus moves to Sales: the read would take him out of Finance.
    await directoryHolds([
      user({ id: fay.oid, department: nameOf(finance) }),
      user({ id: gus.oid, department: nameOf(sales) }),
    ]);
    const { coreEnv, landed } = landingAt(readsBatch, "before", async () => {
      await byHand(admin.session, "remove", finance, fay.userId);
      await byHand(admin.session, "add", finance, gus.userId);
    });

    await readAt(nextDay(), { DB: coreEnv.DB });

    expect({
      landed: landed(),
      fay: await teamsOf(fay.userId),
      gus: await teamsOf(gus.userId),
    }).toStrictEqual({ landed: true, fay: [], gus: sorted(finance, sales) });
  });

  it("places nobody in a team deleted, nor a member removed, just before the read's batch, and places the rest", async () => {
    const { admin } = await connectedDirectory(idp);
    const [kept, deleted] = [
      await teamNamed(admin.session, `Kept ${crypto.randomUUID()}`),
      await teamNamed(admin.session, `Deleted ${crypto.randomUUID()}`),
    ];
    const names = await env.DB.prepare(
      "SELECT id, name FROM teams WHERE id IN (?, ?)"
    )
      .bind(kept, deleted)
      .all<{ id: string; name: string }>();
    const nameOf = (id: string) =>
      names.results.find((team) => team.id === id)?.name ?? "";
    const [hal, ida, jan] = [
      await memberWith(crypto.randomUUID()),
      await memberWith(crypto.randomUUID()),
      await memberWith(crypto.randomUUID()),
    ];
    await directoryHolds([
      user({ id: hal.oid, department: nameOf(kept) }),
      user({ id: ida.oid, department: nameOf(deleted) }),
      user({ id: jan.oid, department: nameOf(kept) }),
    ]);
    const { coreEnv, landed } = landingAt(readsBatch, "before", async () => {
      const removed = await callAuth(
        "/organization/remove-team",
        admin.session,
        {
          teamId: deleted,
        }
      );
      await removed.body?.cancel();
      await admin.api.members.remove(jan.userId);
    });

    await readAt(nextDay(), { DB: coreEnv.DB });
    const status = await env.DB.prepare(
      "SELECT failure FROM directory_reads WHERE provider = 'microsoft-directory'"
    ).first<string | null>("failure");

    expect({
      landed: landed(),
      failure: status,
      hal: await teamsOf(hal.userId),
      ida: await teamsOf(ida.userId),
      jan: await teamsOf(jan.userId),
    }).toStrictEqual({
      landed: true,
      failure: null,
      hal: [kept],
      ida: [],
      jan: [],
    });
  });

  it("keeps a revocation for open App pages in the batch that takes someone out of a team", async () => {
    const { admin } = await connectedDirectory(idp);
    const [finance, sales] = [
      await teamNamed(admin.session, `Finance ${crypto.randomUUID()}`),
      await teamNamed(admin.session, `Sales ${crypto.randomUUID()}`),
    ];
    const names = await env.DB.prepare(
      "SELECT id, name FROM teams WHERE id IN (?, ?)"
    )
      .bind(finance, sales)
      .all<{ id: string; name: string }>();
    const nameOf = (id: string) =>
      names.results.find((team) => team.id === id)?.name ?? "";
    const kim = await memberWith(crypto.randomUUID());
    await directoryHolds([user({ id: kim.oid, department: nameOf(finance) })]);
    await readAt(nextDay());
    await directoryHolds([user({ id: kim.oid, department: nameOf(sales) })]);
    let kept = -1;
    // Right after the read's batch, before what it kept is told.
    const { coreEnv, landed } = landingAt(readsBatch, "after", async () => {
      const row = await env.DB.prepare(
        "SELECT count(*) AS n FROM access_revocations WHERE app_id IS NULL AND user_ids IS NULL"
      ).first<number>("n");
      kept = row ?? 0;
    });

    await readAt(nextDay(), { DB: coreEnv.DB });

    expect({
      landed: landed(),
      kept,
      teams: await teamsOf(kim.userId),
    }).toStrictEqual({ landed: true, kept: 1, teams: [sales] });
  });

  it("keeps the teams' member counts right after a failed read and its retry", async () => {
    const { admin } = await connectedDirectory(idp);
    const [finance, sales] = [
      await teamNamed(admin.session, `Finance ${crypto.randomUUID()}`),
      await teamNamed(admin.session, `Sales ${crypto.randomUUID()}`),
    ];
    const names = await env.DB.prepare(
      "SELECT id, name FROM teams WHERE id IN (?, ?)"
    )
      .bind(finance, sales)
      .all<{ id: string; name: string }>();
    const nameOf = (id: string) =>
      names.results.find((team) => team.id === id)?.name ?? "";
    const lou = await memberWith(crypto.randomUUID());
    await directoryHolds([user({ id: lou.oid, department: nameOf(finance) })]);
    await readAt(nextDay());
    await directoryHolds([user({ id: lou.oid, department: nameOf(sales) })]);
    const at = nextDay();

    const failed = await readAt(at, { DB: refusingBatches }).then(
      () => "applied",
      () => "failed"
    );
    const afterFailure = await countsOf(finance, sales);
    await readAt(new Date(at.getTime() + 15 * 60 * 1000));

    const counts = (financeCount: number, salesCount: number) =>
      [
        { id: finance, kept: financeCount, counted: financeCount },
        { id: sales, kept: salesCount, counted: salesCount },
      ].toSorted((one, other) => (one.id < other.id ? -1 : 1));
    expect({
      failed,
      afterFailure,
      afterRetry: await countsOf(finance, sales),
    }).toStrictEqual({
      failed: "failed",
      afterFailure: counts(1, 0),
      afterRetry: counts(0, 1),
    });
  });

  it("puts a member who signs in after the read in their department's team as they sign in", async () => {
    const { admin } = await connectedDirectory(idp);
    const support = await teamNamed(
      admin.session,
      `Support ${crypto.randomUUID()}`
    );
    const name = await env.DB.prepare("SELECT name FROM teams WHERE id = ?")
      .bind(support)
      .first<string>("name");
    const oid = crypto.randomUUID();
    await directoryHolds([user({ id: oid, department: name ?? "" })]);
    await readAt(nextDay());

    const mia = await memberWith(oid);

    await expect(teamsOf(mia.userId)).resolves.toStrictEqual([support]);
  });

  it("places nobody whose department no team has the name of, two teams have, or who has none", async () => {
    const { admin } = await connectedDirectory(idp);
    const twice = `Twice ${crypto.randomUUID()}`;
    await teamNamed(admin.session, twice);
    await teamNamed(admin.session, twice);
    const [ned, oli, pim] = [
      await memberWith(crypto.randomUUID()),
      await memberWith(crypto.randomUUID()),
      await memberWith(crypto.randomUUID()),
    ];
    await directoryHolds([
      user({ id: ned.oid, department: twice }),
      user({ id: oli.oid, department: `Nobody ${crypto.randomUUID()}` }),
      user({ id: pim.oid, department: null }),
    ]);

    await readAt(nextDay());

    expect({
      ned: await teamsOf(ned.userId),
      oli: await teamsOf(oli.userId),
      pim: await teamsOf(pim.userId),
    }).toStrictEqual({ ned: [], oli: [], pim: [] });
  });

  it("records one membership once when two reads run at once", async () => {
    const { admin } = await connectedDirectory(idp);
    const team = await teamNamed(admin.session, `Once ${crypto.randomUUID()}`);
    const name = await env.DB.prepare("SELECT name FROM teams WHERE id = ?")
      .bind(team)
      .first<string>("name");
    const quin = await memberWith(crypto.randomUUID());
    await directoryHolds([user({ id: quin.oid, department: name ?? "" })]);
    const at = nextDay();
    const { coreEnv, landed } = landingAt(readsBatch, "before", async () => {
      await readAt(at);
    });

    const events = await auditedDuring(async () => {
      await readAt(at, { DB: coreEnv.DB });
    });

    expect({
      landed: landed(),
      teams: await teamsOf(quin.userId),
      added: events.filter(
        ({ action, target }) =>
          action === "team.member.added" && target?.id === team
      ).length,
    }).toStrictEqual({ landed: true, teams: [team], added: 1 });
  });

  it("after a member's removal and erasure keeps no pin or mark of theirs", async () => {
    const { admin } = await connectedDirectory(idp);
    const [made, byHandTeam] = [
      await teamNamed(admin.session, `Made ${crypto.randomUUID()}`),
      await teamNamed(admin.session, `Hand ${crypto.randomUUID()}`),
    ];
    const name = await env.DB.prepare("SELECT name FROM teams WHERE id = ?")
      .bind(made)
      .first<string>("name");
    const rex = await memberWith(crypto.randomUUID());
    await directoryHolds([user({ id: rex.oid, department: name ?? "" })]);
    await readAt(nextDay());
    await byHand(admin.session, "add", byHandTeam, rex.userId);
    const [mark] = await membershipsOf(rex.userId);

    await admin.api.members.remove(rex.userId);
    const pinsAfterRemoval = await env.DB.prepare(
      "SELECT count(*) AS n FROM team_pins WHERE user_id = ?"
    )
      .bind(rex.userId)
      .first<number>("n");
    await admin.api.members.erase(rex.userId, rex.name);

    const { results: pins } = await env.DB.prepare(
      "SELECT * FROM team_pins WHERE user_id = ?"
    )
      .bind(rex.userId)
      .all();
    const { results: marks } = await env.DB.prepare(
      "SELECT * FROM directory_memberships WHERE membership_key = ?"
    )
      .bind(mark?.key ?? "")
      .all();
    expect({ pinsAfterRemoval, pins, marks }).toStrictEqual({
      pinsAfterRemoval: 0,
      pins: [],
      marks: [],
    });
  });

  it("never marks a membership an admin made by hand as the read's, though its department names that team", async () => {
    const { admin } = await connectedDirectory(idp);
    const team = await teamNamed(admin.session, `Hand ${crypto.randomUUID()}`);
    const name = await env.DB.prepare("SELECT name FROM teams WHERE id = ?")
      .bind(team)
      .first<string>("name");
    const sam = await memberWith(crypto.randomUUID());
    await byHand(admin.session, "add", team, sam.userId);
    await admin.api.members.releaseTeamPin(sam.userId, team);
    await directoryHolds([user({ id: sam.oid, department: name ?? "" })]);

    await readAt(nextDay());

    const [membership] = await membershipsOf(sam.userId);
    expect(membership?.made).toBe(0);
  });

  it("links no department to a team renamed just before the read's batch", async () => {
    const { admin } = await connectedDirectory(idp);
    const team = await teamNamed(admin.session, `Old ${crypto.randomUUID()}`);
    const name = await env.DB.prepare("SELECT name FROM teams WHERE id = ?")
      .bind(team)
      .first<string>("name");
    const tom = await memberWith(crypto.randomUUID());
    await directoryHolds([user({ id: tom.oid, department: name ?? "" })]);
    const { coreEnv, landed } = landingAt(readsBatch, "before", async () => {
      const renamed = await callAuth(
        "/organization/update-team",
        admin.session,
        { teamId: team, data: { name: `New ${crypto.randomUUID()}` } }
      );
      await renamed.body?.cancel();
    });

    await readAt(nextDay(), { DB: coreEnv.DB });
    const links = await env.DB.prepare(
      "SELECT count(*) AS n FROM directory_departments WHERE team_id = ?"
    )
      .bind(team)
      .first<number>("n");

    expect({
      landed: landed(),
      links,
      teams: await teamsOf(tom.userId),
    }).toStrictEqual({ landed: true, links: 0, teams: [] });
  });

  it("places nobody an admin removed between the tie at their sign-in and its placement", async () => {
    const { admin } = await connectedDirectory(idp);
    const team = await teamNamed(admin.session, `Late ${crypto.randomUUID()}`);
    const name = await env.DB.prepare("SELECT name FROM teams WHERE id = ?")
      .bind(team)
      .first<string>("name");
    const oid = crypto.randomUUID();
    await directoryHolds([user({ id: oid, department: name ?? "" })]);
    await readAt(nextDay());
    const person = entraPerson(acmeTenant, "acme.test", { oid });
    let userId = "";
    // The placement's batch, as its first statement shows it.
    const { coreEnv, landed } = landingAt(
      /insert into "directory_departments"/u,
      "before",
      async () => {
        const row = await env.DB.prepare(
          "SELECT user_id AS id FROM accounts WHERE oid = ?"
        )
          .bind(oid)
          .first<string>("id");
        userId = row ?? "";
        await admin.api.members.remove(userId);
      }
    );

    await signedIn(idp, "microsoft", person, {
      coreEnv: {
        ...withSignIn({
          admins: [String(person.email)],
          entra: { tenantId: acmeTenant, clientId: entraClient.id },
        }),
        DB: coreEnv.DB,
      },
    });

    expect({ landed: landed(), teams: await teamsOf(userId) }).toStrictEqual({
      landed: true,
      teams: [],
    });
  });
});
