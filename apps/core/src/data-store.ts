import type { StoreId } from "@grasp-os/shared/ids";
import type {
  ClaimInput,
  Claimed,
  Commit,
  Committed,
  StoredRecord,
} from "@grasp-os/shared/stores";
import { DurableObject } from "cloudflare:workers";

import migrations from "./db/data-store/migrations/migrations.js";
import { migrateOnWake } from "./db/migrate.ts";
import { outboxConsumers } from "./outbox-delivery.ts";
import { StoreHost } from "./store-host.ts";

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
  defineTables(
    storeId: StoreId,
    names: readonly string[]
  ): Record<string, string> {
    return this.#host.defineTables(storeId, names);
  }

  /** `StoreHost.get`. */
  get(storeId: StoreId, table: string, id: string): StoredRecord | null {
    return this.#host.get(storeId, table, id);
  }

  /** `StoreHost.claim`. */
  async claim(input: ClaimInput): Promise<Claimed> {
    return await this.#host.claim(input);
  }

  /** `StoreHost.commit`, with the deployment's outbox consumers. */
  async commit(input: Commit): Promise<Committed> {
    return await this.#host.commit(input, outboxConsumers);
  }

  /** `StoreHost.runAlarm`, with the deployment's outbox consumers. */
  override async alarm(): Promise<void> {
    await this.#host.runAlarm(outboxConsumers);
  }
}
