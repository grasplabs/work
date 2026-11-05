import type { SubscriptionApi } from "@grasp-os/shared/screens";

import { CoreRpcTarget } from "./rpc-target.ts";

/**
 * A page's hold on updates it follows: a live query's, an App version's,
 * or a chat's (`chats.watch`). Until it's released,
 * by `release` or once the page lets go of it, it counts toward the
 * connection's subscriptions, and the object that pushes the updates keeps
 * its callback. Releasing it twice does nothing.
 */
export class Subscription extends CoreRpcTarget implements SubscriptionApi {
  readonly #release: () => Promise<void>;
  #released = false;

  constructor(release: () => Promise<void>) {
    super();
    this.#release = release;
  }

  async release(): Promise<void> {
    if (this.#released) {
      return;
    }
    this.#released = true;
    await this.#release();
  }

  [Symbol.dispose](): void {
    void this.release();
  }
}
