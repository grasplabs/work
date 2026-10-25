import type { CommandReceipt } from "@grasp-os/brain/contract";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  receiptRetentionMs,
  receiptsSweptPerStatement,
  rememberPerWindow,
} from "../src/knowledge/memories.ts";
import { release } from "./apps.ts";
import { runQuarterHourCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// The Brain's memory commands (GRA-297), as a signed-in person calls them
// through Knowledge's RPC. How they can fail, and what holds each:
// 1. A retry after a lost reply makes a second record, or a reused key
//    with another request overwrites the first: the key answers one
//    recorded result, and a different request conflicts.
// 2. Two calls with the same key race: one record, one receipt.
// 3. One person reads or replays another's: keys, receipts and records
//    are the caller's own, and anyone else's answer `brain.not_found`; a
//    request's hash says nothing across people.
// 4. A remember is stored without its audit event, or its receipt
//    without its record: all three commit together or not at all.
// 5. A memory cites what its author can't read (an App's entry in the
//    Apps collection included, for one who may not open the App), or a
//    section its version doesn't have, so a later reader learns it
//    exists: such a reference refuses the whole command.
// 6. Forged fields (an actor, a scope) or a revision on a new record pass.
// 7. An expired receipt keeps its key forever, or is still served; or
//    receipts pile up past their retention.
// 8. Listing is unbounded or leaks across people: pages are bounded and
//    the cursor is the person's own walk, which no one else can follow.
// 9. A runaway caller fills the store: a person's remembers are bounded.

const idp = mockIdp();

/** Signing in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const key = () => `remember-${unique()}-${unique()}`;

const committed = (receipt: CommandReceipt) => ({
  status: receipt.status,
  indexingState: receipt.indexingState,
  refs: receipt.resourceRefs.map((ref) => ref.kind),
});

/** A lesson citing one document version. */
/** A field no caller may set, sent anyway. */
const forgedScope = { kind: "fact" as const, text: "x", scope: "company" };

/** The receipts table's name for `userId`'s commands. */
const callerOf = (userId: string) => JSON.stringify(["person", userId]);

/**
 * Plants `rows` receipts of `caller`'s, made at `createdAt` and kept
 * until `retentionUntil`, as a runaway caller would leave them.
 */
const plantReceipts = async (
  caller: string,
  rows: number,
  createdAt: number,
  retentionUntil: number
): Promise<void> => {
  await env.KNOWLEDGE.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
     INSERT INTO brain_receipts
       (id, key_hash, caller, operation, request_hash, status,
        indexing_state, resource_refs, created_at, retention_until)
     SELECT ?2 || i, ?2 || i, ?3, 'remember', 'x', 'committed',
       'pending', '[]', ?4, ?5
     FROM n`
  )
    .bind(rows, `planted-${unique()}-`, caller, createdAt, retentionUntil)
    .run();
};

/** How many receipts `caller` has. */
const receiptsOf = async (caller: string): Promise<number> => {
  const row = await env.KNOWLEDGE.prepare(
    "SELECT COUNT(*) AS count FROM brain_receipts WHERE caller = ?"
  )
    .bind(caller)
    .first<{ count: number }>();
  return row?.count ?? 0;
};

const citing = (documentId: string, collectionId: string, version: number) => ({
  kind: "lesson" as const,
  text: "Quiet work goes on floor 3.",
  sourceRefs: [
    { kind: "document" as const, documentId, collectionId, version },
  ],
});

describe("the Brain's memory commands", setUpTime, () => {
  it("remember once per key: a retry answers the same receipt, another request conflicts", async () => {
    const person = await signedInApi(idp, "user");
    const brain = person.api.knowledge;
    const idempotencyKey = key();
    const input = {
      kind: "preference" as const,
      text: "I prefer short answers.",
    };
    const first = await brain.remember(input, { idempotencyKey });
    // The reply is lost: the same call again, and the receipt read back.
    const retried = await brain.remember(input, { idempotencyKey });
    const recovered = await brain.receiptsGet({ receiptId: first.id });
    const changed = await outcome(
      brain.remember(
        { kind: "preference", text: "I prefer long answers." },
        { idempotencyKey }
      )
    );
    const [ref] = first.resourceRefs;
    if (ref?.kind !== "memory") {
      throw new Error("No memory committed");
    }
    const record = await brain.memoriesGet({ memoryId: ref.memoryId });
    const listed = await brain.memoriesList();
    expect({
      first: committed(first),
      retried: retried.id === first.id,
      recovered,
      changed,
      record: {
        statement: record.statement,
        kind: record.kind,
        scope: record.scope,
        state: record.state,
        revision: record.revision,
      },
      listed: listed.records.map(({ id }) => id),
    }).toStrictEqual({
      first: {
        status: "committed",
        indexingState: "pending",
        refs: ["memory"],
      },
      retried: true,
      recovered: first,
      changed: "brain.idempotency_conflict",
      // Proposed: something to remember, never an accepted fact.
      record: {
        statement: "I prefer short answers.",
        kind: "preference",
        scope: "person",
        state: "proposed",
        revision: 1,
      },
      listed: [ref.memoryId],
    });
  });

  it("keep one record when the same key races", async () => {
    const person = await signedInApi(idp, "user");
    const brain = person.api.knowledge;
    const idempotencyKey = key();
    const input = { kind: "fact" as const, text: "My desk is on floor 3." };
    const receipts = await Promise.all(
      Array.from({ length: 4 }, async () => {
        try {
          return await brain.remember(input, { idempotencyKey });
        } catch (error) {
          return String(error);
        }
      })
    );
    const listed = await brain.memoriesList();
    const ids = new Set(
      receipts.map((receipt) =>
        typeof receipt === "string" ? receipt : receipt.id
      )
    );
    expect({ ids: ids.size, records: listed.records.length }).toStrictEqual({
      ids: 1,
      records: 1,
    });
  });

  it("keep keys, receipts and records each person's own", async () => {
    const one = await signedInApi(idp, "user");
    const other = await signedInApi(idp, "admin");
    const idempotencyKey = key();
    const mine = await one.api.knowledge.remember(
      { kind: "fact", text: "I work in Utrecht." },
      { idempotencyKey }
    );
    // The same key is another command for someone else: no conflict.
    const theirs = await other.api.knowledge.remember(
      { kind: "fact", text: "I work in Delft." },
      { idempotencyKey }
    );
    // The same request by someone else hashes apart.
    const same = await other.api.knowledge.remember(
      { kind: "fact", text: "I work in Utrecht." },
      { idempotencyKey: key() }
    );
    const [ref] = mine.resourceRefs;
    if (ref?.kind !== "memory") {
      throw new Error("No memory committed");
    }
    const othersList = await other.api.knowledge.memoriesList();
    expect({
      theirs: theirs.status,
      distinct: theirs.id !== mine.id,
      hashedApart: same.requestHash !== mine.requestHash,
      // An admin is no exception: a person's records are theirs.
      receipt: await outcome(
        other.api.knowledge.receiptsGet({ receiptId: mine.id })
      ),
      record: await outcome(
        other.api.knowledge.memoriesGet({ memoryId: ref.memoryId })
      ),
      listed: othersList.records.map(({ statement }) => statement),
    }).toStrictEqual({
      theirs: "committed",
      distinct: true,
      hashedApart: true,
      receipt: "brain.not_found",
      record: "brain.not_found",
      listed: ["I work in Utrecht.", "I work in Delft."],
    });
  });

  it("keep a remember's receipt and record only with its audit event", async () => {
    const person = await signedInApi(idp, "user");
    const brain = person.api.knowledge;
    const idempotencyKey = key();
    const input = { kind: "fact" as const, text: "I keep my bike inside." };
    // The event's write fails, as if core stopped right after the receipt.
    const database: D1Database = env.KNOWLEDGE;
    const prepare = database.prepare.bind(database);
    const failing = vi
      .spyOn(database, "prepare")
      .mockImplementation((query: string) => {
        if (query.includes("audit_outbox")) {
          throw new Error("Knowledge's database is down for a moment");
        }
        return prepare(query);
      });
    let interrupted = "";
    try {
      interrupted = await outcome(brain.remember(input, { idempotencyKey }));
    } finally {
      failing.mockRestore();
    }
    const left = await receiptsOf(callerOf(person.userId));
    const records = await brain.memoriesList();
    let retried: CommandReceipt | undefined;
    const events = await auditedDuring(async () => {
      retried = await brain.remember(input, { idempotencyKey });
    });
    const [ref] = retried?.resourceRefs ?? [];
    expect({
      interrupted: interrupted === "ok",
      left,
      records: records.records.length,
      retried: retried?.status,
      events: events
        .filter(
          ({ target }) => ref?.kind === "memory" && target?.id === ref.memoryId
        )
        .map(({ action }) => action),
    }).toStrictEqual({
      interrupted: false,
      left: 0,
      records: 0,
      retried: "committed",
      events: ["knowledge.memory.remember"],
    });
  });

  it("cite only document versions the person may read, and refuse forged fields", async () => {
    const author = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const open = await author.api.knowledge.createCollection({
      name: `Open ${unique()}`,
      access: "everyone",
    });
    const closed = await author.api.knowledge.createCollection({
      name: `Closed ${unique()}`,
      access: "me",
    });
    const openDocument = await author.api.knowledge.saveDocument({
      collectionId: open.id,
      path: "desks.md",
      text: "# Desks\nFloor 3 is quiet.",
      ifVersion: 0,
    });
    const closedDocument = await author.api.knowledge.saveDocument({
      collectionId: closed.id,
      path: "plans.md",
      text: "# Plans\nA reorganisation.",
      ifVersion: 0,
    });
    // Version 2 has three sections where version 1 had one.
    await author.api.knowledge.saveDocument({
      collectionId: open.id,
      path: "desks.md",
      text: "# Desks\nFloor 3 is quiet.\n\n# Lockers\nBy the lift.\n\n# Bikes\nIn the basement.",
      ifVersion: 1,
    });
    const brain = person.api.knowledge;
    const cited = await brain.remember(citing(openDocument.id, open.id, 1), {
      idempotencyKey: key(),
    });
    const section = (version: number, at: number) => {
      const input = citing(openDocument.id, open.id, version);
      return {
        ...input,
        sourceRefs: input.sourceRefs.map((ref) => ({ ...ref, section: at })),
      };
    };
    expect({
      cited: cited.status,
      unreadable: await outcome(
        brain.remember(citing(closedDocument.id, closed.id, 1), {
          idempotencyKey: key(),
        })
      ),
      noSuchVersion: await outcome(
        brain.remember(citing(openDocument.id, open.id, 3), {
          idempotencyKey: key(),
        })
      ),
      wrongCollection: await outcome(
        brain.remember(citing(closedDocument.id, open.id, 1), {
          idempotencyKey: key(),
        })
      ),
      // An earlier version's section, though only the current one's are
      // stored; and one that version doesn't have.
      oldSection: await outcome(
        brain.remember(section(1, 0), { idempotencyKey: key() })
      ),
      noOldSection: await outcome(
        brain.remember(section(1, 1), { idempotencyKey: key() })
      ),
      currentSection: await outcome(
        brain.remember(section(2, 2), { idempotencyKey: key() })
      ),
      noSection: await outcome(
        brain.remember(section(2, 3), { idempotencyKey: key() })
      ),
      forgedScope: await outcome(
        brain.remember(forgedScope, { idempotencyKey: key() })
      ),
      withRevision: await outcome(
        brain.remember(
          { kind: "fact", text: "x" },
          { idempotencyKey: key(), expectedRevision: 1 }
        )
      ),
      shortKey: await outcome(
        brain.remember({ kind: "fact", text: "x" }, { idempotencyKey: "k" })
      ),
    }).toStrictEqual({
      cited: "committed",
      unreadable: "brain.not_found",
      noSuchVersion: "brain.not_found",
      wrongCollection: "brain.not_found",
      oldSection: "ok",
      noOldSection: "brain.not_found",
      currentSection: "ok",
      noSection: "brain.not_found",
      forgedScope: "brain.invalid",
      withRevision: "brain.invalid",
      shortKey: "brain.invalid",
    });
  });

  it("cite an App's entry only for those who may open the App", async () => {
    const owner = await signedInApi(idp, "builder");
    const person = await signedInApi(idp, "user");
    const { id: app } = await owner.api.apps.create({
      name: `Leave ${unique()}`,
      description: "Leave requests, from request to approval.",
    });
    await release(owner, app, { "AGENTS.md": "# Leave\nAsk your lead.\n" });
    const { documents } = await owner.api.knowledge.listDocuments("apps");
    const entry = documents.find(({ path }) => path === `${app}/AGENTS.md`);
    if (entry === undefined) {
      throw new Error(`App ${app} has no entry`);
    }
    const cite = async (by: typeof owner) =>
      await outcome(
        by.api.knowledge.remember(citing(entry.id, "apps", 1), {
          idempotencyKey: key(),
        })
      );
    // The collection is for everyone, but its entries are for those who
    // may open their App: the receipt mustn't say one exists.
    expect({
      owner: await cite(owner),
      person: await cite(person),
    }).toStrictEqual({
      owner: "ok",
      person: "brain.not_found",
    });
  });

  it("forget a key once its receipt expires, at its retention to the millisecond, and say the receipt expired", async () => {
    const person = await signedInApi(idp, "user");
    const brain = person.api.knowledge;
    const idempotencyKey = key();
    const input = { kind: "fact" as const, text: "I start at nine." };
    const first = await brain.remember(input, { idempotencyKey });
    // Now is the receipt's retention exactly: expired already.
    const now = Date.now() + 1000;
    await env.KNOWLEDGE.prepare(
      "UPDATE brain_receipts SET retention_until = ? WHERE id = ?"
    )
      .bind(now, first.id)
      .run();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    let expired = "";
    let again: CommandReceipt | undefined;
    try {
      expired = await outcome(brain.receiptsGet({ receiptId: first.id }));
      // A new command now, even with another request.
      again = await brain.remember(
        { kind: "fact", text: "I start at ten." },
        { idempotencyKey }
      );
    } finally {
      vi.useRealTimers();
    }
    const listed = await brain.memoriesList();
    expect({
      expired,
      again: again?.status,
      distinct: again?.id !== first.id,
      records: listed.records.length,
    }).toStrictEqual({
      expired: "brain.receipt_expired",
      again: "committed",
      distinct: true,
      records: 2,
    });
  });

  it("sweep receipts past their retention on the clock, and answer a swept one as never made", async () => {
    const person = await signedInApi(idp, "user");
    const brain = person.api.knowledge;
    const swept = await brain.remember(
      { kind: "fact", text: "I park at the back." },
      { idempotencyKey: key() }
    );
    const kept = await brain.remember(
      { kind: "fact", text: "I cycle in." },
      { idempotencyKey: key() }
    );
    // The clock, a retention on: one receipt expires at that very moment,
    // the other a millisecond after.
    const at = new Date(Date.now() + receiptRetentionMs + 60_000);
    await env.KNOWLEDGE.batch([
      env.KNOWLEDGE.prepare(
        "UPDATE brain_receipts SET retention_until = ? WHERE id = ?"
      ).bind(at.getTime(), swept.id),
      env.KNOWLEDGE.prepare(
        "UPDATE brain_receipts SET retention_until = ? WHERE id = ?"
      ).bind(at.getTime() + 1, kept.id),
    ]);
    // More expired receipts than one statement of the sweep deletes.
    const runaway = callerOf(`runaway-${unique()}`);
    await plantReceipts(
      runaway,
      receiptsSweptPerStatement + 5,
      Date.now(),
      at.getTime() - 1
    );
    await runQuarterHourCron({}, at);
    const runawayLeft = await receiptsOf(runaway);
    const stored = await env.KNOWLEDGE.prepare(
      "SELECT id FROM brain_receipts WHERE id IN (?, ?)"
    )
      .bind(swept.id, kept.id)
      .all<{ id: string }>();
    const stillKept = await brain.receiptsGet({ receiptId: kept.id });
    expect({
      runawayLeft,
      stored: stored.results.map(({ id }) => id),
      swept: await outcome(brain.receiptsGet({ receiptId: swept.id })),
      kept: stillKept.id,
    }).toStrictEqual({
      runawayLeft: 0,
      stored: [kept.id],
      swept: "brain.not_found",
      kept: kept.id,
    });
  });

  it("bound how much one person remembers in a day, still answering a retry", async () => {
    const person = await signedInApi(idp, "user");
    const other = await signedInApi(idp, "user");
    const brain = person.api.knowledge;
    const idempotencyKey = key();
    const input = { kind: "fact" as const, text: "I take the 8:12 train." };
    const first = await brain.remember(input, { idempotencyKey });
    // The rest of the day's remembers but one, as a runaway caller would
    // make them; then several at once, for the one place left.
    await plantReceipts(
      callerOf(person.userId),
      rememberPerWindow - 2,
      Date.now(),
      Date.now() + receiptRetentionMs
    );
    const together = await Promise.all(
      Array.from(
        { length: 5 },
        async (_, at) =>
          await outcome(
            brain.remember(
              { kind: "fact", text: `One more, ${at}.` },
              { idempotencyKey: key() }
            )
          )
      )
    );
    const over = await outcome(
      brain.remember(
        { kind: "fact", text: "One more." },
        { idempotencyKey: key() }
      )
    );
    const receipts = await receiptsOf(callerOf(person.userId));
    const records = await brain.memoriesList({ limit: 100 });
    const retry = await brain.remember(input, { idempotencyKey });
    // The bound is each person's own.
    const others = await other.api.knowledge.remember(input, {
      idempotencyKey: key(),
    });
    expect({
      together: together.toSorted(),
      over,
      receipts,
      records: records.records.length,
      retry: retry.id,
      others: others.status,
    }).toStrictEqual({
      // One place left: one of five in flight takes it.
      together: [
        "brain.budget_exceeded",
        "brain.budget_exceeded",
        "brain.budget_exceeded",
        "brain.budget_exceeded",
        "ok",
      ],
      over: "brain.budget_exceeded",
      receipts: rememberPerWindow,
      records: 2,
      retry: first.id,
      others: "committed",
    });
  });

  it("list the person's records a bounded page at a time, of one kind if asked", async () => {
    const person = await signedInApi(idp, "user");
    const other = await signedInApi(idp, "user");
    const brain = person.api.knowledge;
    for (const [kind, text] of [
      ["fact", "One."],
      ["fact", "Two."],
      ["lesson", "Three."],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- in order, newest last
      await brain.remember({ kind, text }, { idempotencyKey: key() });
    }
    const first = await brain.memoriesList({ limit: 2 });
    const second =
      first.cursor === null
        ? undefined
        : await brain.memoriesList({ limit: 2, cursor: first.cursor });
    const facts = await brain.memoriesList({ kind: "fact" });
    expect({
      pages: [
        first.records.map(({ statement }) => statement),
        second?.records.map(({ statement }) => statement),
      ],
      last: second?.cursor,
      facts: facts.records.map(({ statement }) => statement),
      forged: await outcome(brain.memoriesList({ cursor: "not-ours" })),
      // A cursor is the person's own: no one else walks on from it.
      foreign: await outcome(
        other.api.knowledge.memoriesList({ cursor: first.cursor ?? "" })
      ),
      // Nor through another kind of record than it was written for.
      otherKind: await outcome(
        brain.memoriesList({ kind: "fact", cursor: first.cursor ?? "" })
      ),
      tooMany: await outcome(brain.memoriesList({ limit: 101 })),
    }).toStrictEqual({
      pages: [["Three.", "Two."], ["One."]],
      last: null,
      facts: ["Two.", "One."],
      forged: "brain.invalid",
      foreign: "brain.invalid",
      otherKind: "brain.invalid",
      tooMany: "brain.invalid",
    });
  });
});
