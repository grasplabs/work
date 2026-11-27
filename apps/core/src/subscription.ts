import type { SubscriptionApi } from "@grasp-os/shared/pages";
import { waitUntil } from "cloudflare:workers";

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
  readonly #endedBy: () => "displaced" | null;
  #released = false;

  /** `endedBy`: why core let go of it by itself, once it did (`SubscriptionApi.endedBy`). */
  constructor(
    release: () => Promise<void>,
    endedBy: () => "displaced" | null = () => null
  ) {
    super();
    this.#release = release;
    this.#endedBy = endedBy;
  }

  async endedBy(): Promise<"displaced" | null> {
    return await Promise.resolve(this.#endedBy());
  }

  async release(): Promise<void> {
    if (this.#released) {
      return;
    }
    this.#released = true;
    await this.#release();
  }

  /**
   * The page let go of it, or its connection closed (a reload, a tab
   * shut), which disposes everything the connection held. The release
   * reaches the object that pushes, so the object frees its slot: on a
   * closed connection the request ends with the socket and would cancel
   * the call on its way, leaving the object a callback nobody hears until
   * a person's every page is refused (`agent.too_many_watches`).
   */
  [Symbol.dispose](): void {
    waitUntil(this.release());
  }
}
