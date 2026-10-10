import { sha256Hex } from "@grasp-os/shared/encoding";
import type {
  ClaimInput,
  Commit,
  Committed,
  Held,
} from "@grasp-os/shared/stores";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { createStore, openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { defaultMaxAttempts } from "../src/outbox-delivery.ts";
import type {
  OutboxConsumer,
  OutboxConsumers,
  OutboxEntry,
} from "../src/outbox-delivery.ts";

// A business store's receipts and outbox (data-store.ts), from the threat
// model in its header: what a mutation's attempts rely on to commit once,
// never late or stale, and to tell others what they committed exactly
// once. Each test makes stores of its own.

const dayMs = 24 * 60 * 60 * 1000;
const schemaHash = "a".repeat(64);

const scope = {
  principal: "ada",
  resource: "notes-app",
  binding: "NOTES",
  contractId: "notes.create",
  contractVersion: 1,
  operationKind: "mutation",
} as const;

/** A new store with a `notes` table. */
const newStore = async (): Promise<OpenStore> => {
  const store = await openStore(env, await createStore(env, "ada"));
  await store.defineTables(["notes"]);
  return store;
};

const objectOf = (store: OpenStore) => env.DATA_STORES.getByName(store.id);

/** The hash of `input`, as the caller hashes a mutation's normalized input. */
const hashOf = async (input: unknown): Promise<string> =>
  await sha256Hex(JSON.stringify(input));

/** A claim under `key`, for input `input`, of a call ending in a minute. */
const claimOf = async (
  key: string,
  input: unknown,
  more: Partial<Omit<ClaimInput, "storeId">> = {}
): Promise<Omit<ClaimInput, "storeId">> => ({
  scope,
  key: ["call", key],
  inputHash: await hashOf(input),
  runId: null,
  deadline: Date.now() + 60_000,
  ...more,
});

/** The receipt a claim must have taken. */
const heldBy = (claimed: { held: Held } | { outcome: Committed }): Held => {
  if (!("held" in claimed)) {
    throw new Error("The mutation had committed already");
  }
  return claimed.held;
};

/** A commit inserting one note titled `title`, under `receipt`. */
const insertOf = (
  receipt: Held,
  title: string,
  more: Partial<Omit<Commit, "storeId">> = {}
): Omit<Commit, "storeId"> => ({
  principal: { userId: "ada" },
  schemaHash,
  receipt,
  writes: [{ op: "insert", table: "notes", fields: { title } }],
  ...more,
});

/** The store's rows of one internal table. */
const rowsOf = async (
  store: OpenStore,
  table: "sdk_records" | "sdk_change_outbox" | "sdk_mutation_receipts"
): Promise<Record<string, unknown>[]> =>
  await runInDurableObject(objectOf(store), (_instance, state) =>
    state.storage.sql.exec(`SELECT * FROM ${table} ORDER BY rowid`).toArray()
  );

/** A consumer that takes every entry, and keeps what it took. */
const taker =
  (taken: OutboxEntry[]): OutboxConsumer =>
  async (entry) => {
    taken.push(entry);
    return await Promise.resolve("delivered");
  };

/** A consumer that never takes an entry. */
const refusing: OutboxConsumer = async () => {
  await Promise.resolve();
  throw new Error("Down");
};

/** Commits `commit` with `consumers` taking its intents, inside the object. */
const commitWith = async (
  store: OpenStore,
  commit: Omit<Commit, "storeId">,
  consumers: OutboxConsumers
): Promise<Committed> =>
  await runInDurableObject(
    objectOf(store),
    async (instance) =>
      await instance.commit({ ...commit, storeId: store.id }, consumers)
  );

describe("receipts", () => {
  it("commit once: a retry answers the outcome, and other input under the key is refused", async () => {
    const store = await newStore();
    const input = { title: "Launch" };
    const held = heldBy(await store.claim(await claimOf("k1", input)));
    const committed = await store.commit(insertOf(held, "Launch"));

    // The answer was lost; the caller retries under the same key.
    const retried = await store.claim(await claimOf("k1", input));
    expect(retried).toMatchObject({ outcome: committed });
    await expect(
      store.claim(await claimOf("k1", { title: "Other" }))
    ).rejects.toMatchObject({ code: "submission.key_conflict" });
    await expect(rowsOf(store, "sdk_records")).resolves.toHaveLength(1);
  });

  it("refuse other input under a key before its mutation commits too", async () => {
    const store = await newStore();
    await store.claim(await claimOf("k1", { title: "Launch" }));
    await expect(
      store.claim(await claimOf("k1", { title: "Other" }))
    ).rejects.toMatchObject({ code: "submission.key_conflict" });
  });

  it("don't cross callers, resources, bindings or contracts: the same key elsewhere is another receipt", async () => {
    const store = await newStore();
    const input = { title: "Launch" };
    const held = heldBy(await store.claim(await claimOf("k1", input)));
    await store.commit(insertOf(held, "Launch"));

    const elsewhere = await Promise.all(
      [
        { ...scope, principal: "grace" },
        { ...scope, resource: "crm-app" },
        { ...scope, binding: null },
        { ...scope, contractVersion: 2 },
      ].map(
        async (other) =>
          await store.claim(await claimOf("k1", input, { scope: other }))
      )
    );
    expect(elsewhere.every((claimed) => "held" in claimed)).toBeTruthy();
  });

  it("never let a commit use a receipt its principal didn't claim", async () => {
    const store = await newStore();
    const held = heldBy(
      await store.claim(
        await claimOf("k1", {}, { scope: { ...scope, principal: "grace" } })
      )
    );
    await expect(store.commit(insertOf(held, "Taken"))).rejects.toThrow(
      "A commit names a receipt its principal never claimed"
    );
    await expect(rowsOf(store, "sdk_records")).resolves.toHaveLength(0);
  });

  it("don't commit an attempt a newer one took over, and answer it with the newer one's outcome", async () => {
    const store = await newStore();
    const input = { title: "Launch" };
    const stale = heldBy(await store.claim(await claimOf("k1", input)));
    const fresh = heldBy(await store.claim(await claimOf("k1", input)));
    expect(fresh.fence).toBeGreaterThan(stale.fence);

    await expect(store.commit(insertOf(stale, "Launch"))).rejects.toMatchObject(
      {
        code: "submission.superseded",
      }
    );
    const committed = await store.commit(insertOf(fresh, "Launch"));
    // The stale attempt, retried, gets what the newer one committed.
    await expect(
      store.commit(insertOf(stale, "Launch"))
    ).resolves.toMatchObject(committed);
    await expect(rowsOf(store, "sdk_records")).resolves.toHaveLength(1);
  });

  it("don't commit once the call's deadline passed, and let the next attempt commit once", async () => {
    const store = await newStore();
    const input = { title: "Launch" };
    const late = heldBy(
      await store.claim(
        await claimOf("k1", input, { deadline: Date.now() - 1 })
      )
    );
    await expect(store.commit(insertOf(late, "Launch"))).rejects.toMatchObject({
      code: "submission.deadline_passed",
    });
    await expect(rowsOf(store, "sdk_records")).resolves.toHaveLength(0);

    const next = heldBy(await store.claim(await claimOf("k1", input)));
    await store.commit(insertOf(next, "Launch"));
    await expect(rowsOf(store, "sdk_records")).resolves.toHaveLength(1);
  });

  it("write nothing for an attempt killed after its claim, and commit its retry once", async () => {
    const store = await newStore();
    const input = { title: "Launch" };
    await store.claim(await claimOf("k1", input));
    // The attempt's isolate dies before it commits.
    await runInDurableObject(objectOf(store), (_instance, state) => {
      state.abort("killed");
    }).catch(() => {});

    const reopened = await openStore(env, store.id);
    const retry = heldBy(await reopened.claim(await claimOf("k1", input)));
    const committed = await reopened.commit(insertOf(retry, "Launch"));
    await expect(
      reopened.claim(await claimOf("k1", input))
    ).resolves.toMatchObject({
      outcome: committed,
    });
    await expect(rowsOf(reopened, "sdk_records")).resolves.toHaveLength(1);
  });

  it("keep a conflicted commit's receipt open, so the retry runs again", async () => {
    const store = await newStore();
    const setup = heldBy(await store.claim(await claimOf("setup", {})));
    const {
      inserted: [id = ""],
    } = await store.commit(insertOf(setup, "Draft"));
    const edit = heldBy(await store.claim(await claimOf("edit", { id })));
    await expect(
      store.commit({
        principal: { userId: "ada" },
        schemaHash,
        receipt: edit,
        writes: [
          {
            op: "patch",
            table: "notes",
            id,
            fields: { title: "X" },
            expectedRevision: 2,
          },
        ],
      })
    ).rejects.toMatchObject({ code: "data.conflict" });

    const again = await store.claim(await claimOf("edit", { id }));
    expect(again).toMatchObject({ held: { fence: edit.fence + 1 } });
  });

  it("commit a no-op's receipt, and still refuse it once what it read moved on", async () => {
    const store = await newStore();
    const setup = heldBy(await store.claim(await claimOf("setup", {})));
    const {
      inserted: [id = ""],
    } = await store.commit(insertOf(setup, "Rate"));
    const check = async (key: string) =>
      await store.commit({
        principal: { userId: "ada" },
        schemaHash,
        receipt: heldBy(await store.claim(await claimOf(key, { id }))),
        guards: [{ table: "notes", id, expectedRevision: 1 }],
        writes: [],
      });

    const noop = await check("noop");
    await expect(
      store.claim(await claimOf("noop", { id }))
    ).resolves.toMatchObject({
      outcome: noop,
    });
    const bump = heldBy(await store.claim(await claimOf("bump", {})));
    await store.commit({
      principal: { userId: "ada" },
      schemaHash,
      receipt: bump,
      writes: [
        {
          op: "patch",
          table: "notes",
          id,
          fields: { title: "New" },
          expectedRevision: 1,
        },
      ],
    });
    await expect(check("stale")).rejects.toMatchObject({
      code: "data.conflict",
    });
  });

  it("order commits, and give each outcome its place", async () => {
    const store = await newStore();
    const first = await store.commit(
      insertOf(heldBy(await store.claim(await claimOf("a", {}))), "A")
    );
    const second = await store.commit(
      insertOf(heldBy(await store.claim(await claimOf("b", {}))), "B")
    );
    expect(second.commit).toBe(first.commit + 1);
  });
});

describe("retention", () => {
  /** Sweeps `store`'s receipts as at `days` from now. */
  const sweep = async (store: OpenStore, days: number) => {
    await runInDurableObject(objectOf(store), async (instance) => {
      await instance.sweepReceipts(new Date(Date.now() + days * dayMs));
    });
  };

  it("keep receipts their retention, then refuse their key as expired until the tombstone goes", async () => {
    const store = await newStore();
    const input = { title: "Launch" };
    await store.commit(
      insertOf(heldBy(await store.claim(await claimOf("k1", input))), "Launch")
    );

    await sweep(store, 29);
    await expect(
      store.claim(await claimOf("k1", input))
    ).resolves.toHaveProperty("outcome");
    // A retry within the retention extended nothing past the commit's.
    await sweep(store, 31);
    await expect(store.claim(await claimOf("k1", input))).rejects.toMatchObject(
      {
        code: "submission.expired",
      }
    );
    await sweep(store, 62);
    // Past every trace of the key, it is a new one.
    await expect(
      store.claim(await claimOf("k1", input))
    ).resolves.toHaveProperty("held");
  });

  it("keep a live run's receipts past their retention, without stalling the others", async () => {
    const store = await newStore();
    const appId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'Runner', '', 'ada', ?)"
      ).bind(appId, Date.now()),
      env.DB.prepare(
        "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at) VALUES (?, ?, 'saver', 1, 'ada', 'running', ?)"
      ).bind(runId, appId, Date.now()),
    ]);
    const input = { title: "Step" };
    await store.commit(
      insertOf(
        heldBy(await store.claim(await claimOf("step", input, { runId }))),
        "Step"
      )
    );
    await store.commit(
      insertOf(heldBy(await store.claim(await claimOf("call", input))), "Call")
    );

    await sweep(store, 31);
    await expect(
      store.claim(await claimOf("step", input, { runId }))
    ).resolves.toHaveProperty("outcome");
    await expect(
      store.claim(await claimOf("call", input))
    ).rejects.toMatchObject({
      code: "submission.expired",
    });
  });

  it("keep a receipt while its outbox owes an entry", async () => {
    const store = await newStore();
    const input = { title: "Launch" };
    const held = heldBy(await store.claim(await claimOf("k1", input)));
    await commitWith(
      store,
      insertOf(held, "Launch", {
        intents: [{ kind: "workflow.start", data: { run: "r1" } }],
      }),
      { "workflow.start": taker([]) }
    );
    await sweep(store, 31);
    await expect(
      store.claim(await claimOf("k1", input))
    ).resolves.toHaveProperty("outcome");
  });

  it("set the alarm once a receipt is kept", async () => {
    const store = await newStore();
    await store.claim(await claimOf("k1", {}));
    const alarm = await runInDurableObject(
      objectOf(store),
      async (_instance, state) => await state.storage.getAlarm()
    );
    expect(alarm).toBeGreaterThan(Date.now() + 29 * dayMs);
  });
});

