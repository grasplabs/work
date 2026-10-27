import type {
  BrainSignals,
  BrainSignalsApi,
} from "@grasp-os/shared/brain-signals";

import { CoreRpcTarget } from "../rpc-target.ts";
import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import { dismissBrainSignal, listBrainSignals } from "./signals.ts";

/**
 * Brain usage signals for a signed-in person over `/rpc`, as
 * `BrainDocumentsRpc` is: the owner of the collections they are about lists
 * and dismisses them.
 */
export class BrainSignalsRpc extends CoreRpcTarget implements BrainSignalsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(): Promise<BrainSignals> {
    return await withPerson(
      this.#check,
      async (person) => await listBrainSignals(this.#env, person)
    );
  }

  async dismiss(signalId: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await dismissBrainSignal(this.#env, person, signalId);
    });
  }
}
