import { z } from "zod";

// An object's side of a page's watch (upstream.ts holds the Worker's): the
// Worker that holds the page's connection opens a WebSocket to the object
// for each thing the page follows, and the object accepts it through the
// Hibernation API. So an object that has nothing to do sleeps with its
// watchers still connected and costs nothing; an event wakes it, and it
// finds every watcher again by the socket's tags and what it attached to
// the socket, never by anything it kept in memory, which sleep and a reset
// clear. A stub of the Worker's kept by the object would instead hold it in
// memory, billed, for as long as the page follows, and break at every reset.
//
// Only core's Worker reaches an object (objects have no route of their
// own), and it opens a socket only for what the person behind its
// connection may follow, checked before it opens one; the object checks
// what it serves itself (the chat is theirs, say) as it accepts it.
//
// What a socket carries is versioned (`watcherStateVersion`): code that
// finds a socket whose state it can't read (one made by another version,
// across a deploy) closes it with `watchReopens`, and the Worker opens it
// again, to whichever code then answers, never leaving it frozen.

/**
 * How an object, or the Worker's side itself, ends a watch for good: the
 * Worker opens it no more. Any other close (a reset, a deploy's,
 * `watchReopens`) it opens again, from where the page got to.
 */
export const watchEnds = {
  /** The person's session ended. */
  sessionEnded: 4401,
  /** What it followed is gone (deleted), or isn't theirs. */
  gone: 4404,
  /** A newer watch of the same person's took its place. */
  displaced: 4409,
  /** A frame that isn't what the watch carries: a fault, never retried. */
  invalid: 4400,
  /** One frame larger than the watch takes: a fault, never retried. */
  tooLarge: 4413,
} as const;

/** How an object asks the Worker to open a watch again, at once. */
export const watchReopens = 1012;

/** The version of what a watcher's socket carries. */
const watcherStateVersion = 1;

/**
 * Sets what `socket` carries through hibernation (at most 16 KiB as
 * JSON), versioned: what `watchersOf` reads back.
 */
export const setWatcherState = (socket: WebSocket, state: unknown): void => {
  socket.serializeAttachment({ v: watcherStateVersion, state });
};

/**
 * Accepts the Worker's upgrade as a watcher that hibernates with the
 * object: it carries `state` (`setWatcherState`), and `tags` name it for
 * `watchersOf`. Answers the upgrade.
 */
export const acceptWatcher = (
  ctx: DurableObjectState,
  state: unknown,
  tags?: string[]
): { socket: WebSocket; response: Response } => {
  const { 0: client, 1: server } = new WebSocketPair();
  ctx.acceptWebSocket(server, tags);
  setWatcherState(server, state);
  return {
    socket: server,
    response: new Response(null, { status: 101, webSocket: client }),
  };
};

/** Ends `socket`'s watch, its close answered if the other side began it. */
export const closeWatcher = (
  socket: WebSocket,
  code: number,
  reason: string
): void => {
  try {
    socket.close(code, reason);
  } catch {
    // Closed already.
  }
};

/**
 * The object's open watchers (those tagged `tag`, if given), each with its
 * state as `schema` reads it. One whose state this code can't read is
 * closed for the Worker to open again (`watchReopens`); one closing
 * already is left out.
 */
export const watchersOf = <T>(
  ctx: DurableObjectState,
  schema: z.ZodType<T>,
  tag?: string
): { socket: WebSocket; state: T }[] => {
  const carried = z.object({
    v: z.literal(watcherStateVersion),
    state: schema,
  });
  return ctx.getWebSockets(tag).flatMap((socket) => {
    if (socket.readyState !== WebSocket.OPEN) {
      return [];
    }
    const read = carried.safeParse(socket.deserializeAttachment());
    if (!read.success) {
      closeWatcher(socket, watchReopens, "Open again");
      return [];
    }
    return [{ socket, state: read.data.state }];
  });
};

/**
 * Sends `frame` to the Worker as JSON. A socket that closed meanwhile
 * takes nothing; the Worker opens it again and is caught up then.
 */
export const sendFrame = (socket: WebSocket, frame: unknown): void => {
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    // Closed under it: see above.
  }
};

/** A watcher's state, by a person: who, and since when (oldest first). */
export const personWatcherSchema = z.object({
  personId: z.string(),
  at: z.number(),
});

/**
 * Makes room for one more of `personId`'s watchers among `watchers`: past
 * `most`, their oldest are closed as displaced, so pages a person left
 * without a word never fill the object, and nobody fills it for others.
 */
export const makeRoom = (
  watchers: readonly {
    socket: WebSocket;
    state: z.infer<typeof personWatcherSchema>;
  }[],
  personId: string,
  most: number
): void => {
  const theirs = watchers
    .filter(({ state }) => state.personId === personId)
    .toSorted((a, b) => a.state.at - b.state.at);
  for (const { socket } of theirs.slice(
    0,
    Math.max(0, theirs.length - most + 1)
  )) {
    closeWatcher(socket, watchEnds.displaced, "Displaced");
  }
};

/**
 * The Hibernation API's handlers every object that takes watchers gives:
 * a watcher sends nothing (one that does is let go of), and a close or an
 * error is answered.
 */
export const watcherHandlers = {
  message: (socket: WebSocket): void => {
    closeWatcher(socket, 1003, "Nothing is read here");
  },
  close: (socket: WebSocket, code: number): void => {
    closeWatcher(socket, code, "Closed");
  },
  error: (socket: WebSocket): void => {
    closeWatcher(socket, 1011, "Failed");
  },
} as const;
