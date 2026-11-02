import type {
  ConfirmedStart,
  HeldStart,
  HeldStartsApi,
} from "@grasp-os/shared/held-starts";

import {
  confirmHeldStart,
  declineHeldStart,
  heldStartsOf,
} from "./held-starts.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

/**
 * A signed-in person's `heldStarts`: the starts their chats' agents asked
 * for (held-starts.ts), which only they confirm or decline, through their
 * own session.
 */
export class HeldStartsRpc extends CoreRpcTarget implements HeldStartsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(): Promise<HeldStart[]> {
    return await withPerson(
      this.#check,
      async (by) => await heldStartsOf(this.#env, by)
    );
  }

  async confirm(id: string, inputHash: string): Promise<ConfirmedStart> {
    return await withPerson(
      this.#check,
      async (by) => await confirmHeldStart(this.#env, by, id, inputHash)
    );
  }

  async decline(id: string): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await declineHeldStart(this.#env, by, id);
    });
  }
}
