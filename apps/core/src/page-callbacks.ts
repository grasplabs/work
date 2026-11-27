import { isExpectedError } from "@grasp-os/shared/errors";
import { jsonBytes } from "@grasp-os/shared/pages";
import { RpcStub } from "capnweb";

import { holdsBigInt, isPlainData } from "./plain-data.ts";
import type { SessionCheck } from "./session-check.ts";

// Callbacks a page passes over `/rpc` for an object to keep and call later:
// a page's for its App (pages-rpc.ts), a chat page's for the chat's
// Workspace object (chats-rpc.ts). The object gets a function that passes
// plain data on and nothing back, and that checks before each push that
// the person may still have it.

/**
 * Whether the person may still get a callback's pushes, read now: false
 * once they may not. Throws when it couldn't be read (the session store
 * out of reach a moment): that push fails, the callback stays.
 */
export type StillOpen = () => Promise<boolean>;

/**
 * Whether the connection's session `check` still holds, as a `StillOpen`:
 * false once it refuses (signed out, ended, no longer let in: an expected
 * error, which also closes the connection); a reading that failed for any
 * other reason (the session store out of reach, an object resetting as a
 * deploy resets it) is thrown, never taken for a sign-out.
 */
export const stillOpenWhile =
  (check: SessionCheck): StillOpen =>
  async () => {
    try {
      await check();
      return true;
    } catch (error) {
      if (isExpectedError(error)) {
        return false;
      }
      throw error;
    }
  };

/** A function (or object) of the page's, which the object may only call. */
export type PageCallback = RpcStub<(value: unknown) => unknown>;

/** A stub of the page's: a function or object it passed. */
export const isStub = (value: unknown): value is PageCallback =>
  value instanceof RpcStub;

/**
 * How a push is refused: data that isn't plain, a person who may no
 * longer have it, or, where pushes are held to a size (`maxBytes`), one
 * that is over it.
 */
export interface Refusals {
  invalid: () => Error;
  closed: () => Error;
  tooLarge?: { maxBytes: number; refuse: () => Error };
}

/**
 * The page's callback `stub` as a function an object can keep and call
 * later: it passes on plain data only (no big integer, which no public
 * value is), never a way into the object, and
 * gives it nothing back from the page. It's released by the runtime once
 * the object lets it go, or by its owner; releasing it twice does nothing.
 * Releasing it releases the page's stub too. Before each push,
 * `stillOpen` checks the person may still have it; once they may not, it
 * releases itself and refuses the push, and every one after. A check
 * that couldn't be read fails that push alone: the object drops its
 * watcher, and whoever follows for the page watches again (chats-rpc.ts,
 * `#follow`). `released`, if given, is called once it's released, however
 * that happened.
 */
export const callbackFor = (
  stub: PageCallback,
  stillOpen: StillOpen,
  refusals: Refusals,
  released?: () => void
): ((value: unknown) => Promise<void>) & Disposable => {
  const toPage = stub.dup();
  let live = true;
  const release = (): void => {
    if (!live) {
      return;
    }
    live = false;
    toPage[Symbol.dispose]();
    released?.();
  };
  return Object.assign(
    async (value: unknown): Promise<void> => {
      if (!isPlainData(value) || holdsBigInt(value)) {
        throw refusals.invalid();
      }
      if (
        refusals.tooLarge !== undefined &&
        jsonBytes(value, refusals.tooLarge.maxBytes) >
          refusals.tooLarge.maxBytes
      ) {
        throw refusals.tooLarge.refuse();
      }
      if (!live || !(await stillOpen())) {
        release();
        throw refusals.closed();
      }
      try {
        await toPage(value);
      } catch (error) {
        // The page didn't take it (gone, or its callback failed): whoever
        // pushes drops the callback, and its slot is free again.
        release();
        throw error;
      }
    },
    { [Symbol.dispose]: release }
  );
};
