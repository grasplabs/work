import type { AuditActor } from "@grasp-os/shared/audit";
import type { StoreId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { ReadScope } from "@grasp-os/shared/store-queries";
import type { ReadRequest } from "@grasp-os/shared/store-reads";
import type {
  ClaimInput,
  Commit,
  DefinedTables,
  SchemaConsumer,
  StagedWrites,
  StoredRecord,
  StoreMigration,
} from "@grasp-os/shared/stores";
import { DurableObject } from "cloudflare:workers";

import migrations from "./db/data-store/migrations/migrations.js";
import { migrateOnWake } from "./db/migrate.ts";
import { outboxConsumers } from "./outbox-delivery.ts";
import type { OutboxConsumers } from "./outbox-delivery.ts";
import type { StoreDeletionMark } from "./store-deletion.ts";
import { StoreHost } from "./store-host.ts";
import type {
  BackfillAbandon,
  BackfillAbandonment,
  BackfillOutcome,
  BackfillRestart,
  BackfillStatus,
  BackfillStep,
  SchemaStatus,
  TransformedBatch,
} from "./store-host.ts";
import { StoreWatches } from "./store-watches.ts";
import type { StoreWatcher } from "./store-watches.ts";

// A business store: one Durable Object per store, named by the store's ID
// (data-stores.ts), with a SQLite database of its own. What it does, and
// its threat model, is in its host (store-host.ts); this is its RPC
// surface, which only core reaches. It also keeps the live queries core
// follows of the store (store-watches.ts) and tells them of each commit
// from its outbox (`store.changed`): handed over as soon as the commit
// returns, and by the alarm whatever that missed, after a restart too.

/**
 * A business store's Durable Object: the store's host (`StoreHost`) with
 * the deployment's outbox consumers and the real clock. Its methods are
 * the store's RPC surface, and take nothing a caller could choose to bend
 * time or delivery with.
 */
/** The key a discarded fixture store keeps, alone (`discardFixture`). */
const discardedKey = "grasp_fixture_discarded";

export class DataStore extends DurableObject<Env> {
  readonly #host: StoreHost;
  readonly #watches = new StoreWatches();
  /**
   * The deployment's consumers, and the one only this object has: its
   * live queries, told of the tables each commit changed.
   */
  readonly #consumers: OutboxConsumers = {
    ...outboxConsumers,
    "store.changed": async ({ intent }) => {
      if (intent.kind === "store.changed") {
        this.#watches.changed(intent.tables);
      }
      return await Promise.resolve("delivered" as const);
    },
  };
  /** The hand-over under way after a commit, and whether another is owed. */
  #delivering: Promise<void> | undefined;
  #deliverAgain = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#host = new StoreHost(ctx, env);
    // A discarded fixture store wakes to nothing: no tables made again, no
    // alarm armed (`discardFixture`).
    if (this.#discarded()) {
      return;
    }
    migrateOnWake(ctx, migrations);
    // A commit whose object died before it set the alarm left its outbox
    // without one: set it again on every wake-up.
    void ctx.blockConcurrencyWhile(async () => {
      await this.#live().schedule();
    });
  }

  /** Whether this object is a fixture store that was discarded. */
  #discarded(): boolean {
    return this.ctx.storage.kv.get<true>(discardedKey) === true;
  }

  /**
   * The store's host, unless this object was discarded: then every call
   * is refused, a call that was already running when it was too, at its
   * next step.
   */
  #live(): StoreHost {
    if (this.#discarded()) {
      throw new Error("This fixture store was discarded.");
    }
    return this.#host;
  }

  /** `StoreHost.defineTables`. */
  async defineTables(
    storeId: StoreId,
    manifest: string,
    consumer?: SchemaConsumer,
    declared?: StoreMigration[]
  ): Promise<DefinedTables> {
    return await this.#live().defineTables(
      storeId,
      manifest,
      consumer,
      declared
    );
  }

  /**
   * `StoreHost.fillMissing`: one batch of the pending target's backfill,
   * as JSON text (a migration's batch carries records, which RPC types
   * can't carry deeply), read back with `backfillBatchSchema`.
   */
  fillMissing(storeId: StoreId, step: BackfillStep): string {
    return JSON.stringify(this.#live().fillMissing(storeId, step));
  }

  /**
   * `StoreHost.commitTransformed`: a migration's batch, transformed, as
   * JSON text (`TransformedBatch`).
   */
  commitTransformed(storeId: StoreId, batch: string): BackfillOutcome {
    const parsed: unknown = JSON.parse(batch);
    // SAFETY: the host parses it with its schema before anything reads it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return this.#live().commitTransformed(storeId, parsed as TransformedBatch);
  }

  /** `StoreHost.restartBackfill`. */
  async restartBackfill(
    storeId: StoreId,
    restart: BackfillRestart
  ): Promise<number> {
    return await this.#live().restartBackfill(storeId, restart);
  }

  /** `StoreHost.backfillStatus`. */
  backfillStatus(storeId: StoreId): BackfillStatus | null {
    return this.#live().backfillStatus(storeId);
  }

  /** `StoreHost.retryBackfill`. */
  async retryBackfill(
    storeId: StoreId,
    target: string
  ): Promise<BackfillStatus | null> {
    return await this.#live().retryBackfill(storeId, target);
  }

  /** `StoreHost.activateReady`. */
  activateReady(
    storeId: StoreId,
    schemaHash: string,
    consumer: SchemaConsumer
  ): SchemaStatus {
    return this.#live().activateReady(storeId, schemaHash, consumer);
  }

  /** `StoreHost.schemaStatus`. */
  schemaStatus(
    storeId: StoreId,
    schemaHash: string,
    consumer?: SchemaConsumer
  ): SchemaStatus {
    return this.#live().schemaStatus(storeId, schemaHash, consumer);
  }

  /** `StoreHost.compatibleVersions`. */
  compatibleVersions(
    storeId: StoreId,
    resourceId: string,
    candidates: readonly { resourceVersion: number; schemaHash: string }[]
  ): number[] {
    return this.#live().compatibleVersions(storeId, resourceId, candidates);
  }

  /** `StoreHost.abandonBackfill`. */
  async abandonBackfill(
    storeId: StoreId,
    abandon: BackfillAbandon,
    actor: AuditActor
  ): Promise<BackfillAbandonment> {
    return await this.#live().abandonBackfill(storeId, abandon, actor);
  }

  /** `StoreHost.markAbandonmentAudited`. */
  markAbandonmentAudited(
    storeId: StoreId,
    target: string,
    attempt: number
  ): void {
    this.#live().markAbandonmentAudited(storeId, target, attempt);
  }

  /** `StoreHost.get`. */
  get(storeId: StoreId, table: string, id: string): StoredRecord | null {
    return this.#live().get(storeId, table, id);
  }

  /**
   * `StoreHost.read`, as the JSON text of its `ReadResult`: RPC types
   * can't carry documents, which are JSON anyway (`openStore` parses it).
   */
  async read(
    storeId: StoreId,
    scope: ReadScope,
    request: ReadRequest,
    staged?: StagedWrites
  ): Promise<string> {
    return JSON.stringify(
      await this.#live().read(storeId, scope, request, staged)
    );
  }

  /** `StoreHost.generations`. */
  generations(storeId: StoreId, names: string[]): Record<string, number> {
    return this.#live().generations(storeId, names);
  }

  /**
   * `StoreHost.claim`, as the JSON text of its `Claimed`: an outcome
   * carries what its mutation returned, JSON, which RPC types can't carry
   * deeply (`openStore` parses it).
   */
  async claim(input: ClaimInput): Promise<string> {
    return JSON.stringify(await this.#live().claim(input));
  }

  /** `StoreHost.close`. */
  async close(storeId: StoreId, actor: AuditActor): Promise<StoreDeletionMark> {
    return await this.#live().close(storeId, actor);
  }

  /**
   * `StoreHost.commit`, with this object's outbox consumers, as the JSON
   * text of its `Committed`, as for `claim`. Its outbox is handed over
   * right after, so live queries hear of the commit without waiting for
   * the alarm, which hands over whatever this misses.
   */
  async commit(input: Commit): Promise<string> {
    const committed = await this.#live().commit(input, this.#consumers);
    this.#deliver();
    return JSON.stringify(committed);
  }

  /**
   * Hands the outbox over now, one hand-over at a time: a commit while
   * one runs has it go round once more after.
   */
  #deliver(): void {
    if (this.#delivering !== undefined) {
      this.#deliverAgain = true;
      return;
    }
    this.#delivering = (async () => {
      try {
        do {
          this.#deliverAgain = false;
          // oxlint-disable-next-line no-await-in-loop -- one hand-over after the other
          await this.#host.drainOutbox(this.#consumers);
        } while (this.#deliverAgain);
      } catch (error) {
        // The alarm hands it over later.
        log.warn("store.deliver_failed", errorFields(error));
      } finally {
        this.#delivering = undefined;
      }
    })();
  }

  /**
   * Keeps `watcher` for a live query of `principal`'s that read the
   * tables of `readSet` at those generations (`StoreWatches.watch`):
   * told of every commit that changes one of them, at once if one did
   * since. Answers the watch's ID.
   */
  async watch(
    storeId: StoreId,
    principal: string,
    readSet: Record<string, number>,
    watcher: StoreWatcher
  ): Promise<string> {
    const host = this.#live();
    return await this.#watches.watch(principal, readSet, watcher, () =>
      host.generations(storeId, Object.keys(readSet))
    );
  }

  /**
   * Moves watch `id` on to what its query read again
   * (`StoreWatches.rewatch`): false once this object no longer has it.
   */
  rewatch(
    storeId: StoreId,
    id: string,
    readSet: Record<string, number>
  ): boolean {
    const host = this.#live();
    return this.#watches.rewatch(id, readSet, () =>
      host.generations(storeId, Object.keys(readSet))
    );
  }

  /** Lets go of watch `id`. */
  unwatch(id: string): void {
    this.#watches.unwatch(id);
  }

  /**
   * Discards a fixture store an App's tests ran on (app-tests.ts):
   * everything the object holds, and its alarm, and marks it discarded,
   * so it refuses every call after (`#live`) and wakes to nothing. Only
   * for a store core recorded as a fixture (`app_test_fixtures`) and its
   * inventory doesn't list, whatever asks: a business store is only ever
   * deleted through its deletion (store-deletion.ts), audited and kept
   * until nothing refers to it. Both are read in one query, and nothing
   * is awaited between it and emptying the object.
   */
  async discardFixture(storeId: StoreId): Promise<void> {
    if (this.ctx.id.name !== undefined && this.ctx.id.name !== storeId) {
      throw new Error("That isn't this object's store.");
    }
    const found = await this.env.DB.prepare(
      "SELECT EXISTS (SELECT 1 FROM business_stores WHERE id = ?1) AS listed, EXISTS (SELECT 1 FROM app_test_fixtures WHERE store_id = ?1) AS fixture"
    )
      .bind(storeId)
      .first<{ listed: number; fixture: number }>();
    if (found?.listed !== 0) {
      throw new Error("A listed store is deleted, never discarded.");
    }
    if (found.fixture !== 1) {
      throw new Error("Only a fixture store core recorded is discarded.");
    }
    await this.ctx.storage.deleteAll();
    this.ctx.storage.kv.put(discardedKey, true);
    await this.ctx.storage.deleteAlarm();
  }

  /**
   * `StoreHost.runAlarm`, with this object's outbox consumers; nothing
   * for a discarded fixture store, which arms no alarm again.
   */
  override async alarm(): Promise<void> {
    if (this.#discarded()) {
      return;
    }
    await this.#live().runAlarm(this.#consumers);
  }
}
