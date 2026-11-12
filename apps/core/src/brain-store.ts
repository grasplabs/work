import { BrainStore as Store } from "@grasp-os/brain-next/store";
import type { AlarmHost } from "@grasp-os/brain-next/store";

import { alarmHostOf } from "./brain-next.ts";

/**
 * The Brain's store (@grasp-os/brain-next), as core registers it: a
 * person's own store works its queue on its own alarm with core's model
 * gateway and embedders, and tells core its health as each tick ends
 * (brain-next.ts `alarmHostOf`). The shared store is ticked by core's
 * clock instead (`workBrain`). The class's name stays the package's:
 * class names of Durable Objects are for good.
 */
export class BrainStore extends Store {
  readonly #env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#env = env;
  }

  // A field, as the store's: no caller reaches it over RPC.
  protected override readonly alarmHost = async (): Promise<AlarmHost> =>
    await alarmHostOf(this.#env, this.ctx.id.name);
}
