import { errorFields, log } from "@grasp-os/shared/log";

import { isolateRpcHeld } from "./rpc-target.ts";
import { watchEnds } from "./socket-watchers.ts";

// The Worker's side of a page's watch (socket-watchers.ts holds the
// object's): for each thing the page follows over its connection, the
// Worker holds a WebSocket to the object that pushes it, which the object
// accepted as one that hibernates with it. The page's callback stays here,
// in the Worker, which is billed for no duration, and the object keeps
// nothing of the page's. Threat model, and how each is closed:
//
// - The object resets (a crash, a deploy's code update, a runtime update)
//   and its sockets close: opened again at once, then less often, from
//   where the page got to (`open` reads it each time), for as long as the
//   page follows, so a reset loses nothing and the page never asks again.
//   Each pause has full jitter, so the watches a deploy closed together
//   don't all open again in the same instant.
//   An answer that isn't a socket counts the same, but a 400 or 404,
//   which says the object has no such watch (`watchEnds.gone`).
// - The object ends the watch for good (`watchEnds`): opened no more, and
//   the owner is told why.
// - A frame that isn't what the watch carries (`parse` refuses it, or it
//   isn't JSON text): the watch ends (`watchEnds.invalid`) and is logged;
//   it can only be a fault, which trying again would repeat.
// - One frame larger than the watch's bound: ends it (`watchEnds.tooLarge`)
//   and is logged, for the same reason.
// - A page slower than the object: frames wait in order, one taken at a
//   time; past the watch's bound, or what the isolate's connections may
//   hold together (`isolateRpcHeld`), they are dropped and the socket
//   opened again from what the page took, after a pause that grows while
//   it keeps happening. Its first frame catches the page up. So a slow page
//   costs a catch-up, never memory without bound, nor a loop of opens.
// - The page doesn't take a frame: gone, or refused (signed out, no longer
//   allowed), its callback lets go of it (page-callbacks.ts), which ends
//   the watch; a check that couldn't be read for now has it opened again
//   from what the page took, after the same growing pause, so the frame
//   comes again and nothing is skipped.

/**
 * The ceilings of the pauses before opening a closed watch again, each
 * waited with full jitter: so every watch a deploy or a reset closed at
 * once doesn't open again in the same instant.
 */
const reopenMs = [1000, 2000, 4000, 8000, 15_000] as const;

/**
 * How long a watch must have kept up, with no catch-up or failed hand-over,
 * before its pauses start over: a page that stays slow keeps backing off.
 */
const steadyMs = 30_000;

/**
 * Where each pause's jitter is drawn from (`reopenMs`): `Math.random`. A
 * test fixes the draw here, so none waits on one, nor on a whole pause.
 */
export const reopenJitter = { draw: (): number => Math.random() };

/** What a page's watch of an object is made of. */
interface UpstreamWatch<T> {
  /**
   * Opens the socket: an upgrade request to the object, from where the
   * page got to. Called for each try.
   */
  open: () => Promise<Response>;
  /** Reads a frame as what the watch carries; throws for anything else. */
  parse: (frame: unknown) => T;
  /**
   * Hands a frame to the page, once the one before was taken. Throws when
   * it didn't reach the page: the frame comes again on a socket opened
   * again, unless the owner disposed of the watch meanwhile (its page
   * gone or refused).
   */
  deliver: (value: T) => Promise<void>;
  /** The most frames may hold, waiting for the page, in UTF-16 code units. */
  maxQueued: number;
  /** The socket opened: the first time, or again after it closed. */
  opened?: () => void;
  /** The watch ended for good, with this code (`watchEnds`). */
  ended: (code: number) => void;
  /** Named in the log lines of the watch. */
  logged: Record<string, string>;
}

/** Thrown when the first open answered no socket: the object's answer. */
class NoSocketError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`The object answered ${status}, not a socket.`);
    this.name = "NoSocketError";
    this.status = status;
  }
}

/**
 * Follows an object for a page (`UpstreamWatch`), until disposed: opens
 * the socket now, throwing when it can't (`NoSocketError` for an answer that
 * isn't one, or what opening threw), then keeps it open (see above).
 * Disposing closes it.
 */