describe("outbox", () => {
  it("commits entries with the records and the receipt, once, and nothing with a failed commit", async () => {
    const store = await newStore();
    const consumers = { "workflow.start": taker([]) };
    const held = heldBy(await store.claim(await claimOf("k1", {})));
    await commitWith(
      store,
      insertOf(held, "Launch", {
        intents: [
          { kind: "workflow.start", data: { run: "r1" } },
          { kind: "workflow.start", data: { run: "r2" } },
        ],
      }),
      consumers
    );
    // A retry of the committed mutation stages nothing more.
    await commitWith(store, insertOf(held, "Launch"), consumers);

    const failing = heldBy(await store.claim(await claimOf("k2", {})));
    await expect(
      commitWith(
        store,
        insertOf(failing, "Lost", {
          intents: [{ kind: "workflow.start", data: { run: "r3" } }],
          guards: [{ table: "notes", id: "gone", expectedRevision: 1 }],
        }),
        consumers
      )
    ).rejects.toMatchObject({ code: "data.conflict" });

    const entries = await rowsOf(store, "sdk_change_outbox");
    expect(entries.map(({ id }) => id)).toStrictEqual([
      `${held.receiptId}:0`,
      `${held.receiptId}:1`,
    ]);
    await expect(rowsOf(store, "sdk_records")).resolves.toHaveLength(1);
  });

  it("refuses an intent nothing takes before anything is written", async () => {
    const store = await newStore();
    const held = heldBy(await store.claim(await claimOf("k1", {})));
    await expect(
      store.commit(
        insertOf(held, "Launch", {
          intents: [{ kind: "workflow.notify", data: {} }],
        })
      )
    ).rejects.toMatchObject({ code: "submission.intent_unsupported" });
    await expect(rowsOf(store, "sdk_records")).resolves.toHaveLength(0);
    await expect(rowsOf(store, "sdk_change_outbox")).resolves.toHaveLength(0);
  });

  it("answers a committed mutation's retry, though its intent's consumer has gone since", async () => {
    const store = await newStore();
    const input = { title: "Launch" };
    const held = heldBy(await store.claim(await claimOf("k1", input)));
    const committed = await commitWith(
      store,
      insertOf(held, "Launch", {
        intents: [{ kind: "workflow.start", data: {} }],
      }),
      { "workflow.start": taker([]) }
    );
    // Nothing in this deployment takes starts now.
    await expect(
      store.claim(await claimOf("k1", input))
    ).resolves.toMatchObject({
      outcome: committed,
    });
    await expect(store.commit(insertOf(held, "Launch"))).resolves.toMatchObject(
      committed
    );
  });

  it("hands entries over until taken, under the same ID, without committing again", async () => {
    const store = await newStore();
    const held = heldBy(await store.claim(await claimOf("k1", {})));
    await commitWith(
      store,
      insertOf(held, "Launch", {
        intents: [{ kind: "workflow.start", data: { run: "r1" } }],
      }),
      { "workflow.start": taker([]) }
    );
    const seen: string[] = [];
    let fail = true;
    const flaky: OutboxConsumer = async ({ id }) => {
      seen.push(id);
      if (fail) {
        throw new Error("Not now");
      }
      return await Promise.resolve("delivered");
    };
    const drain = async (at: number) => {
      await runInDurableObject(objectOf(store), async (instance) => {
        await instance.drainOutbox(
          { "workflow.start": flaky },
          { now: new Date(at) }
        );
      });
    };

    await drain(Date.now());
    // Not handed over again before its backoff.
    await drain(Date.now());
    fail = false;
    await drain(Date.now() + dayMs);
    await drain(Date.now() + 2 * dayMs);

    expect(seen).toStrictEqual([`${held.receiptId}:0`, `${held.receiptId}:0`]);
    const [entry] = await rowsOf(store, "sdk_change_outbox");
    expect(entry).toMatchObject({ attempts: 1, undeliverable: null });
    expect(entry?.settled_at).not.toBeNull();
    await expect(rowsOf(store, "sdk_records")).resolves.toHaveLength(1);
  });

  it("hands each entry over once to drains running at once", async () => {
    const store = await newStore();
    const held = heldBy(await store.claim(await claimOf("k1", {})));
    await commitWith(
      store,
      insertOf(held, "Launch", {
        intents: [
          { kind: "workflow.start", data: { run: "r1" } },
          { kind: "workflow.start", data: { run: "r2" } },
        ],
      }),
      { "workflow.start": taker([]) }
    );
    const taken: string[] = [];
    const slow: OutboxConsumer = async ({ id }) => {
      taken.push(id);
      await scheduler.wait(20);
      return "delivered";
    };
    await runInDurableObject(objectOf(store), async (instance) => {
      await Promise.all([
        instance.drainOutbox({ "workflow.start": slow }),
        instance.drainOutbox({ "workflow.start": slow }),
      ]);
    });
    expect(taken.toSorted()).toStrictEqual([
      `${held.receiptId}:0`,
      `${held.receiptId}:1`,
    ]);
  });

  it("settles an entry undeliverable only after its attempts, never dropping it", async () => {
    const store = await newStore();
    const held = heldBy(await store.claim(await claimOf("k1", {})));
    await commitWith(
      store,
      insertOf(held, "Launch", {
        intents: [{ kind: "workflow.start", data: {} }],
      }),
      { "workflow.start": taker([]) }
    );
    await runInDurableObject(objectOf(store), async (instance) => {
      for (let attempt = 0; attempt < defaultMaxAttempts; attempt += 1) {
        // One drain after the other, each past the last one's backoff.
        // oxlint-disable-next-line no-await-in-loop -- see above
        await instance.drainOutbox(
          { "workflow.start": refusing },
          { now: new Date(Date.now() + attempt * 2 * 60 * 60 * 1000) }
        );
      }
    });
    const [entry] = await rowsOf(store, "sdk_change_outbox");
    expect(entry).toMatchObject({
      attempts: defaultMaxAttempts,
      undeliverable: "outbox.attempts_exhausted",
    });
  });
});
