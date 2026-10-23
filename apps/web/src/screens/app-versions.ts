import type {
  AppVersionPush,
  RunSubscriptionApi,
} from "@grasp-os/shared/screens";
import { RpcStub } from "capnweb";

import type { Session } from "../core.ts";
import { isTransient, reconnectDelay, wait } from "../core.ts";

// How a tab's frames hear that their App has another current version
// (spec 11.5): one subscription per App on the tab's connection (core's
// `screens.watchVersion`), shared by every frame of that App, in place of
// each frame asking on a timer. Core pushes the version current now at
// once, again when another is made current, and whenever the person's
// access may have dropped (`recheck`), each push read for the person;
// once they lost the App, the refusal is the last.
//
// What can go wrong, and how each is handled:
//
// - The connection drops, or core lets go of the subscription (it can no
//   longer follow the App): the page follows again on the connection it
//   has then, after a pause that grows, and core pushes the version
//   current then at once, so nothing that changed meanwhile is missed.
// - A frame opens after the subscription started: it is told the last
//   version core pushed at once, and shares the subscription.
// - The person lost the App: every frame of it hears the refusal, and
//   nothing is followed for it until a frame opens it again.
// - The session ended: core's refusal of the connection ends the frames
//   (tab-link.ts); nothing here waits on.

/** Told each push of an App's version (`AppVersionPush`). */
export type VersionListener = (push: AppVersionPush) => void;

/** One App's subscription, and the frames it tells. */
interface Followed {
  readonly listeners: Set<VersionListener>;
  /** The last version core pushed, for a frame that joins later. */
  last: Extract<AppVersionPush, { type: "current" }> | undefined;
  /** Core's hold on it, once it answered. */
  hold: RunSubscriptionApi | undefined;
  /** Failed attempts since the last that held, for the pause. */
  attempt: number;
}

/** The code and message of a refusal, as a push carries it. */
const refusalOf = (
  error: unknown
): { code: string; message: string } | undefined => {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code: unknown = Reflect.get(error, "code");
  const message: unknown = Reflect.get(error, "message");
  return typeof code === "string"
    ? { code, message: typeof message === "string" ? message : "" }
    : undefined;
};

/**
 * A connection's subscriptions to its Apps' versions: `session` is its
 * signed-in session, waited for across reconnects and refused once the
 * session ended.
 */
export class VersionFeed {
  readonly #session: () => Promise<Session>;
  readonly #apps = new Map<string, Followed>();

  constructor(session: () => Promise<Session>) {
    this.#session = session;
  }

  /**
   * Has `listener` told each push of `app`'s version, the last one at
   * once if there was one, until the returned function is called; the
   * last frame of an App to stop lets go of its subscription.
   */
  follow(app: string, listener: VersionListener): () => void {
    let followed = this.#apps.get(app);
    if (followed === undefined) {
      followed = {
        listeners: new Set(),
        last: undefined,
        hold: undefined,
        attempt: 0,
      };
      this.#apps.set(app, followed);
      void this.#subscribe(app, followed);
    } else if (followed.last !== undefined) {
      const { last } = followed;
      queueMicrotask(() => {
        if (followed?.listeners.has(listener) === true) {
          listener(last);
        }
      });
    }
    followed.listeners.add(listener);
    const entry = followed;
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0 && this.#apps.get(app) === entry) {
        this.#apps.delete(app);
        void entry.hold?.release();
      }
    };
  }

  /** Tells every frame of `app` that `push` came, if it is still followed. */
  #tell(app: string, followed: Followed, push: AppVersionPush): void {
    if (this.#apps.get(app) !== followed) {
      return;
    }
    if (push.type === "current") {
      followed.last = push;
    } else {
      // Nothing more comes: a frame that opens it again follows anew.
      this.#apps.delete(app);
    }
    for (const listener of followed.listeners) {
      listener(push);
    }
  }

  /** Follows `app` on the connection there is now; again when it ends. */
  async #subscribe(app: string, followed: Followed): Promise<void> {
    let session: Session;
    try {
      session = await this.#session();
    } catch {
      // The session ended: the frames are stopped for it (tab-link.ts).
      return;
    }
    if (this.#apps.get(app) !== followed) {
      return;
    }
    let renewed = false;
    // Core let go of the callback, or the connection dropped: once.
    const renew = (): void => {
      if (renewed || this.#apps.get(app) !== followed) {
        return;
      }
      renewed = true;
      followed.hold = undefined;
      void this.#again(app, followed);
    };
    const onVersion = Object.assign(
      (push: AppVersionPush): void => {
        followed.attempt = 0;
        this.#tell(app, followed, push);
      },
      { [Symbol.dispose]: renew }
    );
    let hold: RunSubscriptionApi;
    try {
      hold = await session.screens.watchVersion(app, onVersion);
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal !== undefined && !isTransient(error)) {
        this.#tell(app, followed, { type: "refused", error: refusal });
        return;
      }
      renew();
      return;
    }
    if (this.#apps.get(app) !== followed) {
      // Every frame stopped while core answered.
      await hold.release();
      return;
    }
    followed.hold = hold;
    const stub: unknown = hold;
    if (stub instanceof RpcStub) {
      stub.onRpcBroken(renew);
    }
  }

  /** Follows `app` again after a pause that grows with each failure. */
  async #again(app: string, followed: Followed): Promise<void> {
    await wait(reconnectDelay(followed.attempt));
    followed.attempt += 1;
    await this.#subscribe(app, followed);
  }
}
