import { minTeamShown } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { recordEvents, shareAudiencesAs } from "../src/brain-next.ts";
import { inStoreOf } from "./brain-next-out-reads.ts";
import { landingAt, withD1ValueLimit } from "./d1-landing.ts";
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

// Everyone the directory's daily read places in a team is a member from
// that read on, before they ever sign in (GRA-2156), so teams, the Brain's
// audiences and their counts are right from the first day. Only Microsoft
// Graph is faked; core, connect and sign-in are the real ones. The ways it
// could go wrong come first: someone made who isn't placed (a service
// account, a turned-off, guest or erased account, someone removed), a
// second member for one person, a first sign-in landing on anyone but the
// member made for them, a made member the read then loses track of.

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

/** The read's batch, as its first statement shows it. */
const readsBatch = /insert into "directory_reads"/u;

/** `oid` signing in with Microsoft: their member's user ID, and who they are. */
const signsIn = async (oid: string, claims: Record<string, unknown> = {}) => {
  const person = entraPerson(acmeTenant, "acme.test", { oid, ...claims });
  const session = await signedIn(idp, "microsoft", person, {
    coreEnv: withSignIn({
      entra: { tenantId: acmeTenant, clientId: entraClient.id },
    }),
  });
  const { userId, role } = await whoami(session);
  return { userId, role, name: String(person.name) };
};

const idSchema = z.object({ id: z.string() });

/** A members' team an admin made, by a new name: its id and name. */
const newTeam = async (session: string) => {
  const name = `Team ${crypto.randomUUID()}`;
  const made = await callAuth("/organization/create-team", session, { name });
  const { id } = idSchema.parse(await made.json());
  return { id, name };
};

/** The members whose accounts name `oid`: who, by which provider. */
const membersNaming = async (oid: string) => {
  const { results } = await env.DB.prepare(
    `SELECT a.user_id AS userId, a.provider_id AS provider, a.verified_tenant AS tenant,
        m.role, u.email
      FROM accounts a
      JOIN users u ON u.id = a.user_id
      LEFT JOIN members m ON m.user_id = a.user_id
      WHERE lower(a.oid) = lower(?) ORDER BY a.provider_id`
  )
    .bind(oid)
    .all<{
      userId: string;
      provider: string;
      tenant: string | null;
      role: string | null;
      email: string;
    }>();
  return results;
};

/** `membersNaming(oid)`, each row as `pick` keeps it. */
const namingAs = async <T>(
  oid: string,
  pick: (row: Awaited<ReturnType<typeof membersNaming>>[number]) => T
): Promise<T[]> => {
  const naming = await membersNaming(oid);
  return naming.map(pick);
};

/** The member the directory made for `oid`, if any. */
const madeFor = async (oid: string): Promise<string | undefined> => {
  const naming = await membersNaming(oid);
  return naming.find(({ provider }) => provider === "entra-directory")?.userId;
};

/** The teams `userId` is in. */
const teamsOf = async (userId: string | undefined): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    "SELECT team_id AS teamId FROM team_members WHERE user_id = ? ORDER BY team_id"
  )
    .bind(userId ?? "")
    .all<{ teamId: string }>();
  return results.map(({ teamId }) => teamId);
};

/** Whether `userId` is suspended. */
const suspended = async (userId: string | undefined): Promise<boolean> =>
  (await env.DB.prepare(
    "SELECT suspended_at IS NOT NULL AS suspended FROM members WHERE user_id = ?"
  )
    .bind(userId ?? "")
    .first<number>("suspended")) === 1;

