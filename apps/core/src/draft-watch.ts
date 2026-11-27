import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import {
  acceptWatcher,
  closeWatcher,
  makeRoom,
  personWatcherSchema,
  sendFrame,
  watchersOf,
} from "./socket-watchers.ts";

// Who follows one App's or workflow's draft (drafts.ts, drafts-rpc.ts):
// one object per subject, named `kind:id`. Each page that follows it is a
// socket core's Worker opened to it (upstream.ts), which hibernates with
// the object (socket-watchers.ts): a draft nobody writes costs nothing,
// however many pages follow it. Every write tells it (`revised`), which
// tells each, so every open page of the subject takes the write at once,
// whoever made it. Core checks the caller builds the subject before it
// follows, and again before each push reaches the page (drafts-rpc.ts).
//
// Each telling is numbered, and the latest kept: a socket opened after a
// reset, or one opened late, names the last telling its page took and is
// told the latest at once if it missed one, and never told one twice
// (`told` is kept and read with nothing awaited between, so a telling
// lands either before a socket is accepted, and is sent as it opens, or
// after, and is sent to it live).
//
// A write never waits on its followers: the writer tells this object
// without awaiting it (drafts.ts, `draftRevised`), and sending to a socket
// never waits. Nobody fills it for the others: past `watchersPerPerson`
// of one person's pages, their oldest stops following.

/**
 * Most pages of one person's that follow one draft at once: a page past
 * it takes the place of their oldest.
 */
const watchersPerPerson = 20;

/** A follower's state, as its socket carries it through hibernation. */
const followerSchema = personWatcherSchema;

/**
 * A telling: its number, and the revision it told. What a follower's
 * socket is sent, and the latest one kept.
 */
export const draftToldSchema = z.object({ seq: z.int(), revision: z.int() });

type DraftTold = z.infer<typeof draftToldSchema>;

/** Where the latest telling is kept. */
const toldKey = "told";

export class DraftWatch extends DurableObject<Env> {
  /** The latest telling, if there was one. */
  #told(): DraftTold | undefined {
    const told = draftToldSchema.safeParse(this.ctx.storage.kv.get(toldKey));
    return told.success ? told.data : undefined;
  }

  /**
   * The draft was written (a chat's agent, a person's edit, a restore, a
   * discard, a publish or a roll back): every page that follows it hears
   * of `revision`, the one it is at now.
   */
  revised(revision: number): void {
    const told = { seq: (this.#told()?.seq ?? 0) + 1, revision };
    this.ctx.storage.kv.put(toldKey, told);
    for (const { socket } of watchersOf(this.ctx, followerSchema)) {
      sendFrame(socket, told);
    }
  }

  /**
   * A page of `person`'s follows the draft: core's Worker's socket, which
   * names the last telling the page took (`after`, none for a page that
   * just read the draft), and is told the latest at once if it is newer.
   * Past `watchersPerPerson` of theirs, their oldest page stops following.
   */
  override fetch(request: Request): Response {
    const url = new URL(request.url);
    const personId = url.searchParams.get("person");
    const after = Number(url.searchParams.get("after") ?? "0");
    if (
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
      personId === null ||
      personId === "" ||
      !Number.isSafeInteger(after)
    ) {
      return new Response(null, { status: 400 });
    }
    makeRoom(watchersOf(this.ctx, followerSchema), personId, watchersPerPerson);
    const { socket, response } = acceptWatcher(this.ctx, {
      personId,
      at: Date.now(),
    });
    const told = this.#told();
    if (told !== undefined && told.seq > after) {
      sendFrame(socket, told);
    }
    return response;
  }

  // oxlint-disable-next-line class-methods-use-this -- the Hibernation API's handler
  override webSocketMessage(socket: WebSocket): void {
    // A follower sends nothing: one that does is no follower of ours.
    closeWatcher(socket, 1003, "Nothing is read here");
  }

  // oxlint-disable-next-line class-methods-use-this -- the Hibernation API's handler
  override webSocketClose(socket: WebSocket, code: number): void {
    closeWatcher(socket, code, "Closed");
  }
}
