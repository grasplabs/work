import { z } from "zod";

import {
  acceptWatcher,
  closeWatcher,
  makeRoom,
  personWatcherSchema,
  sendFrame,
  watchersOf,
} from "./socket-watchers.ts";

// A person's open connections, as their own object (workspace.ts) knows
// them: each signed-in connection of theirs (a tab, rpc.ts) holds a socket
// to it that hibernates with it (socket-watchers.ts, upstream.ts), so a
// person with tabs open and nothing happening costs nothing. Whatever ends
// a session or changes who someone is (signing out, an admin ending their
// sessions, removing them, a new role or team, erasure; identity-changes.ts)
// tells their object once it has committed, and the object tells every
// connection of theirs to read its session again now (`recheck`): one that
// no longer holds closes within about a second, idle or not, and one whose
// role or teams changed answers as the new one from its next call.
//
// The telling only says "look again": the connection's own session and the
// database decide, so a telling that is forged, late or twice changes
// nothing for someone whose session still holds. And a telling lost on its
// way costs only speed, never safety: a connection reads its session again
// before any call or push once its reading is older than `sessionRecheckMs`
// (session-check.ts), so nothing reaches a person more than that after
// their session ended.

/** The tag of a connection's socket among the object's others. */
const connectionTag = "connection";

/**
 * Most connections of the person the object holds at once: past it, their
 * oldest is let go of, which then reads its session on each call and push
 * as any connection does, without the telling's speed.
 */
const maxConnections = 50;

/** What a connection's socket carries through hibernation: whose, and since when. */
const connectionSchema = personWatcherSchema;

/** What a connection is told: read your session again now. */
export const recheckFrame = { recheck: true } as const;

/** A frame a connection's socket carries (`recheckFrame`). */
export const recheckFrameSchema = z.object({ recheck: z.literal(true) });

/**
 * Accepts the socket of a connection of `personId`'s (the object's own
 * person), opened by core's Worker. Answers the upgrade.
 */
export const acceptConnection = (
  ctx: DurableObjectState,
  request: Request,
  personId: string
): Response => {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response(null, { status: 400 });
  }
  makeRoom(
    watchersOf(ctx, connectionSchema, connectionTag),
    personId,
    maxConnections
  );
  return acceptWatcher(ctx, { personId, at: Date.now() }, [connectionTag])
    .response;
};

/** Tells every connection of the person to read its session again now. */
export const recheckConnections = (ctx: DurableObjectState): void => {
  for (const { socket } of watchersOf(ctx, connectionSchema, connectionTag)) {
    sendFrame(socket, recheckFrame);
  }
};

/** A connection's socket closed: its close is answered. */
export const connectionClosed = (socket: WebSocket, code: number): void => {
  closeWatcher(socket, code, "Closed");
};

/** A connection sent something: no connection does, so it is let go of. */
export const connectionSpoke = (socket: WebSocket): void => {
  closeWatcher(socket, 1003, "Nothing is read here");
};
