import { brainOf, recallBudgetMax } from "@grasp-os/brain-next/contract";
import { createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { drainAuditOutboxes } from "../src/audit-drains.ts";
import { addSource, recallAs, workBrain } from "../src/brain-next.ts";
import type { SourceRef } from "../src/brain-next.ts";
import { setConnectionAudience } from "../src/connection-audiences.ts";
import { ConnectionsRpc } from "../src/connections.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import {
  claimSharedRead,
  completeOwedErasures,
  eraseSharedReadsOfDisconnect,
  stepErasure,
} from "../src/shared-reads.ts";
import {
  erasuresCounted,
  erasuresFailing,
  erasuresFailingFor,
  erasuresHeld,
} from "./brain-erasures-failing.ts";
import { newTeam } from "./brain-next-leaks-harness.ts";
import { copyOfStore, restoreStore } from "./brain-next-store-copy.ts";
import { afterFirstRead, refusingWrites } from "./d1-after-first-read.ts";
import { mockIdp } from "./idp.ts";
import { noProducers } from "./no-producers.ts";
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
} from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// What the Brain kept from a shared connection, listed per connection, and
// erasing it (GRA-1831): an admin's "Erase what the Brain kept", or the
// connection's disconnect. These start from the ways it can fail: a
// record kept after its erasure started, or brought back by a restore;
// someone reading while it runs, or an audience opened meanwhile, or on a
// connection a disconnect closed; an erasure that stops part-way read as
// done, or recorded twice; one step ending another erasure; a disconnect
// whose erasure could not start leaving connect's outbox, or one drained
// again starting a finished erasure again; a run of the clock spending
// more calls to the Brain than its budget; a key the Brain would refuse;
// someone else erasing; lane 1's own captures touched.

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

type Admin = Awaited<ReturnType<typeof signedInApi>>;

/** A connection in connect's registry: shared unless `owner` is named. */
const connection = async (owner: string | null = null): Promise<string> => {
  const id = `connection-hubspot-${unique()}`;
  const now = Date.now();
  await connectDb()
    .prepare(
      "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, created_at, updated_at) VALUES (?, 'hubspot', ?, ?, 'active', 'composio', 'hubspot', ?, ?)"
    )
    .bind(id, owner === null ? "shared" : "personal", owner, now, now)
    .run();
  return id;
};

/** A SHA-256 in hex, as a producer hashes a call. */
const hashOf = async (text: string): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/**
 * Keeps `text` as the record an agent read through `connectionId` for the
 * call `call`, as pull request 3's capture will: named first, then added.
 * Answers its source, or why nothing was kept.
 */
const kept = async (
  connectionId: string,
  call: string,
  text: string
): Promise<SourceRef | string> => {
  const source = await claimSharedRead(
    env,
    connectionId,
    await hashOf(call),
    new Date()
  );
  if (source === undefined) {
    return "not claimed";
  }
  const added = await outcome(
    addSource(env, {
      source,
      change: crypto.randomUUID(),
      text,
      readers: { kind: "connection", connectionId },
    })
  );
  return added === "ok" ? source : added;
};

/** Whether `personId` finds `marker` in a `shared` source, as themselves. */
const finds = async (personId: string, marker: string): Promise<boolean> => {
  const { items } = await recallAs(env, personId, {
    personal: true,
    question: marker,
    budget: { tokens: recallBudgetMax },
  });
  return items.some(
    ({ source, text }) =>
      source.producer === "connected" && text.includes(marker)
  );
};

/** The shared store's state of `source`'s key: free, held or erased. */
const keyState = async (source: SourceRef): Promise<string> =>
  await brainOf(inJurisdiction(env, env.BRAIN_STORE)).keyState(
    `${source.producer}:${source.id}`
  );

/** An admin, a member of a new team, and a shared connection open to it. */
const sharedWithTeam = async () => {
  const [admin, member] = await Promise.all([
    signedInApi(idp, "admin"),
    signedInWithRole(idp, "user"),
  ]);
  const team = await newTeam(member.userId);
  const connectionId = await connection();
  await admin.api.connections.setBrainAudience(connectionId, {
    kind: "team",
    teamId: team,
  });
  return { admin, member: member.userId, team, connectionId };
};

