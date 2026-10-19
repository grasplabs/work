import type {
  AbandonBackfill,
  AbandonedBackfill,
  AppStoreBackfill,
  MigrationSample,
  SampleMigration,
  StoreBackfill,
  StoresApi,
} from "@grasp-os/shared/stores";

import { sampleMigration } from "./migration-samples.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import {
  abandonStoreBackfill,
  appStoreBackfills,
  storeBackfill,
} from "./store-abandon.ts";

// Business stores over `/rpc`, for admins: a store's failed schema change,
// and abandoning it (store-abandon.ts, where who may is decided); an
// explicit migration's dry run on a sample (migration-samples.ts, likewise).

/** Business stores over `/rpc`, for admins, never Grasp staff. */
export class StoresRpc extends CoreRpcTarget implements StoresApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async backfill(store: string): Promise<StoreBackfill | null> {
    return await withPerson(
      this.#check,
      async (person) => await storeBackfill(this.#env, person, store)
    );
  }

  async appBackfills(app: string): Promise<AppStoreBackfill[]> {
    return await withPerson(
      this.#check,
      async (person) => await appStoreBackfills(this.#env, person, app)
    );
  }

  async abandonBackfill(input: AbandonBackfill): Promise<AbandonedBackfill> {
    return await withPerson(
      this.#check,
      async (person) => await abandonStoreBackfill(this.#env, person, input)
    );
  }

  async sampleMigration(input: SampleMigration): Promise<MigrationSample> {
    return await withPerson(
      this.#check,
      async (person) => await sampleMigration(this.#env, person, input)
    );
  }
}
