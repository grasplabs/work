import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import type { Id } from "@grasp-os/sdk";
import { manifestText, schemaManifest } from "@grasp-os/sdk/host";
import { documentMaxBytes } from "@grasp-os/shared/stores";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

import { backfillBatchSize } from "../src/store-host.ts";
import {
  codeOf,
  commit,
  consumer,
  contractHash,
  fill,
  fillAll,
  insertAll,
  newStore,
  noteFields,
  notes,
  notesOf,
  objectOf,
  pendingStore,
  retry,
  titled,
  statusOf,
  v1,
  withCategory,
} from "./pending-stores.ts";
import { newRecordId } from "./store-schemas.ts";

// A defaulted field added to a table that holds records (spec 17.1, 17.2,
// 17.4 steps 4 to 6): the store takes the schema as its pending target,
// keeps its contract as it was, and moves the contract only once a
// bounded backfill has filled the field in everywhere; meanwhile every
// commit fills in what it writes. Through the store's own way in
// (data-stores.ts) and its Durable Object, as core's backfill workflow
// drives it. What can go wrong, and the test that shows it doesn't:
//
// - The contract takes the field while a record still lacks it: "keeps
//   the contract until the last batch".
// - A value already there is overwritten, or an invalid one papered over:
//   "keeps a valid value" and "fails on an invalid value".
// - A writer pinned to the old schema creates a record without the field
//   behind the cursor, or a concurrent edit is lost to the fill: "fills
//   in what concurrent commits write".
// - A lost answer, a crash between batches, or two runs at once fill
//   twice, skip records, or move on from a stale run: "resumes".
// - Another schema change slips in while one is pending: "takes only
//   what the pending target holds".

