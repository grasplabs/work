import { errorFields, log } from "@grasp-os/shared/log";

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
// - The object ends the watch for good (`watchEnds`): opened no more, and
//   the owner is told why.
// - A page slower than the object: frames wait in order, one taken at a
//   time; past `maxQueuedBytes` they are dropped and the socket opened
//   again from what the page took, whose first frame catches it up whole.
//   So a slow page costs a catch-up, never memory without bound.
// - The page doesn't take a frame: gone, or refused (signed out, no longer
//   allowed), its callback lets go of it (page-callbacks.ts), which ends
//   the watch; a check that couldn't be read for now has it opened again
//   from what the page took, so the frame comes again.

/** Frames waiting for the page past this many bytes are dropped for a catch-up. */
export const maxQueuedBytes = 4 * 1024 * 1024;

/** The pauses before opening a closed watch again: at once, then up to every 5 s. */
const reopenMs = [0, 500, 1000, 2000, 5000] as const;

/** What a page's watch of an object is made of. */
export interface UpstreamWatch {
  /**
   * Opens the socket: an upgrade request to the object, from where the
   * page got to. Called for each try.
   */
  open: () => Promise<Response>;
  /**
   * Hands a frame to the page, once the one before was taken. Throws when
   * it didn't reach the page: the frame comes again on a socket opened
   * again, unless the owner disposed of the watch meanwhile (its page
   * gone or refused).
   */
  deliver: (frame: unknown) => Promise<void>;
  /** The object ended the watch for good, with this close code (`watchEnds`). */
  ended: (code: number) => void;
  /** What the first open's refusal is thrown as (the object answered no socket). */
  refused: (response: Response) => Error;
  /** Named in the log lines of a failed reopen. */
  logged: Record<string, string>;
}

/**
 * Follows an object for a page (`UpstreamWatch`), until disposed: opens
 * the socket now, throwing as `refused` says when the object answers no
 * socket, then keeps it open (see above). Disposing closes it.
 */
export const followObject = async (
  watch: UpstreamWatch
): Promise<Disposable> => {
  let stopped = false;
  let socket: WebSocket | undefined;
  const queue: string[] = [];
  let queuedBytes = 0;
  /**
   * Opens in a row that ended with a frame the page didn't take: the next
   * waits as long as that many failed opens would, so a check that keeps
   * failing doesn't open the socket over and over.
   */
  let failures = 0;
  /** The frames being handed to the page now, if they are. */
  let delivering: Promise<void> | undefined;

  const stop = (): void => {
    stopped = true;
    queue.length = 0;
    queuedBytes = 0;
    const open = socket;
    socket = undefined;
    if (open !== undefined) {
      try {
        open.close(1000, "Released");
      } catch {
        // Closed already.
      }
    }
  };

  const handOver = async (): Promise<void> => {
    try {
      for (let text = queue.shift(); text !== undefined; text = queue.shift()) {
        if (stopped) {
          return;
        }
        queuedBytes -= text.length;
        // oxlint-disable-next-line no-await-in-loop -- one frame at a time, in order
        await watch.deliver(JSON.parse(text));
        failures = 0;
      }
    } catch {
      // A page that is gone, or refused, let go of its watch already
      // (stopped). Anything else (a check that couldn't be read now) is
      // tried again from what the page took, so nothing is skipped.
      failures += 1;
      // oxlint-disable-next-line no-use-before-define -- each starts the other
      restart();
    } finally {
      delivering = undefined;
    }
  };
  const drain = (): void => {
    delivering ??= handOver();
  };
  /**
   * Drops the frames of a socket that closed, and waits for the one the
   * page is taking: the next socket starts from what the page took, and
   * sends the rest again, so nothing is handed over twice.
   */
  const settle = async (): Promise<void> => {
    queue.length = 0;
    queuedBytes = 0;
    await delivering;
  };

  /** Closes the open socket and opens another, from what the page took. */
  const restart = (): void => {
    const open = socket;
    socket = undefined;
    if (stopped || open === undefined) {
      return;
    }
    try {
      open.close(1000, "Catching up");
    } catch {
      // Closed already.
    }
    // oxlint-disable-next-line no-use-before-define -- each starts the other
    void reopen();
  };

  /** Opens the socket, once; the object's answer when it gave none. */
  const connect = async (): Promise<WebSocket | Response> => {
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
      return opened;
    }
    socket = opened;
    opened.addEventListener("message", ({ data }) => {
      if (socket !== opened || stopped) {
        return;
      }
      const text = typeof data === "string" ? data : "";
      queue.push(text);
      queuedBytes += text.length;
      if (queuedBytes > maxQueuedBytes) {
        // The page took too little: what it took is where the next
        // socket starts, and its first frame carries the rest.
        restart();
        return;
      }
      drain();
    });
    const lost = (code: number): void => {
      if (socket !== opened || stopped) {
        return;
      }
      socket = undefined;
      if (code === watchEnds.gone || code === watchEnds.displaced) {
        stopped = true;
        watch.ended(code);
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
    return opened;
  };

  const reopen = async (): Promise<void> => {
    for (let attempt = failures; !stopped; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one try at a time, waiting longer each
      await scheduler.wait(
        reopenMs[Math.min(attempt, reopenMs.length - 1)] ?? 0
      );
      if (stopped) {
        return;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- see above
        await settle();
        // oxlint-disable-next-line no-await-in-loop -- see above
        const opened = await connect();
        if (opened instanceof Response) {
          // The object has no such watch any more.
          stopped = true;
          watch.ended(watchEnds.gone);
        }
        return;
      } catch (error) {
        log.warn("watch.reopen_failed", {
          ...watch.logged,
          ...errorFields(error),
        });
      }
    }
  };

  const first = await connect();
  if (first instanceof Response) {
    throw watch.refused(first);
  }
  return { [Symbol.dispose]: stop };
};
