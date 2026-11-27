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

/**
 * How an object ends a watch for good, so the Worker opens it no more;
 * any other close (a reset, a deploy's) it opens again, from where the
 * page got to.
 */
export const watchEnds = {
  /** What it followed is gone (deleted), or isn't theirs. */
  gone: 4404,
  /** A newer watch of the same person's took its place. */
  displaced: 4409,
} as const;

/**
 * Accepts the Worker's upgrade as a watcher that hibernates with the
 * object: `state` (at most 16 KiB as JSON) is attached to the socket, and
 * `tags` name it for `watchersOf`. Answers the upgrade.
 */
export const acceptWatcher = (
  ctx: DurableObjectState,
  state: unknown,
  tags?: string[]
): { socket: WebSocket; response: Response } => {
  const { 0: client, 1: server } = new WebSocketPair();
  ctx.acceptWebSocket(server, tags);
  server.serializeAttachment(state);
  return {
    socket: server,
    response: new Response(null, { status: 101, webSocket: client }),
  };
};

/**
 * The object's open watchers (those tagged `tag`, if given), each with its
 * attached state as `schema` reads it: one closing already, or whose state
 * isn't of this kind, is left out.
 */
export const watchersOf = <T>(
  ctx: DurableObjectState,
  schema: z.ZodType<T>,
  tag?: string
): { socket: WebSocket; state: T }[] =>
  ctx.getWebSockets(tag).flatMap((socket) => {
    if (socket.readyState !== WebSocket.OPEN) {
      return [];
    }
    const state = schema.safeParse(socket.deserializeAttachment());
    return state.success ? [{ socket, state: state.data }] : [];
  });

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

/** A watcher's attached state, by a person: who, and since when (oldest first). */
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