describe("a defaulted field added to a table with records", () => {
  it("keeps the contract until the last batch, then activates it", async () => {
    const { store, first, second } = await pendingStore(
      backfillBatchSize * 2 + 1
    );

    expect(second.contract).toMatchObject({ changed: true, pending: true });
    await expect(contractHash(store)).resolves.toBe(first.schemaHash);
    await expect(statusOf(store, withCategory)).resolves.toMatchObject({
      state: "pending",
      scanned: 0,
    });
    await expect(statusOf(store, v1)).resolves.toStrictEqual({
      state: "active",
    });

    const outcomes = await fillAll(store, second.contract.hash);
    const statuses = outcomes.map(({ state, scanned, filled }) => ({
      state,
      scanned,
      filled,
    }));
    const records = await notesOf(store);
    const again = await store.defineTables(withCategory, consumer(2));

    expect({
      statuses,
      contract: await contractHash(store),
      status: await statusOf(store, withCategory),
      categories: new Set(
        [...records.values()].map(({ fields }) => fields.category)
      ),
      revisions: new Set([...records.values()].map(({ revision }) => revision)),
      receipt: again.contract,
    }).toStrictEqual({
      statuses: [
        { state: "running", scanned: 100, filled: 100 },
        { state: "running", scanned: 200, filled: 200 },
        { state: "complete", scanned: 201, filled: 201 },
      ],
      contract: second.contract.hash,
      status: { state: "active" },
      categories: new Set(["general"]),
      revisions: new Set([2]),
      receipt: { ...second.contract, pending: false },
    });
  });

  it("keeps a valid value a record already holds", async () => {
    const { store, second, ids } = await pendingStore(2, [
      { title: "Kept", category: "news" },
    ]);
    const kept = ids.at(-1) ?? "";
    const before = await notesOf(store);

    await fillAll(store, second.contract.hash);

    const after = await notesOf(store);
    expect(after.get(kept)).toStrictEqual(before.get(kept));
  });

  it("fails on an invalid value, overwriting nothing, and the contract stays", async () => {
    const { store, first, second, ids } = await pendingStore(3, [
      { title: "Odd", category: 42 },
    ]);
    const odd = ids.at(-1) ?? "";
    const before = await notesOf(store);

    const outcomes = await fillAll(store, second.contract.hash);

    const after = await notesOf(store);
    const status = await statusOf(store, withCategory);
    expect({
      last: outcomes.at(-1)?.state,
      failure: outcomes.at(-1)?.failure,
      record: after.get(odd),
      contract: await contractHash(store),
      status: status.state,
      another: await codeOf(
        store.defineTables(
          notes({
            ...noteFields,
            category: v.string().max(20).default("general"),
            archived: v.boolean().optional(),
          }),
          consumer(3)
        )
      ),
      rollback: await codeOf(store.defineTables(v1, consumer(4))),
      // Even a schema the failed target holds: its release couldn't run.
      same: await codeOf(store.defineTables(withCategory, consumer(5))),
      // Nothing changed the record: a retry leaves it failed.
      retried: await retry(store, second.contract.hash).then(
        (retried) => retried?.state
      ),
    }).toStrictEqual({
      last: "failed",
      failure: {
        table: "notes",
        field: "category",
        id: odd,
        reason: "invalid_value",
      },
      record: before.get(odd),
      contract: first.schemaHash,
      status: "failed",
      another: "migration.backfill_failed",
      rollback: "ok",
      same: "migration.backfill_failed",
      retried: "failed",
    });
  });

  it("retries a failure once its record changed, from that record on", async () => {
    // A note whose document fits only without the default.
    const big = { title: "x".repeat(documentMaxBytes - 22) };
    const { store, first, second, ids } = await pendingStore(3, [big]);
    const target = second.contract.hash;
    const large = ids.at(-1) ?? "";
    const failed = await fillAll(store, target);
    // The current version shrinks it; its commit fills the default in.
    await commit(store, first.schemaHash, [
      {
        op: "patch",
        table: "notes",
        id: large,
        expectedRevision: 1,
        fields: { title: "Shrunk" },
      },
    ]);

    const retried = await retry(store, target);
    const rest = await fillAll(store, target, { attempt: retried?.attempt });
    const records = await notesOf(store);

    expect({
      failure: failed.at(-1)?.failure,
      retried: [retried?.state, retried?.attempt],
      rest: rest.at(-1)?.state,
      contract: await contractHash(store),
      large: records.get(large)?.fields,
    }).toStrictEqual({
      failure: {
        table: "notes",
        field: "category",
        id: large,
        reason: "too_large",
      },
      retried: ["running", 2],
      rest: "complete",
      contract: target,
      large: { title: "Shrunk", category: "general" },
    });
  });

  it("scans only the records the table held when the target became pending", async () => {
    const { store, first, second } = await pendingStore(5);
    // Written after: their commits fill the default in.
    await insertAll(store, first.schemaHash, titled(backfillBatchSize));

    const outcomes = await fillAll(store, second.contract.hash);

    expect(
      outcomes.map(({ state, scanned, filled }) => ({ state, scanned, filled }))
    ).toStrictEqual([{ state: "complete", scanned: 5, filled: 5 }]);
  });

  it("refuses to fill in a contract the store's row doesn't hold", async () => {
    const store = await newStore();
    const first = await store.defineTables(v1, consumer(1));
    await insertAll(store, first.schemaHash, titled(1));
    await runInDurableObject(objectOf(store), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE sdk_store SET contract_hash = NULL, contract_manifest = NULL"
      );
    });

    await expect(
      codeOf(store.defineTables(withCategory, consumer(2)))
    ).resolves.toBe("migration.metadata_missing");
  });

  it("applies at once when the table holds no records", async () => {
    const store = await newStore();
    await store.defineTables(v1, consumer(1));

    const second = await store.defineTables(withCategory, consumer(2));

    expect(second.contract).toMatchObject({ changed: true, pending: false });
    await expect(contractHash(store)).resolves.toBe(second.contract.hash);
    await expect(statusOf(store, withCategory)).resolves.toStrictEqual({
      state: "active",
    });
  });
});