/** The events of `action` about `connectionId`, as the tests compare them. */
const about = (
  events: readonly AuditEvent[],
  action: string,
  connectionId: string
) =>
  events
    .filter(
      (event) => event.action === action && event.target?.id === connectionId
    )
    .map(({ actor, detail }) => ({ actor, detail }));

/** A disconnect that stopped `connectionId`, as connect records one, in its outbox. */
const disconnectRecorded = async (connectionId: string): Promise<string> => {
  const event = createAuditEvent(
    {
      actor: { type: "system" },
      action: "connection.disconnect",
      target: { type: "connection", id: connectionId },
      detail: { outcome: "ok" },
    },
    "connect"
  );
  await connectDb()
    .prepare(
      "INSERT INTO audit_outbox (id, event, created_at) VALUES (?, ?, ?)"
    )
    .bind(event.id, JSON.stringify(event), Date.now())
    .run();
  return event.id;
};

/** What `by`'s erase of what the Brain kept from `id` ends in. */
const erase = async (by: Admin["api"], id: string): Promise<string> =>
  await outcome(by.connections.eraseBrainReads(id));

/** Every erasure under way taken to its end, as the clock would, a step a run. */
const erasuresEnded = async (): Promise<void> => {
  for (let run = 0; run < 5; run += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one run at a time
    await completeOwedErasures(env);
  }
};