describe("a person the directory's read places, before they sign in", () => {
  it("is a member from that read on, in their team, under the name the directory gives and no address, recorded once as the system's", async () => {
    const { admin } = await connectedDirectory(idp);
    const team = await newTeam(admin.session);
    const oid = crypto.randomUUID();
    await directoryHolds([
      user({ id: oid, displayName: "Ada Lovelace", department: team.name }),
    ]);

    const events = await auditedDuring(async () => {
      await readAt(nextDay());
    });
    const made = await madeFor(oid);
    await readAt(nextDay());

    expect({
      naming: await namingAs(oid, ({ provider, tenant, role, email }) => ({
        provider,
        tenant,
        role,
        email,
      })),
      name: await env.DB.prepare("SELECT name FROM users WHERE id = ?")
        .bind(made ?? "")
        .first<string>("name"),
      teams: await teamsOf(made),
      joined: events
        .filter(({ action }) => action === "member.joined_from_directory")
        .map(({ actor, target }) => ({ actor, target })),
    }).toStrictEqual({
      naming: [
        {
          provider: "entra-directory",
          tenant: acmeTenant.toLowerCase(),
          role: "user",
          email: `${oid}@directory.invalid`,
        },
      ],
      name: "Ada Lovelace",
      teams: [team.id],
      joined: [
        { actor: { type: "system" }, target: { type: "user", id: made } },
      ],
    });
  });

  it("is not made at all when the read places them nowhere: no department, or one no team is named", async () => {
    await connectedDirectory(idp);
    const [none, unnamed] = [crypto.randomUUID(), crypto.randomUUID()];
    await directoryHolds([
      user({ id: none }),
      user({ id: unnamed, department: `Nowhere ${crypto.randomUUID()}` }),
    ]);

    await readAt(nextDay());

    expect({
      none: await membersNaming(none),
      unnamed: await membersNaming(unnamed),
    }).toStrictEqual({ none: [], unnamed: [] });
  });

  it("is taken back in the same batch, unrecorded, when its join places them nowhere: their team deleted just before it", async () => {
    const { admin } = await connectedDirectory(idp);
    const team = await newTeam(admin.session);
    const oid = crypto.randomUUID();
    await directoryHolds([user({ id: oid, department: team.name })]);
    const { coreEnv, landed } = landingAt(readsBatch, "before", async () => {
      await env.DB.prepare("DELETE FROM teams WHERE id = ?")
        .bind(team.id)
        .run();
    });

    const events = await auditedDuring(async () => {
      await readAt(nextDay(), { DB: coreEnv.DB });
    });

    expect({
      landed: landed(),
      naming: await membersNaming(oid),
      placeholder: await env.DB.prepare(
        "SELECT count(*) AS n FROM users WHERE email = ?"
      )
        .bind(`${oid}@directory.invalid`)
        .first<number>("n"),
      joined: events.filter(
        ({ action }) => action === "member.joined_from_directory"
      ),
    }).toStrictEqual({ landed: true, naming: [], placeholder: 0, joined: [] });
  });

  it("is never made for a turned-off account or a guest, though their department names a team", async () => {
    const { admin } = await connectedDirectory(idp);
    const team = await newTeam(admin.session);
    const [off, guest] = [crypto.randomUUID(), crypto.randomUUID()];
    await directoryHolds([
      user({ id: off, department: team.name, accountEnabled: false }),
      user({ id: guest, department: team.name, userType: "Guest" }),
    ]);

    await readAt(nextDay());

    expect({
      off: await membersNaming(off),
      guest: await membersNaming(guest),
    }).toStrictEqual({ off: [], guest: [] });
  });

  it("is never made again for someone an admin removed, nor for someone erased, though the directory still places them", async () => {
    const { admin } = await connectedDirectory(idp);
    const team = await newTeam(admin.session);
    const [removedOid, erasedOid] = [crypto.randomUUID(), crypto.randomUUID()];
    const removed = await signsIn(removedOid);
    const erased = await signsIn(erasedOid);
    await admin.api.members.remove(removed.userId);
    await admin.api.members.remove(erased.userId);
    await admin.api.members.erase(erased.userId, erased.name);
    await directoryHolds([
      user({ id: removedOid, department: team.name }),
      user({ id: erasedOid, department: team.name }),
    ]);

    await readAt(nextDay());

    expect({
      removed: await namingAs(removedOid, ({ userId, role }) => ({
        userId,
        role,
      })),
      erased: await membersNaming(erasedOid),
    }).toStrictEqual({
      removed: [{ userId: removed.userId, role: null }],
      erased: [],
    });
  });

  it("is that same member at their first sign-in, by the object ID their token names in whatever case, never a second one", async () => {
    const { admin } = await connectedDirectory(idp);
    const team = await newTeam(admin.session);
    const oid = crypto.randomUUID();
    await directoryHolds([user({ id: oid, department: team.name })]);
    await readAt(nextDay());
    const made = await madeFor(oid);

    const signed = await signsIn(oid.toUpperCase());

    expect({
      same: signed.userId === made,
      role: signed.role,
      naming: await namingAs(oid, ({ userId, provider }) => ({
        userId,
        provider,
      })),
      teams: await teamsOf(signed.userId),
    }).toStrictEqual({
      same: true,
      role: "user",
      naming: [{ userId: made, provider: "microsoft" }],
      teams: [team.id],
    });
  });

  it("is one member when their first sign-in lands between the read's snapshot and its batch, whatever case their token gives the object ID in", async () => {
    const { admin } = await connectedDirectory(idp);
    const team = await newTeam(admin.session);
    const oid = crypto.randomUUID();
    await directoryHolds([user({ id: oid, department: team.name })]);
    let userId = "";
    const { coreEnv, landed } = landingAt(readsBatch, "before", async () => {
      ({ userId } = await signsIn(oid.toUpperCase()));
    });
    // Every ID the read makes sorts below any Better Auth makes, so a
    // member made over the sign-in would be the one the tie names, every
    // time: the read must see the sign-in's account, however it is cased.
    const real = crypto.randomUUID.bind(crypto);
    const lowest = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      const [, b = "", c = "", d = "", e = ""] = real().split("-");
      return `00000000-${b}-${c}-${d}-${e}`;
    });
    try {
      await readAt(nextDay(), { DB: coreEnv.DB });
    } finally {
      lowest.mockRestore();
    }
    const naming = await membersNaming(oid);
    await readAt(nextDay());

    expect({
      landed: landed(),
      naming: naming.map(({ userId: who, provider }) => ({ who, provider })),
      teams: await teamsOf(userId),
    }).toStrictEqual({
      landed: true,
      naming: [{ who: userId, provider: "microsoft" }],
      teams: [team.id],
    });
  });

  it("is moved by a later read when their department changes", async () => {
    const { admin } = await connectedDirectory(idp);
    const [first, second] = [
      await newTeam(admin.session),
      await newTeam(admin.session),
    ];
    const oid = crypto.randomUUID();
    await directoryHolds([user({ id: oid, department: first.name })]);
    await readAt(nextDay());
    const made = await madeFor(oid);

    await directoryHolds([user({ id: oid, department: second.name })]);
    await readAt(nextDay());

    expect({
      teams: await teamsOf(made),
      members: await namingAs(oid, ({ userId }) => userId),
    }).toStrictEqual({ teams: [second.id], members: [made] });
  });

  it("is suspended when their account is turned off, and when it is deleted", async () => {
    const { admin } = await connectedDirectory(idp);
    const team = await newTeam(admin.session);
    const [off, deleted] = [crypto.randomUUID(), crypto.randomUUID()];
    await directoryHolds([
      user({ id: off, department: team.name }),
      user({ id: deleted, department: team.name }),
    ]);
    await readAt(nextDay());
    const [madeOff, madeDeleted] = [await madeFor(off), await madeFor(deleted)];

    await directoryHolds(
      [user({ id: off, department: team.name, accountEnabled: false })],
      [{ id: deleted, userType: "Member" }]
    );
    await readAt(nextDay());

    expect({
      off: await suspended(madeOff),
      deleted: await suspended(madeDeleted),
    }).toStrictEqual({ off: true, deleted: true });
  });

  it("makes and places thousands in one read, within what D1 takes in a value and a statement", async () => {
    const { admin } = await connectedDirectory(idp);
    // A short name: the directory's own JSON stays under D1's value.
    const name = `M${crypto.randomUUID().slice(0, 8)}`;
    const made = await callAuth("/organization/create-team", admin.session, {
      name,
    });
    const { id: team } = idSchema.parse(await made.json());
    const count = 3000;
    await directoryHolds(
      Array.from({ length: count }, () =>
        user({
          id: crypto.randomUUID(),
          displayName: "Someone",
          department: name,
        })
      )
    );

    await readAt(nextDay(), { DB: withD1ValueLimit() });

    const placed = await env.DB.prepare(
      "SELECT count(*) AS n FROM team_members WHERE team_id = ?"
    )
      .bind(team)
      .first<number>("n");
    const failure = await env.DB.prepare(
      "SELECT failure FROM directory_reads WHERE provider = 'microsoft-directory'"
    ).first<string | null>("failure");
    expect({ placed, failure }).toStrictEqual({ placed: count, failure: null });
  });
});