describe("while a backfill runs", () => {
  it("fills in what concurrent commits write, whatever schema they are pinned to", async () => {
    const { store, first, second, ids } = await pendingStore(
      backfillBatchSize + 10
    );
    // The first record and the last in the order the backfill scans.
    const scanOrder = ids.toSorted();
    const [early = "", late = ""] = [scanOrder[0], scanOrder.at(-1)];
    const before = await notesOf(store);
    await fill(store, second.contract.hash, 1);
    // A record the first batch filled, as a writer read it before.
    const filledFirst = await notesOf(store);

    const [inserted] = await insertAll(store, first.schemaHash, [
      { title: "Behind the cursor" },
    ]);
    await commit(store, first.schemaHash, [
      {
        op: "patch",
        table: "notes",
        id: late,
        expectedRevision: 1,
        fields: { title: "Edited before its batch" },
      },
    ]);
    const lostEdit = await codeOf(
      commit(store, first.schemaHash, [
        {
          op: "patch",
          table: "notes",
          id: early,
          expectedRevision: 1,
          fields: { title: "From a stale read" },
        },
      ])
    );
    await fillAll(store, second.contract.hash, { from: 2 });
    const records = await notesOf(store);

    expect({
      stale: filledFirst.get(early)?.revision,
      lostEdit,
      early: records.get(early)?.fields,
      inserted: records.get(inserted ?? "")?.fields,
      late: records.get(late),
    }).toStrictEqual({
      stale: 2,
      lostEdit: "data.conflict",
      early: { ...before.get(early)?.fields, category: "general" },
      inserted: { title: "Behind the cursor", category: "general" },
      // Filled in by its commit, so its batch found it complete.
      late: {
        fields: { title: "Edited before its batch", category: "general" },
        revision: 2,
      },
    });
  });

  it("refuses a write its default would make too large, naming the field", async () => {
    const { store, first } = await pendingStore(1);

    const refused = commit(store, first.schemaHash, [
      {
        op: "insert",
        table: "notes",
        id: newRecordId(),
        fields: { title: "x".repeat(documentMaxBytes - 22) },
      },
    ]);

    await expect(refused).rejects.toMatchObject({
      code: "data.invalid",
      details: { issues: [expect.stringContaining("category")] },
    });
  });

  it("takes only what the pending target holds", async () => {
    const { store, second } = await pendingStore(1);
    const optional = notes({
      ...noteFields,
      category: v.string().max(20).default("general"),
      archived: v.boolean().optional(),
    });

    const same = await store.defineTables(withCategory, consumer(3));
    const older = await store.defineTables(v1, consumer(4));
    const further = await codeOf(store.defineTables(optional, consumer(5)));

    expect({
      same: [same.contract.hash, same.contract.pending],
      older: [older.contract.changed, older.contract.pending],
      further,
    }).toStrictEqual({
      same: [second.contract.hash, true],
      older: [false, false],
      further: "migration.pending",
    });
  });
});

describe("a backfill's run", () => {
  it("resumes after a lost answer, a restart of the store, and a new run, filling each record once", async () => {
    const { store, second } = await pendingStore(backfillBatchSize * 2 + 5);
    const target = second.contract.hash;

    const first = await fill(store, target, 1);
    // The same batch again, its answer lost: the same outcome, nothing more.
    const retried = await fill(store, target, 1);
    const skipped = await codeOf(fill(store, target, 3));
    // The store's object restarts, as a deploy does.
    await runInDurableObject(objectOf(store), (_instance, state) => {
      state.abort("Restarted by the test");
    }).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });
    const second2 = await fill(store, target, 2);
    // A new run takes over only once the old one's lease ran out.
    const early = await codeOf(
      objectOf(store).restartBackfill(store.id, { target, attempt: 1 })
    );
    await runInDurableObject(objectOf(store), (_instance, state) => {
      state.storage.sql.exec("UPDATE sdk_schema_backfills SET lease_until = 0");
    });
    const attempt = await objectOf(store).restartBackfill(store.id, {
      target,
      attempt: 1,
    });
    const stale = await codeOf(fill(store, target, 3, 1));
    const rest = await fillAll(store, target, { attempt });
    const records = await notesOf(store);
    const after = await fill(store, target, 9, 1);

    expect({
      first: first.scanned,
      retried,
      skipped,
      second: second2.scanned,
      early,
      attempt,
      stale,
      rest: rest.map(({ state, scanned, filled }) => ({
        state,
        scanned,
        filled,
      })),
      revisions: new Set([...records.values()].map(({ revision }) => revision)),
      contract: await contractHash(store),
      after: after.state,
    }).toStrictEqual({
      first: 100,
      retried: first,
      skipped: "migration.superseded",
      second: 200,
      early: "migration.busy",
      attempt: 2,
      stale: "migration.superseded",
      rest: [{ state: "complete", scanned: 205, filled: 205 }],
      revisions: new Set([2]),
      contract: target,
      after: "complete",
    });
  });
});