export const followObject = async <T>(
  watch: UpstreamWatch<T>
): Promise<Disposable> => {
  let stopped = false;
  let socket: WebSocket | undefined;
  const queue: string[] = [];
  let queuedBytes = 0;
  /**
   * Opens in a row that ended without the page catching up: the next waits
   * as long as that many failed opens would.
   */
  let failures = 0;
  /** When the watch last fell behind or failed a hand-over. */
  let troubleAt = Number.NEGATIVE_INFINITY;
  /** The watch fell behind or failed a hand-over: the next pause is longer. */
  const trouble = (): void => {
    failures += 1;
    troubleAt = Date.now();
  };
  /** The frames being handed to the page now, if they are. */
  let delivering: Promise<unknown> | undefined;

  /** Drops every waiting frame, and its bytes from the isolate's count. */
  const clearQueue = (): void => {
    queue.length = 0;
    isolateRpcHeld.held -= queuedBytes * 2;
    queuedBytes = 0;
  };

  const closeOpen = (code: number, reason: string): void => {
    const open = socket;
    socket = undefined;
    if (open !== undefined) {
      try {
        open.close(code, reason);
      } catch {
        // Closed already.
      }
    }
  };

  const stop = (): void => {
    stopped = true;
    clearQueue();
    closeOpen(1000, "Released");
  };

  /** Ends the watch for good: told to the owner, a fault logged. */
  const end = (code: number): void => {
    if (stopped) {
      return;
    }
    stop();
    if (code === watchEnds.invalid || code === watchEnds.tooLarge) {
      log.error("watch.frame_refused", { ...watch.logged, code });
    }
    watch.ended(code);
  };

  /** The next frame in the queue, as the watch carries it; ends it on a bad one. */
  const nextValue = (): { value: T } | undefined => {
    const text = queue.shift();
    if (text === undefined) {
      return undefined;
    }
    queuedBytes -= text.length;
    isolateRpcHeld.held -= text.length * 2;
    try {
      return { value: watch.parse(JSON.parse(text)) };
    } catch {
      end(watchEnds.invalid);
      return undefined;
    }
  };

  const handOver = async (): Promise<void> => {
    for (let next = nextValue(); next !== undefined; next = nextValue()) {
      if (stopped) {
        return;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- one frame at a time, in order
        await watch.deliver(next.value);
        if (Date.now() - troubleAt >= steadyMs) {
          failures = 0;
        }
      } catch {
        // A page that is gone, or refused, let go of its watch already
        // (stopped). Anything else (a check that couldn't be read now) is
        // tried again from what the page took, so nothing is skipped.
        trouble();
        // oxlint-disable-next-line no-use-before-define -- each starts the other
        restart();
        return;
      }
    }
  };
  /** Hands the waiting frames over, then says it is done. */
  const handOverAll = async (): Promise<void> => {
    try {
      await handOver();
    } finally {
      delivering = undefined;
    }
  };
  const drain = (): void => {
    if (delivering !== undefined) {
      return;
    }
    // Marked before it runs, and cleared only after: a hand-over that
    // settles at once (a bad first frame) can't leave the mark behind.
    const marked = Promise.withResolvers<true>();
    delivering = marked.promise;
    void (async () => {
      await handOverAll();
      marked.resolve(true);
    })();
  };
  /**
   * Drops the frames of a socket that closed, and waits for the one the
   * page is taking: the next socket starts from what the page took, and
   * sends the rest again, so nothing is handed over twice.
   */
  const settle = async (): Promise<void> => {
    clearQueue();
    await delivering;
  };

  /** Closes the open socket and opens another, from what the page took. */
  const restart = (): void => {
    if (stopped || socket === undefined) {
      return;
    }
    closeOpen(1000, "Catching up");
    // oxlint-disable-next-line no-use-before-define -- each starts the other
    void reopen();
  };

  /** Opens the socket, once: undefined once it is open, else the object's answer. */
  const connect = async (): Promise<Response | undefined> => {
    const response = await watch.open();
    const opened = response.webSocket;
    if (response.status !== 101 || opened === null) {
      return response;
    }
    opened.accept();
    if (stopped) {
      // Let go of while it opened (or while the frames before it were
      // handed over): it must hold no place in the object.
      opened.close(1000, "Released");
      return undefined;
    }
    socket = opened;
    opened.addEventListener("message", ({ data }) => {
      if (socket !== opened || stopped) {
        return;
      }
      if (typeof data !== "string") {
        end(watchEnds.invalid);
        return;
      }
      if (data.length > watch.maxQueued) {
        end(watchEnds.tooLarge);
        return;
      }
      if (
        queuedBytes + data.length > watch.maxQueued ||
        isolateRpcHeld.held + data.length * 2 > isolateRpcHeld.limit
      ) {
        // The page took too little: what it took is where the next
        // socket starts, and its first frame carries the rest.
        trouble();
        restart();
        return;
      }
      queue.push(data);
      queuedBytes += data.length;
      isolateRpcHeld.held += data.length * 2;
      drain();
    });
    const lost = (code: number): void => {
      if (socket !== opened || stopped) {
        return;
      }
      socket = undefined;
      if (Object.values<number>(watchEnds).includes(code)) {
        end(code);
        return;
      }
      // oxlint-disable-next-line no-use-before-define -- each starts the other
      void reopen();
    };
    opened.addEventListener("close", ({ code }) => {
      lost(code);
    });
    opened.addEventListener("error", () => {
      lost(1006);
    });
    watch.opened?.();
    return undefined;
  };

  const reopen = async (): Promise<void> => {
    for (let attempt = failures; ; attempt += 1) {
      if (stopped) {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- one try at a time, waiting longer each
      await scheduler.wait(
        reopenJitter.draw() *
          (reopenMs[Math.min(attempt, reopenMs.length - 1)] ?? 0)
      );
      if (stopped) {
        return;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- see above
        await settle();
        // oxlint-disable-next-line no-await-in-loop -- see above
        const refused = await connect();
        if (refused === undefined) {
          return;
        }
        if (refused.status === 400 || refused.status === 404) {
          // The object has no such watch any more.
          end(watchEnds.gone);
          return;
        }
        throw new NoSocketError(refused.status);
      } catch (error) {
        log.warn("watch.reopen_failed", {
          ...watch.logged,
          ...errorFields(error),
        });
      }
    }
  };

  const refused = await connect();
  if (refused !== undefined) {
    throw new NoSocketError(refused.status);
  }
  return { [Symbol.dispose]: stop };
};
