import { z } from "zod";

import { ChatListWatch } from "./chat-list-watch.ts";
import type { ChatList } from "./chat-list-watch.ts";
import {
  acceptWatcher,
  closeWatcher,
  makeRoom,
  personWatcherSchema,
  sendFrame,
  watchEnds,
  watchersOf,
} from "./socket-watchers.ts";

// A person's open connections, and the pages that follow their list of
// chats, as their own object (workspace.ts) knows them. Each signed-in
// connection of theirs (a tab, rpc.ts) holds a socket to it that
// hibernates with it (socket-watchers.ts, upstream.ts), so a
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

/** The tag of a socket that follows the person's list of chats. */
const listTag = "list";

/**
 * Most sockets of each kind (connections, list follows) the object holds
 * for the person at once: past it, their oldest is let go of. A connection
 * let go of reads its session on each call and push as any does, without
 * the telling's speed; a list follow let go of ends (`watchEnds.displaced`).
 */
const maxConnections = 50;

/** What a connection is told: read your session again now. */
export const recheckFrame = { recheck: true } as const;

/** A frame a connection's socket carries (`recheckFrame`). */
export const recheckFrameSchema = z.object({ recheck: z.literal(true) });

/**
 * What each socket that follows the list was sent, while the object is in
 * memory: a socket it has none for (after a sleep or a reset) gets the
 * whole list with its next update.
 */
const listSent = new WeakMap<WebSocket, ChatListWatch>();

/**
 * Accepts a socket of `personId`'s (the object's own person), opened by
 * core's Worker (upstream.ts): a connection's (`/connection`), or one
 * that follows their list of chats (`/list`), which gets the whole list
 * (`listOf`) at once and what changes in it after (`pushList`). Answers
 * the upgrade.
 */
export const acceptPersonSocket = (
  ctx: DurableObjectState,
  request: Request,
  personId: string,
  listOf: (personId: string) => ChatList
): Response => {
  const tag = { "/connection": connectionTag, "/list": listTag }[
    new URL(request.url).pathname
  ];
  if (
    request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
    personId === "" ||
    tag === undefined
  ) {
    return new Response(null, { status: 400 });
  }
  makeRoom(watchersOf(ctx, personWatcherSchema, tag), personId, maxConnections);
  const { socket, response } = acceptWatcher(
    ctx,
    { personId, at: Date.now() },
    [tag]
  );
  if (tag === listTag) {
    const sent = new ChatListWatch();
    listSent.set(socket, sent);
    sendFrame(socket, sent.next(listOf(personId)));
  }
  return response;
};

/** Whether anyone follows the person's list now. */
export const listFollowed = (ctx: DurableObjectState): boolean =>
  ctx.getWebSockets(listTag).length > 0;

/**
 * Sends each socket that follows the list what of it changed since it was
 * last sent (`listOf`, read once for all of them).
 */
export const pushList = (
  ctx: DurableObjectState,
  listOf: (personId: string) => ChatList
): void => {
  const followers = watchersOf(ctx, personWatcherSchema, listTag);
  const [first] = followers;
  if (first === undefined) {
    return;
  }
  // Read once: every follower is the object's own person's.
  const list = listOf(first.state.personId);
  for (const { socket } of followers) {
    const sent = listSent.get(socket) ?? new ChatListWatch();
    listSent.set(socket, sent);
    const update = sent.next(list);
    if (update !== undefined) {
      sendFrame(socket, update);
    }
  }
};

/** Ends every follow of the list: the person's chats are gone (erased). */
export const endListFollows = (ctx: DurableObjectState): void => {
  for (const socket of ctx.getWebSockets(listTag)) {
    closeWatcher(socket, watchEnds.gone, "Gone");
  }
};

/** Tells every connection of the person to read its session again now. */
export const recheckConnections = (ctx: DurableObjectState): void => {
  for (const { socket } of watchersOf(
    ctx,
    personWatcherSchema,
    connectionTag
  )) {
    sendFrame(socket, recheckFrame);
  }
};
