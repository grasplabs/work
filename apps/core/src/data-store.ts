import type { UploadState } from "@grasp-os/shared/app-files";
import type { AuditActor } from "@grasp-os/shared/audit";
import type { StoreId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { ReadScope } from "@grasp-os/shared/store-queries";
import type { ReadRequest } from "@grasp-os/shared/store-reads";
import type {
  ClaimInput,
  Commit,
  StagedWrites,
  StoredRecord,
} from "@grasp-os/shared/stores";
import { dataErrors } from "@grasp-os/shared/stores";
import { DurableObject } from "cloudflare:workers";

import migrations from "./db/data-store/migrations/migrations.js";
import { migrateOnWake } from "./db/migrate.ts";
import type {
  ChunkRecord,
  FileContent,
  FileReader,
  Publishable,
} from "./file-host.ts";
import type { StoreDeletionMark } from "./store-deletion.ts";
import { StoreHost } from "./store-host.ts";
import type {
  AppliedSchema,
  ImportApply,
  ImportBatch,
  MigrationBatch,
  PreferencesReceipt,
  PreferencesWritten,
  SchemaApply,
  StoredPreferences,
  StoreReset,
  TableFacts,
} from "./store-host.ts";
import { storeOutboxConsumers } from "./store-outbox-consumers.ts";
import { StoreWatches } from "./store-watches.ts";
import type { StoreWatcher } from "./store-watches.ts";

// A business store: one Durable Object per store, named by the store's ID
// (data-stores.ts), with a SQLite database of its own. What it does, and
// its threat model, is in its host (store-host.ts); this is its RPC
// surface, which only core reaches. It also keeps the live queries core
// follows of the store (store-watches.ts), told of every write that moves
// a table's generation as soon as its transaction is over.

/**
 * A business store's Durable Object: the store's host (`StoreHost`) with
 * the deployment's outbox consumers and the real clock. Its methods are
 * the store's RPC surface, and take nothing a caller could choose to bend
 * time or delivery with.
 */
/** How often the alarm sweeps the watches of pages gone without a word. */
const watchSweepMs = 5 * 60 * 1000;

/** The key a discarded fixture store keeps, alone (`discardFixture`). */
const discardedKey = "grasp_fixture_discarded";

/** When a throwaway store empties itself, unless held again (`holdThrowaway`). */
const throwawayKey = "grasp_throwaway_until";

export class DataStore extends DurableObject<Env> {
  readonly #host: StoreHost;
  readonly #watches = new StoreWatches();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#host = new StoreHost(ctx, env);
    this.#host.onTablesMoved = (moved) => {
      this.#watches.changed(moved);
    };
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
      // Coded, so whoever ran on it (a preview) can tell it apart.
      throw dataErrors.create("data.fixture_discarded");
    }
    return this.#host;
  }

  /** `StoreHost.applySchema`; its fills' events handed to core. */
  async applySchema(
    storeId: StoreId,
    change: SchemaApply
  ): Promise<AppliedSchema> {
    const applied = await this.#live().applySchema(storeId, change);
    await this.#afterFiles();
    return applied;
  }

  /** `StoreHost.resetData`; its events handed to core. */
  async resetData(
    storeId: StoreId,
    reset: StoreReset
  ): Promise<AppliedSchema | null> {
    const applied = await this.#live().resetData(storeId, reset);
    await this.#afterFiles();
    return applied;
  }

  /** `StoreHost.beginMigration`. */
  beginMigration(storeId: StoreId): {
    migrationId: string;
    schemaHash: string | null;
  } {
    return this.#live().beginMigration(storeId);
  }

  /**
   * `StoreHost.migrationRows`, as JSON text: RPC types can't carry
   * documents, which are JSON anyway.
   */
  migrationRows(storeId: StoreId, table: string, after: string | null): string {
    return JSON.stringify(this.#live().migrationRows(storeId, table, after));
  }

  /** `StoreHost.stageMigration`, its batch as JSON text (`MigrationBatch`). */
  stageMigration(storeId: StoreId, batch: string): void {
    const parsed: unknown = JSON.parse(batch);
    // SAFETY: the host parses it with its schema before anything reads it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    this.#live().stageMigration(storeId, parsed as MigrationBatch);
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

  /**
   * `StoreHost.history`, as the JSON text of its page: a change's values
   * are JSON, which RPC types can't carry deeply (`openStore` parses it).
   */
  async history(
    storeId: StoreId,
    scope: ReadScope,
    table: string,
    id: string,
    before: number | null
  ): Promise<string> {
    return JSON.stringify(
      await this.#live().history(storeId, scope, table, id, before)
    );
  }

  /** `StoreHost.stageImport`. */
  async stageImport(storeId: StoreId, batch: ImportBatch): Promise<void> {
    await this.#live().stageImport(storeId, batch);
  }

  /** `StoreHost.tableFacts`. */
  tableFacts(storeId: StoreId): Record<string, TableFacts> {
    return this.#live().tableFacts(storeId);
  }

  /** `StoreHost.applyImport`. */
  async applyImport(
    storeId: StoreId,
    landing: ImportApply
  ): Promise<{ inserted: number }> {
    return await this.#live().applyImport(storeId, landing);
  }

  /** `StoreHost.generations`. */
  generations(storeId: StoreId, names: string[]): Record<string, number> {
    return this.#live().generations(storeId, names);
  }

  /** `StoreHost.readPreferences`. */
  readPreferences(
    storeId: StoreId,
    personId: string,
    preferencesText: string
  ): StoredPreferences {
    return this.#live().readPreferences(storeId, personId, preferencesText);
  }

  /** `StoreHost.forgetPerson`. */
  forgetPerson(storeId: StoreId, personId: string): { forgotten: number } {
    return this.#live().forgetPerson(storeId, personId);
  }

  /** `StoreHost.definePreferences`. */
  definePreferences(
    storeId: StoreId,
    preferencesText: string,
    apply: boolean
  ): { changed: boolean } {
    return this.#live().definePreferences(storeId, preferencesText, apply);
  }

  /** `StoreHost.writePreferences`. */
  writePreferences(
    storeId: StoreId,
    personId: string,
    expectedRevision: number,
    valueJson: string,
    receipt?: PreferencesReceipt
  ): PreferencesWritten {
    return this.#live().writePreferences(
      storeId,
      personId,
      expectedRevision,
      valueJson,
      receipt
    );
  }

  /**
   * `StoreHost.claim`, as the JSON text of its `Claimed`: an outcome
   * carries what its mutation returned, JSON, which RPC types can't carry
   * deeply (`openStore` parses it).
   */
  async claim(input: ClaimInput): Promise<string> {
    return JSON.stringify(await this.#live().claim(input));
  }

  /**
   * After a change that may have recorded audit events: the alarm
   * set for what is due, and the events handed to core now, as far as
   * they go (the alarm hands over whatever this doesn't).
   */
  async #afterFiles(): Promise<void> {
    const host = this.#live();
    await host.schedule();
    try {
      await host.files.flushEvents();
    } catch (error) {
      log.warn("app_file.events_deferred", errorFields(error));
    }
  }

  /** `FileHost.begin`; the upload's expiry gets the alarm. */
  async beginUpload(
    storeId: StoreId,
    principal: string,
    resource: string,
    input: unknown
  ): Promise<UploadState> {
    const host = this.#live();
    const state = host.files.begin(storeId, principal, resource, input);
    await host.schedule();
    return state;
  }

  /** `FileHost.status`. */
  uploadStatus(
    storeId: StoreId,
    principal: string,
    resource: string,
    fileId: string
  ): UploadState {
    return this.#live().files.status(storeId, principal, resource, fileId);
  }

  /** `FileHost.admitChunk`; its write's cleanup gets the alarm. */
  async admitChunk(
    storeId: StoreId,
    principal: string,
    resource: string,
    fileId: string,
    index: number,
    size: number,
    sha256?: string
  ): Promise<string | null> {
    const host = this.#live();
    const key = host.files.admitChunk(
      storeId,
      principal,
      resource,
      fileId,
      index,
      size,
      sha256
    );
    await host.schedule();
    return key;
  }

  /**
   * `FileHost.chunkStored`: `ended` for a discarded fixture store too,
   * so its writer removes what it wrote.
   */
  chunkStored(
    storeId: StoreId,
    principal: string,
    fileId: string,
    index: number,
    size: number,
    sha256: string,
    key: string
  ): ChunkRecord {
    if (this.#discarded()) {
      return "ended";
    }
    return this.#host.files.chunkStored(
      storeId,
      principal,
      fileId,
      index,
      size,
      sha256,
      key
    );
  }

  /** `FileHost.chunkKey`: none for a discarded fixture store. */
  chunkKey(
    storeId: StoreId,
    principal: string,
    fileId: string,
    index: number
  ): string | null {
    if (this.#discarded()) {
      return null;
    }
    return this.#host.files.chunkKey(storeId, principal, fileId, index);
  }

  /** `FileHost.publishable`. */
  async publishable(
    storeId: StoreId,
    principal: string,
    resource: string,
    fileId: string
  ): Promise<Publishable | UploadState> {
    return await this.#live().files.publishable(
      storeId,
      principal,
      resource,
      fileId
    );
  }

  /** `FileHost.abandonFinish`. */
  abandonFinish(fileId: string, claim: string): void {
    this.#live().files.abandonFinish(fileId, claim);
  }

  /** `FileHost.publish`; its audit event, and orphan expiry, after. */
  async publish(
    storeId: StoreId,
    principal: string,
    resource: string,
    fileId: string,
    verified: boolean,
    claim: string
  ): Promise<UploadState> {
    const host = this.#live();
    try {
      return host.files.publish(
        storeId,
        principal,
        resource,
        fileId,
        verified,
        claim
      );
    } finally {
      await this.#afterFiles();
    }
  }

  /** `FileHost.cancel`; the cancelled upload's purge gets the alarm. */
  async cancelUpload(
    storeId: StoreId,
    principal: string,
    resource: string,
    fileId: string
  ): Promise<UploadState> {
    const host = this.#live();
    const state = host.files.cancel(storeId, principal, resource, fileId);
    await host.schedule();
    return state;
  }

  /** `FileHost.content`. */
  async fileContent(
    storeId: StoreId,
    reader: FileReader,
    resource: string,
    fileId: string
  ): Promise<FileContent> {
    return await this.#live().files.content(storeId, reader, resource, fileId);
  }

  /** `FileHost.readableThrough`. */
  async fileReadableThrough(
    storeId: StoreId,
    reader: FileReader,
    fileId: string,
    resources: string[]
  ): Promise<FileContent> {
    return await this.#live().files.readableThrough(
      storeId,
      reader,
      fileId,
      resources
    );
  }

  /** `FileHost.usable`. */
  async filesUsable(
    storeId: StoreId,
    reader: FileReader,
    fileIds: string[],
    resources: string[]
  ): Promise<void> {
    await this.#live().files.usable(storeId, reader, fileIds, resources);
  }

  /** `FileHost.delete`; its audit event, and the purge, after. */
  async deleteFile(
    storeId: StoreId,
    principal: string,
    resource: string,
    fileId: string,
    key?: string
  ): Promise<void> {
    const host = this.#live();
    host.files.delete(storeId, principal, resource, fileId, key);
    await this.#afterFiles();
  }

  /** `StoreHost.close`. */
  async close(storeId: StoreId, actor: AuditActor): Promise<StoreDeletionMark> {
    return await this.#live().close(storeId, actor);
  }

  /**
   * `StoreHost.commit`, with the deployment's outbox consumers, as the
   * JSON text of its `Committed`, as for `claim`.
   */
  async commit(input: Commit): Promise<string> {
    return JSON.stringify(
      await this.#live().commit(input, storeOutboxConsumers(this.env))
    );
  }

  /**
   * Keeps `watcher` for a live query of `principal`'s that read the
   * tables of `readSet` at those generations (`StoreWatches.watch`):
   * told of every write that changes one of them. Answers the watch's ID,
   * and whether a write moved past what it read already.
   */
  async watch(
    storeId: StoreId,
    principal: string,
    readSet: Record<string, number>,
    watcher: StoreWatcher
  ): Promise<{ id: string; moved: boolean }> {
    const host = this.#live();
    const made = await this.#watches.watch(principal, readSet, watcher, () =>
      host.generations(storeId, Object.keys(readSet))
    );
    // While it holds watches, the alarm sweeps the dead ones within
    // `watchSweepMs`: one set later (a receipt's expiry) is brought
    // forward, and runs whatever it was for then too.
    const sweepAt = Date.now() + watchSweepMs;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > sweepAt) {
      await this.ctx.storage.setAlarm(sweepAt);
    }
    return made;
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
   * for a store core recorded as a fixture (`app_test_fixtures`, or, until
   * that table goes, an earlier preview's, legacy-preview-stores.ts) and its
   * inventory doesn't list, whatever asks: a business store is only ever
   * deleted through its deletion (store-deletion.ts), audited and kept
   * until nothing refers to it. Its live queries' watches go with it. Both are read in one query, and nothing
   * is awaited between it and emptying the object.
   */
  async discardFixture(storeId: StoreId): Promise<void> {
    if (this.ctx.id.name !== undefined && this.ctx.id.name !== storeId) {
      throw new Error("That isn't this object's store.");
    }
    const found = await this.env.DB.prepare(
      "SELECT EXISTS (SELECT 1 FROM business_stores WHERE id = ?1) AS listed, (EXISTS (SELECT 1 FROM app_test_fixtures WHERE store_id = ?1) OR EXISTS (SELECT 1 FROM preview_fixture_stores WHERE store_id = ?1)) AS fixture"
    )
      .bind(storeId)
      .first<{ listed: number; fixture: number }>();
    if (found?.listed !== 0) {
      throw new Error("A listed store is deleted, never discarded.");
    }
    if (found.fixture !== 1) {
      throw new Error("Only a fixture store core recorded is discarded.");
    }
    await this.#discard();
  }

  /**
   * Empties everything the object holds, and its alarm, and marks it
   * discarded, so it refuses every call after (`#live`) and wakes to
   * nothing. Its live queries too: nothing is written to it again, so they
   * would only hold their watchers until the object is evicted.
   */
  async #discard(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.ctx.storage.kv.put(discardedKey, true);
    await this.ctx.storage.deleteAlarm();
    this.#watches.clear();
  }

  /** Refuses unless `storeId` is this object's and no listed store. */
  async #requireThrowaway(storeId: StoreId): Promise<void> {
    if (this.ctx.id.name !== undefined && this.ctx.id.name !== storeId) {
      throw new Error("That isn't this object's store.");
    }
    const listed = await this.env.DB.prepare(
      "SELECT 1 AS listed FROM business_stores WHERE id = ?1"
    )
      .bind(storeId)
      .first<{ listed: number }>();
    if (listed !== null) {
      throw new Error("A listed store is never a throwaway one.");
    }
  }

  /**
   * Keeps this object as a builder's throwaway preview store
   * (draft-runs.ts) until `until`, when it empties itself unless held
   * again: whatever someone typed into a preview goes once nobody uses it,
   * with no record or sweep of core's to keep up. Only for a store the
   * inventory doesn't list, whatever asks: a business store is never
   * emptied this way. Never for one emptied for good (`emptyThrowaway`):
   * a call that held it before then, still under way, can't bring it back.
   */
  async holdThrowaway(storeId: StoreId, until: number): Promise<void> {
    await this.#requireThrowaway(storeId);
    this.#live();
    this.ctx.storage.kv.put(throwawayKey, until);
    await this.#throwawayAlarm(until);
  }

  /**
   * Empties this throwaway store for good, at once: its chat was deleted,
   * its draft dropped, or its person removed or erased. It refuses every
   * call after, one under way included, and is never held again; a
   * preview that runs on afterwards gets a store of a new name.
   */
  async emptyThrowaway(storeId: StoreId): Promise<void> {
    await this.#requireThrowaway(storeId);
    await this.#discard();
  }
  /** Brings the alarm forward to `until`, when the throwaway store empties. */
  async #throwawayAlarm(until: number): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > until) {
      await this.ctx.storage.setAlarm(until);
    }
  }

  /**
   * `StoreHost.runAlarm`, with the deployment's outbox consumers, and a
   * sweep of the live queries whose watchers are gone; nothing
   * for a discarded fixture store, which arms no alarm again. A throwaway
   * store past its hold empties itself and starts again from nothing at
   * its next call, its live queries ended with it.
   */
  override async alarm(): Promise<void> {
    if (this.#discarded()) {
      return;
    }
    const throwaway = this.ctx.storage.kv.get<number>(throwawayKey);
    if (throwaway !== undefined && throwaway <= Date.now()) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      // Its host's state in memory is gone with its rows: the next call
      // wakes a new object, which makes its tables afresh.
      this.ctx.abort("The throwaway store expired.");
      return;
    }
    await this.#live().runAlarm(storeOutboxConsumers(this.env));
    if (throwaway !== undefined) {
      await this.#throwawayAlarm(throwaway);
    }
    if (this.#watches.size > 0) {
      await this.#watches.sweep();
      const next = await this.ctx.storage.getAlarm();
      if (next === null || next > Date.now() + watchSweepMs) {
        await this.ctx.storage.setAlarm(Date.now() + watchSweepMs);
      }
    }
  }
}