/** Every step the shared store keeps as an event for `team`. */
const stepsOf = async (team: string): Promise<unknown[]> =>
  await inStoreOf("brain", (store) =>
    store
      .exec<{ step: string }>(
        "SELECT step FROM events WHERE team = ?",
        `team:${team}`
      )
      .toArray()
      .map(({ step }) => step)
  );

/**
 * A team the read fills with `count` people, none signed in: its id, and
 * each person's object ID.
 */
const filledTeam = async (count: number) => {
  const { admin } = await connectedDirectory(idp);
  const team = await newTeam(admin.session);
  const oids = Array.from({ length: count }, () => crypto.randomUUID());
  await directoryHolds(oids.map((id) => user({ id, department: team.name })));
  await readAt(nextDay());
  return { team: team.id, oids };
};

describe("the minimums that keep who shared or did something hidden", () => {
  it("count a team's members only once they signed in, for sharing with it", async () => {
    const { team, oids } = await filledTeam(5);
    const [first, second, third] = oids;
    const sharer = await signsIn(String(first));
    await signsIn(String(second));
    const padded = await shareAudiencesAs(env, sharer.userId);
    await signsIn(String(third));
    const enough = await shareAudiencesAs(env, sharer.userId);

    expect({
      padded: padded.teams.map(({ id }) => id),
      enough: enough.teams.map(({ id }) => id),
    }).toStrictEqual({ padded: [], enough: [team] });
  });

  it("count a team's members only once they signed in, for keeping its events", async () => {
    const { team, oids } = await filledTeam(minTeamShown + 2);
    const [first, ...others] = oids;
    const person = await signsIn(String(first));
    for (const oid of others.slice(0, minTeamShown - 2)) {
      // oxlint-disable-next-line no-await-in-loop -- one sign-in at a time
      await signsIn(oid);
    }
    const step = (name: string) => ({
      key: crypto.randomUUID(),
      personId: person.userId,
      step: name,
      system: "crm",
      writes: false,
      item: null,
      at: new Date(),
    });
    await recordEvents(env, [step("padded")]);
    await signsIn(String(others[minTeamShown - 2]));
    await recordEvents(env, [step("enough")]);

    await expect(stepsOf(team)).resolves.toStrictEqual(["enough"]);
  });
});
