import { recallBudgetMax } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import {
  addSource,
  listSourcesAs,
  readSourceVersionAs,
  recallAs,
} from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { setConnectionAudience } from "../src/connection-audiences.ts";
import { teams } from "../src/db/core/schema.ts";
import { join, leave, newTeam } from "./brain-next-leaks-harness.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  signedInWithRole,
  staffPerson,
  unique,
  uniqueWord,
  whoami,
} from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// Who may read in the Brain what agents read through a shared connection
// (GRA-1831): the audience an admin chooses for the connection, one team
// or everyone, decided from core's records at every read. These start
// from the ways it can fail: someone outside the audience reading it, at
// any reach, after leaving the team, or once the team is gone; the
// audience set by someone other than the company's own admins, on a
// personal connection, or without a trace; and what is kept for a
// connection's audience landing anywhere else.

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** A connection in connect's registry: shared unless `owner` is named. */
const connection = async ({
  owner = null,
  status = "active",
}: {
  owner?: string | null;
  status?: "active" | "disconnected";
} = {}): Promise<string> => {
  const id = `connection-hubspot-${unique()}`;
  const now = Date.now();
  await connectDb()
    .prepare(
      "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, created_at, updated_at) VALUES (?, 'hubspot', ?, ?, ?, 'composio', 'hubspot', ?, ?)"
    )
    .bind(id, owner === null ? "shared" : "personal", owner, status, now, now)
    .run();
  return id;
};

/** What an agent read through `connectionId`, kept with `marker` for its audience. */
const keptThrough = async (
  connectionId: string,
  marker: string
): Promise<SourceRef> => {
  const source: SourceRef = {
    producer: "connected",
    id: `${connectionId}/${crypto.randomUUID()}`,
  };
  await addSource(env, {
    source,
    change: crypto.randomUUID(),
    text: `Deal Rotterdam warehouse ${marker}`,
    readers: { kind: "connection", connectionId },
  });
  return source;
};

/** Whether a reader found it, at each reach `findsAt` asks at. */
interface Reaches {
  person: boolean;
  teams: boolean;
  namedTeams: boolean;
  company: boolean;
}

/**
 * Whether `personId` finds `source` holding `marker` at each reach: as
 * themselves, as their teams (a chat's code in their own chat), as the
 * company with `teamIds` named (an App granted those teams), and as the
 * company alone (a shared thread, any other App or workflow).
 */
const findsAt = async (
  personId: string,
  source: SourceRef,
  marker: string,
  teamIds: string[] = []
): Promise<Reaches> => {
  const finds = async (reach: {
    personal: boolean;
    company?: true;
    teams?: string[];
  }): Promise<boolean> => {
    const { items } = await recallAs(env, personId, {
      ...reach,
      question: marker,
      budget: { tokens: recallBudgetMax },
    });
    return items.some(
      ({ source: found, text }) =>
        found.producer === source.producer &&
        found.id === source.id &&
        text.includes(marker)
    );
  };
  const [person, ownTeams, namedTeams, company] = await Promise.all([
    finds({ personal: true }),
    finds({ personal: false }),
    finds({ personal: false, company: true, teams: teamIds }),
    finds({ personal: false, company: true }),
  ]);
  return { person, teams: ownTeams, namedTeams, company };
};

const nowhere: Reaches = {
  person: false,
  teams: false,
  namedTeams: false,
  company: false,
};

/** How core's read of an audience starts (connection-audiences.ts `heldBy`). */
const audienceRead = 'select "team_id" from "connection_brain_audiences"';

/**
 * Core's database, but `between` runs right after the first read of a
 * connection's audience has answered, before its reader gets the answer:
 * as another admin's change landing between one change's read and its
 * write. Every other statement is the database's own.
 */