describe("what the Brain kept from a shared connection", setUpTime, () => {
  it("is named per connection only while an audience is chosen, once a record", async () => {
    const admin = await signedInApi(idp, "admin");
    const connectionId = await connection();
    const marker = uniqueWord();
    const before = await kept(connectionId, "deals", `Deals ${marker}`);
    await admin.api.connections.setBrainAudience(connectionId, {
      kind: "everyone",
    });
    const first = await kept(connectionId, "deals", `Deals ${marker}`);
    const again = await kept(connectionId, "deals", `Deals again ${marker}`);

    expect({ before, first, again }).toStrictEqual({
      before: "not claimed",
      first: {
        producer: "connected",
        id: `${connectionId}/0/${await hashOf("deals")}`,
      },
      // The same call again: the same source, its next version.
      again: first,
    });
  });

  it("is erased for good by an admin, its audience gone at once, a late arrival refused, and kept again under new keys once an audience is chosen", async () => {
    const { admin, member, team, connectionId } = await sharedWithTeam();
    const marker = uniqueWord();
    const records = [
      await kept(connectionId, "deal 1", `Deal one ${marker}`),
      await kept(connectionId, "deal 2", `Deal two ${marker}`),
    ];
    const sources = records.filter(
      (record): record is SourceRef => typeof record !== "string"
    );
    const foundBefore = await finds(member, marker);

    const events = await auditedDuring(async () => {
      await admin.api.connections.eraseBrainReads(connectionId);
      // Asked again while it may still run: nothing more.
      await admin.api.connections.eraseBrainReads(connectionId);
      await erasuresEnded();
    });
    const audiences = await admin.api.connections.brainAudiences();
    const after = {
      found: await finds(member, marker),
      keys: await Promise.all(sources.map(keyState)),
      audiences: audiences.filter((each) => each.connectionId === connectionId),
      // A read whose add was under way: its key is closed.
      late: await outcome(
        addSource(env, {
          source: sources[0] ?? { producer: "connected", id: "" },
          change: crypto.randomUUID(),
          text: `Deal one late ${marker}`,
          readers: { kind: "connection", connectionId },
        })
      ),
      // And nothing is named until an audience is chosen again.
      claimed: await kept(connectionId, "deal 1", `Deal one ${marker}`),
    };
    await admin.api.connections.setBrainAudience(connectionId, {
      kind: "team",
      teamId: team,
    });
    const newer = await kept(connectionId, "deal 1", `Deal one new ${marker}`);

    expect({
      records: records.length === sources.length,
      foundBefore,
      after,
      newer,
      foundNewer: await finds(member, `new ${marker}`),
      requested: about(
        events,
        "brain.shared_reads.erase_requested",
        connectionId
      ),
      erased: about(events, "brain.shared_reads.erased", connectionId),
    }).toStrictEqual({
      records: true,
      foundBefore: true,
      after: {
        found: false,
        keys: ["erased", "erased"],
        audiences: [],
        late: "brain.source_erased",
        claimed: "not claimed",
      },
      newer: {
        producer: "connected",
        id: `${connectionId}/1/${await hashOf("deal 1")}`,
      },
      foundNewer: true,
      requested: [
        { actor: { type: "person", userId: admin.userId }, detail: {} },
      ],
      erased: [
        {
          actor: { type: "person", userId: admin.userId },
          detail: { sources: 2 },
        },
      ],
    });
  });

  it("is erased by the connection's disconnect, once however often it is drained, and stays erased after a restore of an older copy", async () => {
    const { member, connectionId } = await sharedWithTeam();
    const marker = uniqueWord();
    const record = await kept(connectionId, "deal", `Deal ${marker}`);
    const source: SourceRef =
      typeof record === "string" ? { producer: "connected", id: "" } : record;
    const copy = await copyOfStore();
    const disconnect = await disconnectRecorded(connectionId);

    const events = await auditedDuring(async () => {
      await drainAuditOutboxes(env);
      await erasuresEnded();
      // Connect's event drained again, as after a lost settle: nothing more.
      await drainAuditOutboxes(env);
      await erasuresEnded();
    });
    const erased = {
      key: await keyState(source),
      found: await finds(member, marker),
    };
    // A copy from before the erasure: the ledger erases it again.
    await restoreStore(copy);
    await workBrain(env, new Date(), noProducers);
    const restored = {
      key: await keyState(source),
      found: await finds(member, marker),
    };

    expect({
      kept: typeof record !== "string",
      erased,
      restored,
      ended: about(events, "brain.shared_reads.erased", connectionId),
      left: await connectDb()
        .prepare("SELECT count(*) AS left FROM audit_outbox WHERE id = ?")
        .bind(disconnect)
        .first<{ left: number }>(),
    }).toStrictEqual({
      kept: true,
      erased: { key: "erased", found: false },
      restored: { key: "erased", found: false },
      ended: [{ actor: { type: "system" }, detail: { sources: 1 } }],
      left: { left: 0 },
    });
  });

  it("is listed on the Sources page, per connection with its count, to its audience alone, and its disconnect warns of the erasure", async () => {
    const [admin, member, outsider] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const connectionId = await connection();
    await admin.api.connections.setBrainAudience(connectionId, {
      kind: "team",
      teamId: await newTeam(member.userId),
    });
    await kept(connectionId, "deal 1", `Deal one ${uniqueWord()}`);
    await kept(connectionId, "deal 2", `Deal two ${uniqueWord()}`);
    const listedFor = async (api: Admin["api"]) => {
      const rows = await api.brainSources.connections();
      return rows.filter((each) => each.connectionId === connectionId);
    };
    const memberRows = await listedFor(member.api);
    const listed = await admin.api.connections.list();
    const memberListed = await member.api.connections.list();

    expect({
      member: memberRows.map(({ lastReadAt, ...row }) => ({
        ...row,
        lastReadAt: Number.isNaN(Date.parse(lastReadAt))
          ? "not a time"
          : "a time",
      })),
      // Outside its audience: nothing named, nothing counted. The admin
      // too, who isn't in the team.
      outsider: await listedFor(outsider.api),
      admin: await listedFor(admin.api),
      keepsReads: listed.find(({ id }) => id === connectionId)?.keepsReads,
      // Said to admins alone: a member, in its audience or not, isn't told.
      memberKeepsReads: memberListed
        .filter(({ id }) => id === connectionId)
        .map((each) => "keepsReads" in each),
    }).toStrictEqual({
      member: [
        {
          connectionId,
          // Its system's name, as the catalog has it.
          name: "HubSpot",
          account: null,
          records: 2,
          lastReadAt: "a time",
        },
      ],
      outsider: [],
      admin: [],
      keepsReads: true,
      memberKeepsReads: [false],
    });
  });

  it("is closed to everyone the moment its connection is disconnected", async () => {
    const { admin, member, connectionId } = await sharedWithTeam();
    const marker = uniqueWord();
    await kept(connectionId, "deal", `Deal ${marker}`);
    const before = await finds(member, marker);
    await admin.api.connections.disconnect(connectionId);
    // Before connect's record of it is drained.
    const audiences = await admin.api.connections.brainAudiences();

    expect({
      before,
      after: await finds(member, marker),
      audiences: audiences.filter((each) => each.connectionId === connectionId),
    }).toStrictEqual({ before: true, after: false, audiences: [] });
  });

  it("gives nobody anything once the disconnect answered, though an audience change that passed connect's check before it writes after it", async () => {
    const { admin, member, connectionId } = await sharedWithTeam();
    const marker = uniqueWord();
    await kept(connectionId, "deal", `Deal ${marker}`);
    await admin.api.connections.setBrainAudience(connectionId, {
      kind: "nobody",
    });
    const other = await signedInApi(idp, "admin");
    // The first admin's change passes connect's check; then, before it
    // writes, the other admin disconnects the connection, and the
    // disconnect answers. Connect's record of it is not drained yet.
    const racing: Env = {
      ...env,
      DB: afterFirstRead(
        env.DB,
        'select "erasing", "closed" from "connection_brain_erasures"',
        async () => {
          await other.api.connections.disconnect(connectionId);
        }
      ),
    };
    const identity = await admin.api.whoami();
    const opened = await outcome(
      setConnectionAudience(racing, identity, connectionId, {
        kind: "everyone",
      })
    );
    const audiences = await admin.api.connections.brainAudiences();

    expect({
      opened,
      audiences: audiences.filter((each) => each.connectionId === connectionId),
      found: await finds(member, marker),
      claimed: await kept(connectionId, "late", `Late ${marker}`),
    }).toStrictEqual({
      opened: "connection.invalid",
      audiences: [],
      found: false,
      claimed: "not claimed",
    });
  });

  it("trusts no audience row of a connection being erased, whatever wrote it: no read and no claim", async () => {
    const { admin, member, team, connectionId } = await sharedWithTeam();
    const marker = uniqueWord();
    await kept(connectionId, "deal", `Deal ${marker}`);
    await admin.api.connections.eraseBrainReads(connectionId);
    // A row no write of core's makes while it is erased, put there
    // straight.
    await env.DB.prepare(
      "INSERT INTO connection_brain_audiences (connection_id, team_id, changed_by, changed_at) VALUES (?, ?, ?, ?)"
    )
      .bind(connectionId, team, admin.userId, Date.now())
      .run();

    expect({
      found: await finds(member, marker),
      claimed: await kept(connectionId, "late", `Late ${marker}`),
    }).toStrictEqual({ found: false, claimed: "not claimed" });
  });

  it("is owed until every record is erased when the Brain fails part-way, and only then recorded as done", async () => {
    const { admin, member, connectionId } = await sharedWithTeam();
    const marker = uniqueWord();
    const record = await kept(connectionId, "deal", `Deal ${marker}`);
    const source: SourceRef =
      typeof record === "string" ? { producer: "connected", id: "" } : record;
    const failing = erasuresFailing();

    const events = await auditedDuring(async () => {
      // Started, and its first step failing in the Brain.
      await admin.api.connections.eraseBrainReads(connectionId);
      await outcome(stepErasure(failing, connectionId));
    });
    const whileOwed = {
      found: await finds(member, marker),
      key: await keyState(source),
      ended: about(events, "brain.shared_reads.erased", connectionId),
      audience: await outcome(
        admin.api.connections.setBrainAudience(connectionId, {
          kind: "everyone",
        })
      ),
      claimed: await kept(connectionId, "other", `Other ${marker}`),
    };
    const later = await auditedDuring(async () => {
      await erasuresEnded();
    });

    expect({
      kept: typeof record !== "string",
      whileOwed,
      key: await keyState(source),
      ended: about(later, "brain.shared_reads.erased", connectionId),
    }).toStrictEqual({
      kept: true,
      whileOwed: {
        // Nobody reads it from the start, though it is still held.
        found: false,
        key: "held",
        ended: [],
        audience: "connection.brain_erasing",
        claimed: "not claimed",
      },
      key: "erased",
      ended: [
        {
          actor: { type: "person", userId: admin.userId },
          detail: { sources: 1 },
        },
      ],
    });
  });

  it("ends an erasure only by the step of that same erasure: one held over the end of an older erasure never ends a newer one early", async () => {
    const { admin, member, team, connectionId } = await sharedWithTeam();
    const marker = uniqueWord();
    await kept(connectionId, "deal 1", `Old deal ${marker}`);
    await kept(connectionId, "deal 2", `Old deal two ${marker}`);
    // The first erasure starts: only steps run it.
    await admin.api.connections.eraseBrainReads(connectionId);
    // One step held at its erasure in the Brain (as the clock's and the
    // one at once can run at the same time), while another ends it.
    const held = erasuresHeld();
    const stale = stepErasure(held.env, connectionId);
    await held.reached;
    await completeOwedErasures(env);
    // An admin opens it again, two records are kept, and a second erasure
    // starts, before the held step goes on.
    await admin.api.connections.setBrainAudience(connectionId, {
      kind: "team",
      teamId: team,
    });
    const newer = [
      await kept(connectionId, "deal 1", `New deal ${marker}`),
      await kept(connectionId, "deal 3", `New deal three ${marker}`),
    ];
    const events = await auditedDuring(async () => {
      await admin.api.connections.eraseBrainReads(connectionId);
      held.release();
      await outcome(stale);
    });
    const afterStale = {
      ended: about(events, "brain.shared_reads.erased", connectionId),
      found: await finds(member, `New deal ${marker}`),
    };
    const later = await auditedDuring(async () => {
      await completeOwedErasures(env);
    });

    expect({
      kept: newer.every((record) => typeof record !== "string"),
      afterStale,
      keys: await Promise.all(
        newer.map(async (record) =>
          typeof record === "string" ? record : await keyState(record)
        )
      ),
      ended: about(later, "brain.shared_reads.erased", connectionId),
    }).toStrictEqual({
      kept: true,
      // Not ended by the step of the erasure before it, and nobody reads
      // its records meanwhile.
      afterStale: { ended: [], found: false },
      keys: ["erased", "erased"],
      ended: [
        {
          actor: { type: "person", userId: admin.userId },
          detail: { sources: 2 },
        },
      ],
    });
  });

  it("shares one budget of calls to the Brain among every erasure under way: no run spends more, and each ends over the next runs", async () => {
    const connections = await Promise.all([
      sharedWithTeam(),
      sharedWithTeam(),
      sharedWithTeam(),
    ]);
    const records: SourceRef[] = [];
    for (const { connectionId } of connections) {
      for (const deal of ["1", "2", "3", "4"]) {
        // oxlint-disable-next-line no-await-in-loop -- one record at a time
        const record = await kept(connectionId, `deal ${deal}`, `Deal ${deal}`);
        if (typeof record !== "string") {
          records.push(record);
        }
      }
      // oxlint-disable-next-line no-await-in-loop -- one disconnect at a time
      await disconnectRecorded(connectionId);
    }
    // One drain starts all three, and spends nothing on the Brain: the
    // clock's runs alone erase them.
    const drain = erasuresCounted();
    await drainAuditOutboxes(drain.env);
    const drainSpent = drain.count();
    // A run may spend 5 calls, where the clock's may spend
    // `brainCallsPerTick`: twelve records take three runs at least.
    const perRun = 5;
    const spent: number[] = [];
    const events = await auditedDuring(async () => {
      for (let run = 0; run < 5; run += 1) {
        const counted = erasuresCounted();
        // oxlint-disable-next-line no-await-in-loop -- one run at a time
        await completeOwedErasures(counted.env, { left: perRun });
        spent.push(counted.count());
      }
    });

    expect({
      drainSpent,
      records: records.length,
      overBudget: spent.filter((calls) => calls > perRun),
      spent: spent.reduce((sum, calls) => sum + calls, 0),
      keys: new Set(await Promise.all(records.map(keyState))),
      ended: connections.map(({ connectionId }) =>
        about(events, "brain.shared_reads.erased", connectionId)
      ),
    }).toStrictEqual({
      drainSpent: 0,
      records: 12,
      overBudget: [],
      // Each record once.
      spent: 12,
      keys: new Set(["erased"]),
      ended: connections.map(() => [
        { actor: { type: "system" }, detail: { sources: 4 } },
      ]),
    });
  });

  it("leaves no audience when an erase starts between an audience change's read and its write", async () => {
    const { admin, member, team, connectionId } = await sharedWithTeam();
    const marker = uniqueWord();
    await kept(connectionId, "deal", `Deal ${marker}`);
    // Hidden and kept: nobody reads it.
    await admin.api.connections.setBrainAudience(connectionId, {
      kind: "nobody",
    });
    const other = await signedInApi(idp, "admin");
    // The first admin reads that it may be opened; before they write,
    // the other admin's erase starts.
    const racing: Env = {
      ...env,
      DB: afterFirstRead(
        env.DB,
        'select "erasing", "closed" from "connection_brain_erasures"',
        async () => {
          await other.api.connections.eraseBrainReads(connectionId);
        }
      ),
    };
    const identity = await admin.api.whoami();
    const opened = await outcome(
      setConnectionAudience(racing, identity, connectionId, {
        kind: "team",
        teamId: team,
      })
    );
    const audiences = await admin.api.connections.brainAudiences();

    expect({
      opened,
      audiences: audiences.filter((each) => each.connectionId === connectionId),
      found: await finds(member, marker),
    }).toStrictEqual({
      opened: "connection.brain_erasing",
      // Being erased, with no audience.
      audiences: [
        {
          connectionId,
          audience: { kind: "nobody" },
          erasing: true,
          changedBy: null,
          changedAt: null,
        },
      ],
      found: false,
    });
  });

  it("is closed for good by a disconnect that lands between an audience change's check and its write", async () => {
    const { admin, connectionId } = await sharedWithTeam();
    await admin.api.connections.setBrainAudience(connectionId, {
      kind: "nobody",
    });
    // Connect says the connection is connected; then, before the write,
    // it is disconnected and the disconnect's erasure starts.
    const racing: Env = {
      ...env,
      DB: afterFirstRead(
        env.DB,
        'select "erasing", "closed" from "connection_brain_erasures"',
        async () => {
          await connectDb()
            .prepare(
              "UPDATE connections SET status = 'disconnected' WHERE id = ?"
            )
            .bind(connectionId)
            .run();
          await eraseSharedReadsOfDisconnect(env, {
            connectionId,
            request: crypto.randomUUID(),
            actor: { type: "system" },
            at: new Date(),
          });
          // Its erasure may even have ended before the write lands.
          await erasuresEnded();
        }
      ),
    };
    const identity = await admin.api.whoami();
    const opened = await outcome(
      setConnectionAudience(racing, identity, connectionId, {
        kind: "everyone",
      })
    );
    const audiences = await admin.api.connections.brainAudiences();

    expect({
      opened,
      audiences: audiences.filter((each) => each.connectionId === connectionId),
      // Nothing is kept under it from then on.
      claimed: await kept(connectionId, "late", "Late deal"),
    }).toStrictEqual({
      opened: "connection.invalid",
      audiences: [],
      claimed: "not claimed",
    });
  });

  it("holds a disconnect whose erasure could not start, and starts it at the next drain", async () => {
    const { connectionId } = await sharedWithTeam();
    const record = await kept(connectionId, "deal", "Deal");
    const source: SourceRef =
      typeof record === "string" ? { producer: "connected", id: "" } : record;
    const disconnect = await disconnectRecorded(connectionId);
    const leftInConnect = async () =>
      await connectDb()
        .prepare("SELECT count(*) AS left FROM audit_outbox WHERE id = ?")
        .bind(disconnect)
        .first<{ left: number }>();
    // Core's database refuses the erasure's start.
    await drainAuditOutboxes({
      ...env,
      DB: refusingWrites(env.DB, 'insert into "connection_brain_erasures"'),
    });
    const held = await leftInConnect();
    await drainAuditOutboxes(env);
    await erasuresEnded();

    expect({
      held,
      after: await leftInConnect(),
      key: await keyState(source),
    }).toStrictEqual({
      held: { left: 1 },
      after: { left: 0 },
      key: "erased",
    });
  });

  it("never starts an erasure again for a disconnect drained again after it ended", async () => {
    const { connectionId } = await sharedWithTeam();
    await kept(connectionId, "deal", "Deal");
    const request = crypto.randomUUID();
    const disconnect = {
      connectionId,
      request,
      actor: { type: "system" } as const,
      at: new Date(),
    };
    await eraseSharedReadsOfDisconnect(env, disconnect);
    await erasuresEnded();
    const row = async () =>
      await env.DB.prepare(
        "SELECT generation, erasing, erased FROM connection_brain_erasures WHERE connection_id = ?"
      )
        .bind(connectionId)
        .first<{ generation: number; erasing: number; erased: number }>();
    const ended = await row();
    // Connect's event drained again, as after a lost settle.
    await eraseSharedReadsOfDisconnect(env, disconnect);

    expect({ ended, again: await row() }).toStrictEqual({
      ended: { generation: 1, erasing: 0, erased: 1 },
      again: { generation: 1, erasing: 0, erased: 1 },
    });
  });

  it("keeps a record only under a key the Brain takes: a connection's ID past the bound is refused", async () => {
    const admin = await signedInApi(idp, "admin");
    const longest = `c${"x".repeat(169)}`;
    const now = Date.now();
    await connectDb()
      .prepare(
        "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, created_at, updated_at) VALUES (?, 'hubspot', 'shared', NULL, 'active', 'composio', 'hubspot', ?, ?)"
      )
      .bind(longest, now, now)
      .run();
    await admin.api.connections.setBrainAudience(longest, {
      kind: "everyone",
    });

    const longestKept = await kept(longest, "deal", "Deal");
    const tooLong = await outcome(
      claimSharedRead(env, `${longest}x`, await hashOf("deal"), new Date())
    );

    expect({
      // 170 characters, the most: its key fits the Brain's own bound.
      longest: typeof longestKept,
      tooLong: tooLong.includes("too_big"),
    }).toStrictEqual({ longest: "object", tooLong: true });
  });

  it("charges a failing erasure only the calls it made, so erasures that keep failing never starve a newer one", async () => {
    const failing = await Promise.all(
      ["a", "b", "c", "d"].map(async () => await sharedWithTeam())
    );
    for (const { connectionId } of failing) {
      // More than a round of calls (8) each: a page of them is charged
      // in full when nothing but a whole page is.
      for (let deal = 0; deal < 12; deal += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one record at a time
        await kept(connectionId, `deal ${deal}`, `Deal ${deal}`);
      }
      // oxlint-disable-next-line no-await-in-loop -- oldest first
      await disconnectRecorded(connectionId);
      // oxlint-disable-next-line no-await-in-loop -- oldest first
      await drainAuditOutboxes(env);
    }
    const newer = await sharedWithTeam();
    const record = await kept(newer.connectionId, "deal", "Deal");
    const source: SourceRef =
      typeof record === "string" ? { producer: "connected", id: "" } : record;
    await disconnectRecorded(newer.connectionId);
    await drainAuditOutboxes(env);
    // The four older ones' Brain is out of reach; a run may spend 40
    // calls. Each fails at its first round of 8, so 8 are left for the
    // newer one; charged a page each (12, 12, 12, 4) they would take all.
    const failingIds = new Set(failing.map(({ connectionId }) => connectionId));
    const out = erasuresFailingFor((key) =>
      failingIds.has(key.slice("connected:".length).split("/")[0] ?? "")
    );
    await completeOwedErasures(out, { left: 40 });

    await expect(keyState(source)).resolves.toBe("erased");
  });

  it("tells admins which connections are being erased, with no audience, until the clock has ended it", async () => {
    const { admin, connectionId } = await sharedWithTeam();
    await kept(connectionId, "deal", "Deal");
    const listedFor = async () => {
      const audiences = await admin.api.connections.brainAudiences();
      return audiences.filter((each) => each.connectionId === connectionId);
    };
    await admin.api.connections.eraseBrainReads(connectionId);
    const whileErasing = await listedFor();
    await erasuresEnded();

    expect({ whileErasing, ended: await listedFor() }).toStrictEqual({
      whileErasing: [
        {
          connectionId,
          audience: { kind: "nobody" },
          erasing: true,
          changedBy: null,
          changedAt: null,
        },
      ],
      ended: [],
    });
  });

  it("fails a disconnect whose close in the Brain failed, and closes it when disconnected again", async () => {
    const { admin, member, connectionId } = await sharedWithTeam();
    const marker = uniqueWord();
    await kept(connectionId, "deal", `Deal ${marker}`);
    // Core's database refuses the close.
    const failing = new ConnectionsRpc(
      {
        ...env,
        DB: refusingWrites(env.DB, 'insert into "connection_brain_erasures"'),
      },
      async () => await admin.api.whoami()
    );
    const first = await outcome(failing.disconnect(connectionId));
    const again = await outcome(admin.api.connections.disconnect(connectionId));

    expect({
      failed: first !== "ok",
      again,
      found: await finds(member, marker),
      claimed: await kept(connectionId, "late", `Late ${marker}`),
    }).toStrictEqual({
      failed: true,
      again: "ok",
      found: false,
      claimed: "not claimed",
    });
  });

  it("is erased after a disconnect through core, its drain and the clock, recorded once with its count", async () => {
    const { admin, member, connectionId } = await sharedWithTeam();
    const marker = uniqueWord();
    await kept(connectionId, "deal 1", `Deal one ${marker}`);
    await kept(connectionId, "deal 2", `Deal two ${marker}`);
    const events = await auditedDuring(async () => {
      await admin.api.connections.disconnect(connectionId);
      await drainAuditOutboxes(env);
      await erasuresEnded();
    });

    expect({
      found: await finds(member, marker),
      ended: about(events, "brain.shared_reads.erased", connectionId),
    }).toStrictEqual({
      found: false,
      ended: [
        {
          actor: { type: "person", userId: admin.userId },
          detail: { sources: 2 },
        },
      ],
    });
  });

  it("is erased by the company's admins alone, on a shared connection, and never touches a person's own captures", async () => {
    const [admin, member, { userId: owner }] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
      signedInWithRole(idp, "user"),
    ]);
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const staffRpc = await openRpc(staffSession);
    const staff = staffRpc.core.authenticate();
    const [shared, personal] = await Promise.all([
      connection(),
      connection(owner),
    ]);
    // A person's own capture through their own connection (lane 1).
    const marker = uniqueWord();
    const own: SourceRef = {
      producer: "capture",
      id: `${personal}/${await hashOf("own")}`,
    };
    await addSource(env, {
      source: own,
      change: crypto.randomUUID(),
      text: `Own deal ${marker}`,
      readers: { kind: "owner", personId: owner },
      group: { producer: "capture", id: personal },
    });
    expect({
      member: await erase(member.api, shared),
      staff: await erase(staff, shared),
      personal: await erase(admin.api, personal),
      unknown: await erase(admin.api, `connection-${unique()}`),
      shared: await erase(admin.api, shared),
      ownStillFound: await (async () => {
        await erasuresEnded();
        const { items } = await recallAs(env, owner, {
          personal: true,
          question: marker,
          budget: { tokens: recallBudgetMax },
        });
        return items.some(({ source }) => source.id === own.id);
      })(),
    }).toStrictEqual({
      member: "role.forbidden",
      staff: "role.forbidden",
      personal: "connection.invalid",
      unknown: "connection.invalid",
      shared: "ok",
      ownStillFound: true,
    });
  });
});
