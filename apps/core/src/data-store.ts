import type { AuditActor } from "@grasp-os/shared/audit";
import type { StoreId } from "@grasp-os/shared/ids";
import type { ReadScope } from "@grasp-os/shared/store-queries";
import type { ReadRequest } from "@grasp-os/shared/store-reads";
import type {
  ClaimInput,
  Commit,
  DefinedTables,
  SchemaConsumer,
  StagedWrites,
  StoredRecord,
} from "@grasp-os/shared/stores";
import { DurableObject } from "cloudflare:workers";

import migrations from "./db/data-store/migrations/migrations.js";
import { migrateOnWake } from "./db/migrate.ts";
import { outboxConsumers } from "./outbox-delivery.ts";
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
} from "./store-host.ts";

// A business store: one Durable Object per store, named by the store's ID
// (data-stores.ts), with a SQLite database of its own. What it does, and
// its threat model, is in its host (store-host.ts); this is its RPC
// surface, which only core reaches.

/**
 * A business store's Durable Object: the store's host (`StoreHost`) with
 * the deployment's outbox consumers and the real clock. Its methods are
 * the store's RPC surface, and take nothing a caller could choose to bend
 * time or delivery with.
 */
export class DataStore extends DurableObject<Env> {
  readonly #host: StoreHost;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateOnWake(ctx, migrations);
    this.#host = new StoreHost(ctx, env);
    // A commit whose object died before it set the alarm left its outbox
    // without one: set it again on every wake-up.
    void ctx.blockConcurrencyWhile(async () => {
      await this.#host.schedule();
    });
  }

  /** `StoreHost.defineTables`. */
  async defineTables(
    storeId: StoreId,
    manifest: string,
    consumer?: SchemaConsumer
  ): Promise<DefinedTables> {
    return await this.#host.defineTables(storeId, manifest, consumer);
  }

  /** `StoreHost.fillMissing`: one batch of the pending target's backfill. */
  fillMissing(storeId: StoreId, step: BackfillStep): BackfillOutcome {
    return this.#host.fillMissing(storeId, step);
  }

  /** `StoreHost.restartBackfill`. */
  async restartBackfill(
    storeId: StoreId,
    restart: BackfillRestart
  ): Promise<number> {
    return await this.#host.restartBackfill(storeId, restart);
  }

  /** `StoreHost.backfillStatus`. */
  backfillStatus(storeId: StoreId): BackfillStatus | null {
    return this.#host.backfillStatus(storeId);
  }

  /** `StoreHost.retryBackfill`. */
  async retryBackfill(
    storeId: StoreId,
    target: string
  ): Promise<BackfillStatus | null> {
    return await this.#host.retryBackfill(storeId, target);
  }

  /** `StoreHost.schemaStatus`. */
  schemaStatus(
    storeId: StoreId,
    schemaHash: string,
    consumer?: SchemaConsumer
  ): SchemaStatus {
    return this.#host.schemaStatus(storeId, schemaHash, consumer);
  }

  /** `StoreHost.abandonBackfill`. */
  async abandonBackfill(
    storeId: StoreId,
    abandon: BackfillAbandon,
    actor: AuditActor
  ): Promise<BackfillAbandonment> {
    return await this.#host.abandonBackfill(storeId, abandon, actor);
  }

  /** `StoreHost.markAbandonmentAudited`. */
  markAbandonmentAudited(
    storeId: StoreId,
    target: string,
    attempt: number
  ): void {
    this.#host.markAbandonmentAudited(storeId, target, attempt);
  }

  /** `StoreHost.get`. */
  get(storeId: StoreId, table: string, id: string): StoredRecord | null {
    return this.#host.get(storeId, table, id);
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
      await this.#host.read(storeId, scope, request, staged)
    );
  }

  /** `StoreHost.generations`. */
  generations(storeId: StoreId, names: string[]): Record<string, number> {
    return this.#host.generations(storeId, names);
  }

  /**
   * `StoreHost.claim`, as the JSON text of its `Claimed`: an outcome
   * carries what its mutation returned, JSON, which RPC types can't carry
   * deeply (`openStore` parses it).
   */
  async claim(input: ClaimInput): Promise<string> {
    return JSON.stringify(await this.#host.claim(input));
  }

  /** `StoreHost.close`. */
  async close(storeId: StoreId, actor: AuditActor): Promise<StoreDeletionMark> {
    return await this.#host.close(storeId, actor);
  }

  /**
   * `StoreHost.commit`, with the deployment's outbox consumers, as the
   * JSON text of its `Committed`, as for `claim`.
   */
  async commit(input: Commit): Promise<string> {
    return JSON.stringify(await this.#host.commit(input, outboxConsumers));
  }

  /**
   * Discards a fixture store an App's tests ran on (app-tests.ts):
   * everything the object holds, and its alarm. Refused for any store
   * core's inventory lists, whatever asks: a business store is only ever
   * deleted through its deletion (store-deletion.ts), audited and kept
   * until nothing refers to it. A fixture store never is listed, so this
   * can only ever empty one.
   */
  async discardFixture(storeId: StoreId): Promise<void> {
    if (this.ctx.id.name !== undefined && this.ctx.id.name !== storeId) {
      throw new Error("That isn't this object's store.");
    }
    const listed = await this.env.DB.prepare(
      "SELECT 1 FROM business_stores WHERE id = ?"
    )
      .bind(storeId)
      .first();
    if (listed !== null) {
      throw new Error("A listed store is deleted, never discarded.");
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** `StoreHost.runAlarm`, with the deployment's outbox consumers. */
  override async alarm(): Promise<void> {
    await this.#host.runAlarm(outboxConsumers);
  }
}