const changedAfterFirstRead = (
  database: D1Database,
  between: () => Promise<void>
): D1Database => {
  let ran = false;
  const after = async <T>(read: Promise<T>): Promise<T> => {
    const answered = await read;
    if (!ran) {
      ran = true;
      await between();
    }
    return answered;
  };
  const reading = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get: (target, name): unknown => {
        const member: unknown = Reflect.get(target, name);
        if (typeof member !== "function") {
          return member;
        }
        if (name === "bind") {
          return (...values: unknown[]): D1PreparedStatement =>
            reading(target.bind(...values));
        }
        if (name === "all" || name === "raw" || name === "first") {
          return async (...given: unknown[]): Promise<unknown> =>
            await after(Promise.resolve(Reflect.apply(member, target, given)));
        }
        return (...given: unknown[]): unknown =>
          Reflect.apply(member, target, given);
      },
    });
  return new Proxy(database, {
    get: (target, name): unknown => {
      const member: unknown = Reflect.get(target, name);
      if (typeof member !== "function") {
        return member;
      }
      if (name === "prepare") {
        return (query: string): D1PreparedStatement => {
          const statement = target.prepare(query);
          return query.startsWith(audienceRead)
            ? reading(statement)
            : statement;
        };
      }
      return (...given: unknown[]): unknown =>
        Reflect.apply(member, target, given);
    },
  });
};

/** Whether `personId` reads `source`'s first version, as the Sources page does. */
const readsVersion = async (
  personId: string,
  source: SourceRef
): Promise<boolean> => {
  const read = await readSourceVersionAs(env, personId, { source, version: 1 });
  return read !== null;
};

/** Whether the Sources page lists `source` among `personId`'s first page. */
const listsFor = async (
  personId: string,
  source: SourceRef
): Promise<boolean> => {
  const { sources } = await listSourcesAs(env, personId);
  return sources.some(({ source: listed }) => listed.id === source.id);
};

/** What adding `source` for `readers` ends in: `ok`, or why it was refused. */
const added = async (
  source: SourceRef,
  readers: SourceReaders
): Promise<string> =>
  await outcome(
    addSource(env, {
      source,
      change: crypto.randomUUID(),
      text: "Deal notes",
      readers,
    })
  );

