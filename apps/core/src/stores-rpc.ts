import type {
  AbandonBackfill,
  AbandonedBackfill,
  StoreBackfill,
  StoresApi,
} from "@grasp-os/shared/stores";

import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { abandonStoreBackfill, storeBackfill } from "./store-abandon.ts";

// Business stores over `/rpc`, for admins: a store's failed schema change,
// and abandoning it (store-abandon.ts, where who may is decided).

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

  async abandonBackfill(input: AbandonBackfill): Promise<AbandonedBackfill> {
    return await withPerson(
      this.#check,
      async (person) => await abandonStoreBackfill(this.#env, person, input)
    );
  }
}