describe("a backfill that can't move on", () => {
  it("fails as stalled after hand-overs that move nothing on, and runs again only when retried", async () => {
    const { store, second } = await pendingStore(3);
    const target = second.contract.hash;

    const attempts: number[] = [];
    let attempt = 1;
    for (let handOver = 0; handOver < 5; handOver += 1) {
      // One hand-over after the other, as runs end one after the other.
      // oxlint-disable-next-line no-await-in-loop -- see above
      attempt = await objectOf(store).restartBackfill(store.id, {
        target,
        attempt,
      });
      attempts.push(attempt);
    }
    const stalled = await objectOf(store).backfillStatus(store.id);
    const retried = await retry(store, target);
    const rest = await fillAll(store, target, { attempt: retried?.attempt });

    expect({
      attempts,
      stalled: [stalled?.state, stalled?.failure],
      retried: [retried?.state, retried?.attempt],
      rest: rest.at(-1)?.state,
    }).toStrictEqual({
      attempts: [2, 3, 4, 4, 4],
      stalled: ["failed", { reason: "stalled" }],
      retried: ["running", 5],
      rest: "complete",
    });
  });
});

/** A tag's ID as a schema's default holds it. */
const tagId = (id: string): Id<"tags"> =>
  // SAFETY: a test's ID; the store decides what, if anything, it names.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  id as Id<"tags">;

/** Tags read and written by their owner; notes whose tag defaults to `tag`. */
const tagged = (tag: string, withTag: boolean): string =>
  manifestText(
    schemaManifest(
      defineSchema({
        notes: defineTable(
          withTag
            ? { ...noteFields, tag: v.id("tags").default(tagId(tag)) }
            : noteFields
        ),
        tags: defineTable({ name: v.string() }),
      }),
      {
        tables: {
          notes: { read: "appMembers", write: "appMembers" },
          tags: { read: "owner", write: "owner" },
        },
      }
    )
  );

describe("a retained defaulted reference", () => {
  it("is filled in, needing its record to exist but not to be readable by the writer", async () => {
    const tag = newRecordId();
    const store = await newStore();
    const first = await store.defineTables(tagged(tag, true), consumer(1));
    // A later version leaves the field out: the store keeps filling it in.
    const later = await store.defineTables(tagged(tag, false), consumer(2));
    await commit(
      store,
      first.schemaHash,
      [{ op: "insert", table: "tags", id: tag, fields: { name: "Bob's" } }],
      "bob"
    );

    const [note] = await insertAll(store, later.schemaHash, [
      { title: "Tagged" },
    ]);
    const records = await notesOf(store);
    // The default's record is referred to now: it can't be deleted.
    const deleted = await codeOf(
      commit(
        store,
        first.schemaHash,
        [{ op: "delete", table: "tags", id: tag, expectedRevision: 1 }],
        "bob"
      )
    );

    const missing = await newStore();
    const absent = newRecordId();
    await missing.defineTables(tagged(absent, true), consumer(1));
    const missingLater = await missing.defineTables(
      tagged(absent, false),
      consumer(2)
    );
    const refused = await codeOf(
      insertAll(missing, missingLater.schemaHash, [{ title: "Untagged" }])
    );

    expect({
      note: records.get(note ?? "")?.fields,
      deleted,
      refused,
    }).toStrictEqual({
      note: { title: "Tagged", tag },
      deleted: "data.referenced",
      refused: "data.reference_invalid",
    });
  });
});

describe("an older release", () => {
  it("stays in force across index changes, a pending target and a completed backfill", async () => {
    const indexed = manifestText(
      schemaManifest(
        defineSchema({
          notes: defineTable(noteFields).index("by_title", ["title"]),
        }),
        { tables: { notes: { read: "appMembers", write: "appMembers" } } }
      )
    );
    const store = await newStore();
    const first = await store.defineTables(v1, consumer(1));
    await insertAll(store, first.schemaHash, titled(3));
    await store.defineTables(indexed, consumer(2));
    const pending = await store.defineTables(withCategory, consumer(3));

    // Sealed again while the target is pending: in force, not waiting.
    const resealed = await store.defineTables(v1, consumer(4));
    const states = async (...schemas: string[]) =>
      await Promise.all(
        schemas.map(async (schema) => {
          const status = await statusOf(store, schema);
          return status.state;
        })
      );
    const whilePending = {
      states: await states(v1, indexed),
      resealed: resealed.contract.pending,
    };
    await fillAll(store, pending.contract.hash);

    expect({
      whilePending,
      after: await states(v1, indexed, withCategory),
    }).toStrictEqual({
      whilePending: { states: ["active", "active"], resealed: false },
      after: ["active", "active", "active"],
    });
  });
});