describe("a shared connection's Brain audience", setUpTime, () => {
  it("lets a team read what is kept for it, at every reach a document for that team reaches, and nobody else", async () => {
    const [admin, { userId: seller }, { userId: outsider }] = await Promise.all(
      [
        signedInApi(idp, "admin"),
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "user"),
      ]
    );
    const sales = await newTeam(seller);
    const other = await newTeam(outsider);
    const connectionId = await connection();
    const marker = uniqueWord();
    const source = await keptThrough(connectionId, marker);

    // Nobody, until an admin chooses.
    const before = await findsAt(seller, source, marker, [sales]);
    await admin.api.connections.setBrainAudience(connectionId, {
      kind: "team",
      teamId: sales,
    });
    const audiences = await admin.api.connections.brainAudiences();

    expect({
      before,
      seller: await findsAt(seller, source, marker, [sales]),
      // An App granted a team they aren't in reads none of it.
      sellerNamingAnother: await findsAt(seller, source, marker, [other]),
      outsider: await findsAt(outsider, source, marker, [sales, other]),
      // An admin's role reads nothing more.
      admin: await findsAt(admin.userId, source, marker, [sales]),
      versions: {
        seller: await readsVersion(seller, source),
        outsider: await readsVersion(outsider, source),
      },
      // Found by recall, never listed a row a record.
      listed: await listsFor(seller, source),
      audiences: audiences
        .filter((each) => each.connectionId === connectionId)
        .map(({ changedAt, ...each }) => ({
          ...each,
          changedAt: Number.isNaN(Date.parse(changedAt))
            ? "not a time"
            : "a time",
        })),
    }).toStrictEqual({
      before: nowhere,
      // As a document for Sales: never in a shared thread (the company
      // alone), nor for an App granted other teams.
      seller: { person: true, teams: true, namedTeams: true, company: false },
      sellerNamingAnother: {
        person: true,
        teams: true,
        namedTeams: false,
        company: false,
      },
      outsider: nowhere,
      admin: nowhere,
      versions: { seller: true, outsider: false },
      listed: false,
      audiences: [
        {
          connectionId,
          audience: { kind: "team", teamId: sales },
          changedBy: admin.userId,
          changedAt: "a time",
        },
      ],
    });
  });

  it("follows the team's members and the audience from the next read, widening to what was kept before and back to nobody", async () => {
    const [admin, { userId: seller }, { userId: newcomer }] = await Promise.all(
      [
        signedInApi(idp, "admin"),
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "user"),
      ]
    );
    const sales = await newTeam(seller);
    const connectionId = await connection();
    const marker = uniqueWord();
    const source = await keptThrough(connectionId, marker);
    /** Whether the seller and the newcomer find it, as `reach` reads. */
    const seen = async (reach: keyof Reaches) => {
      const [bySeller, byNewcomer] = await Promise.all([
        findsAt(seller, source, marker),
        findsAt(newcomer, source, marker),
      ]);
      return { seller: bySeller[reach], newcomer: byNewcomer[reach] };
    };
    await admin.api.connections.setBrainAudience(connectionId, {
      kind: "team",
      teamId: sales,
    });
    const teamOnly = await seen("person");
    await join(sales, newcomer);
    await leave(sales, seller);
    const membersMoved = await seen("person");
    await admin.api.connections.setBrainAudience(connectionId, {
      kind: "everyone",
    });
    const everyone = await seen("company");
    await admin.api.connections.setBrainAudience(connectionId, {
      kind: "nobody",
    });
    const nobody = await seen("person");
    // Kept meanwhile: the team's again once an admin says so.
    await admin.api.connections.setBrainAudience(connectionId, {
      kind: "team",
      teamId: sales,
    });
    const teamAgain = await seen("person");

    expect({
      teamOnly,
      membersMoved,
      everyone,
      nobody,
      teamAgain,
    }).toStrictEqual({
      teamOnly: { seller: true, newcomer: false },
      membersMoved: { seller: false, newcomer: true },
      // Everyone in the company, a shared thread's reach included, and
      // what was kept before too.
      everyone: { seller: true, newcomer: true },
      nobody: { seller: false, newcomer: false },
      teamAgain: { seller: false, newcomer: true },
    });
  });

  it("is nobody's once its team is gone, nor anyone's who isn't a member, Grasp staff included", async () => {
    const [admin, { userId: seller }, former] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInWithRole(idp, "user"),
      signedInWithRole(idp, "user"),
    ]);
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const { userId: staff } = await whoami(staffSession);
    const sales = await newTeam(seller, former.userId);
    const connectionId = await connection();
    const marker = uniqueWord();
    const source = await keptThrough(connectionId, marker);
    await admin.api.connections.setBrainAudience(connectionId, {
      kind: "team",
      teamId: sales,
    });
    const readsAs = async (personId: string) =>
      await outcome(
        recallAs(env, personId, {
          personal: true,
          question: marker,
          budget: { tokens: recallBudgetMax },
        })
      );
    // Staff act in a deployment only once added as a user.
    const staffReads = await readsAs(staff);
    await admin.api.members.remove(former.userId);
    const formerReads = await readsAs(former.userId);
    const sellerBefore = await findsAt(seller, source, marker, [sales]);
    await drizzle(env.DB).delete(teams).where(eq(teams.id, sales));

    expect({
      staffReads,
      formerReads,
      sellerBefore,
      sellerAfter: await findsAt(seller, source, marker, [sales]),
    }).toStrictEqual({
      staffReads: "permission.person_inactive",
      formerReads: "permission.person_inactive",
      sellerBefore: {
        person: true,
        teams: true,
        namedTeams: true,
        company: false,
      },
      sellerAfter: nowhere,
    });
  });

  it("is set by the company's admins alone, on a shared connection connect holds, and each change is audited once", async () => {
    const [admin, member, { userId: owner }] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
      signedInWithRole(idp, "user"),
    ]);
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const staffRpc = await openRpc(staffSession);
    const staff = staffRpc.core.authenticate();
    const sales = await newTeam(member.userId);
    const [shared, personal, disconnected] = await Promise.all([
      connection(),
      connection({ owner }),
      connection({ status: "disconnected" }),
    ]);
    const forSales = { kind: "team", teamId: sales } as const;

    const refused = {
      member: await outcome(
        member.api.connections.setBrainAudience(shared, forSales)
      ),
      staff: await outcome(
        staff.connections.setBrainAudience(shared, forSales)
      ),
      personal: await outcome(
        admin.api.connections.setBrainAudience(personal, forSales)
      ),
      disconnected: await outcome(
        admin.api.connections.setBrainAudience(disconnected, forSales)
      ),
      unknown: await outcome(
        admin.api.connections.setBrainAudience(
          `connection-${unique()}`,
          forSales
        )
      ),
      unknownTeam: await outcome(
        admin.api.connections.setBrainAudience(shared, {
          kind: "team",
          teamId: crypto.randomUUID(),
        })
      ),
      listedByMember: await outcome(member.api.connections.brainAudiences()),
    };
    const events = await auditedDuring(async () => {
      await admin.api.connections.setBrainAudience(shared, forSales);
      // The same again changes nothing, and records nothing.
      await admin.api.connections.setBrainAudience(shared, forSales);
      await admin.api.connections.setBrainAudience(shared, {
        kind: "everyone",
      });
      await admin.api.connections.setBrainAudience(shared, { kind: "nobody" });
      await admin.api.connections.setBrainAudience(shared, { kind: "nobody" });
    });
    const audiences = await admin.api.connections.brainAudiences();

    expect({
      refused,
      events: events.map(({ action, actor, target, detail }) => ({
        action,
        actor,
        target,
        detail,
      })),
      audiences: audiences.filter(({ connectionId }) =>
        [shared, personal, disconnected].includes(connectionId)
      ),
    }).toStrictEqual({
      refused: {
        member: "role.forbidden",
        staff: "role.forbidden",
        personal: "connection.invalid",
        disconnected: "connection.invalid",
        unknown: "connection.invalid",
        unknownTeam: "connection.invalid",
        listedByMember: "role.forbidden",
      },
      // Each with what it changed from.
      events: [
        { from: "nobody", team: sales, who: "team" },
        { from: "team", fromTeam: sales, who: "everyone" },
        { from: "everyone", who: "nobody" },
      ].map((detail) => ({
        action: "brain.connection_audience.changed",
        actor: { type: "person", userId: admin.userId },
        target: { type: "connection", id: shared },
        detail,
      })),
      audiences: [],
    });
  });

  it("records what each of two admins' changes at once replaced: the one that lost its race records nothing, and its retry what it really replaced", async () => {
    const [first, second] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "admin"),
    ]);
    const [sales, support] = await Promise.all([
      newTeam(first.userId),
      newTeam(second.userId),
    ]);
    const connectionId = await connection();
    await first.api.connections.setBrainAudience(connectionId, {
      kind: "team",
      teamId: sales,
    });
    // The first admin reads Sales; before they write, the second admin
    // opens it to everyone.
    const racing: Env = {
      ...env,
      DB: changedAfterFirstRead(env.DB, async () => {
        await second.api.connections.setBrainAudience(connectionId, {
          kind: "everyone",
        });
      }),
    };
    const identity = await first.api.whoami();

    const events = await auditedDuring(async () => {
      await setConnectionAudience(racing, identity, connectionId, {
        kind: "team",
        teamId: support,
      });
    });
    const audiences = await first.api.connections.brainAudiences();

    expect({
      events: events.flatMap(({ action, actor, detail }) =>
        action === "brain.connection_audience.changed"
          ? [{ actor, detail }]
          : []
      ),
      now: audiences
        .filter((each) => each.connectionId === connectionId)
        .map(({ audience }) => audience),
    }).toStrictEqual({
      events: [
        {
          actor: { type: "person", userId: second.userId },
          detail: { from: "team", fromTeam: sales, who: "everyone" },
        },
        // Not "from Sales", which it read first: everyone is what it
        // replaced.
        {
          actor: { type: "person", userId: first.userId },
          detail: { from: "everyone", team: support, who: "team" },
        },
      ],
      now: [{ kind: "team", teamId: support }],
    });
  });

  it("is closed to nobody on any connection, one disconnected included, from the next read", async () => {
    const [admin, { userId: member }] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInWithRole(idp, "user"),
    ]);
    const connectionId = await connection();
    const marker = uniqueWord();
    const source = await keptThrough(connectionId, marker);
    await admin.api.connections.setBrainAudience(connectionId, {
      kind: "everyone",
    });
    const before = await findsAt(member, source, marker);
    await connectDb()
      .prepare("UPDATE connections SET status = 'disconnected' WHERE id = ?")
      .bind(connectionId)
      .run();

    expect({
      before: before.person,
      // Opening it again needs a connection connect holds; closing doesn't.
      everyoneAgain: await outcome(
        admin.api.connections.setBrainAudience(connectionId, {
          kind: "team",
          teamId: await newTeam(member),
        })
      ),
      nobody: await outcome(
        admin.api.connections.setBrainAudience(connectionId, {
          kind: "nobody",
        })
      ),
      gone: await outcome(
        admin.api.connections.setBrainAudience(`connection-${unique()}`, {
          kind: "nobody",
        })
      ),
      after: await findsAt(member, source, marker),
    }).toStrictEqual({
      before: true,
      everyoneAgain: "connection.invalid",
      nobody: "ok",
      gone: "ok",
      after: nowhere,
    });
  });

  it("keeps what is read through a shared connection for its audience alone, under its own key, and nothing else for one", async () => {
    const connectionId = await connection();
    const { userId: person } = await signedInWithRole(idp, "user");
    const forConnection: SourceReaders = { kind: "connection", connectionId };
    const under = (): string => `${connectionId}/${crypto.randomUUID()}`;
    const refusedAs =
      "Refused: only what agents read through a shared connection is for its audience, keyed under it";

    expect({
      kept: await added({ producer: "connected", id: under() }, forConnection),
      forEveryone: await added(
        { producer: "connected", id: under() },
        { kind: "everyone" }
      ),
      forOnePerson: await added(
        { producer: "connected", id: under() },
        { kind: "owner", personId: person }
      ),
      anotherConnectionsKey: await added(
        {
          producer: "connected",
          id: `connection-other/${crypto.randomUUID()}`,
        },
        forConnection
      ),
      aCaptureForIt: await added(
        { producer: "capture", id: under() },
        forConnection
      ),
      // Under the connection's own key, so only the rule that nothing
      // else is for a connection's audience can refuse them.
      anUploadForIt: await added(
        { producer: "upload", id: under() },
        forConnection
      ),
      aKickoffForIt: await added(
        { producer: "kickoff", id: under() },
        forConnection
      ),
    }).toStrictEqual({
      kept: "ok",
      forEveryone: `Error: ${refusedAs}`,
      forOnePerson: `Error: ${refusedAs}`,
      anotherConnectionsKey: `Error: ${refusedAs}`,
      // A capture is one person's own, refused as such first.
      aCaptureForIt: "Error: Refused: a capture is for one person alone",
      anUploadForIt: `Error: ${refusedAs}`,
      aKickoffForIt: `Error: ${refusedAs}`,
    });
  });
});
