import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import {
  acceptWatcher,
  makeRoom,
  personWatcherSchema,
  sendFrame,
  watcherHandlers,
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
// never waits.
//
// Expand, then contract: core's Worker of the release before this one
// follows the old way (`watch`, a callback kept in memory) for as long as
// a deploy runs both, so that way stays for this release, and core's
// Worker of this one falls back to it on an object still on the code
// before (no socket). The release after removes both. Nobody fills it for the others: past `watchersPerPerson`
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

/** How long a page followed the old way has to take a push before it is dropped. */
const pushWaitMs = 5000;

/** Where a page followed the old way hears of its writes: its revision. */
type DraftListener = Rpc.Stub<(revision: number) => Promise<void>>;

export class DraftWatch extends DurableObject<Env> {
  /**
   * Pages followed the old way, a callback each in memory (`watch`):
   * only while core's Worker of the release before this one may still
   * call it during a deploy. Removed in the release after.
   */
  readonly #listeners = new Map<
    string,
    { personId: string; listener: DraftListener }
  >();

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
    for (const [id, { listener }] of this.#listeners) {
      void this.#tellOldWay(id, listener, revision);
    }
  }

  /** Tells a page followed the old way, dropping it if it doesn't answer in time. */
  async #tellOldWay(
    id: string,
    listener: DraftListener,
    revision: number
  ): Promise<void> {
    const late = Promise.withResolvers<"late">();
    const timer = setTimeout(() => {
      late.resolve("late");
    }, pushWaitMs);
    try {
      if ((await Promise.race([listener(revision), late.promise])) === "late") {
        this.unwatch(id);
      }
    } catch {
      this.unwatch(id);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Follows the draft for one page of `personId`'s the old way, its
   * callback kept in memory: for core's Worker of the release before this
   * one, during a deploy. Past `watchersPerPerson` of theirs, their oldest
   * stops following. Removed in the release after.
   */
  watch(personId: string, listener: DraftListener): string {
    const theirs = [...this.#listeners].filter(
      ([, follower]) => follower.personId === personId
    );
    for (const [id] of theirs.slice(
      0,
      Math.max(0, theirs.length - watchersPerPerson + 1)
    )) {
      this.unwatch(id);
    }
    const id = crypto.randomUUID();
    this.#listeners.set(id, { personId, listener: listener.dup() });
    return id;
  }

  /** Stops telling the page `watch` answered `id` for. Removed in the release after. */
  unwatch(id: string): void {
    this.#listeners.get(id)?.listener[Symbol.dispose]();
    this.#listeners.delete(id);
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
    watcherHandlers.message(socket);
  }

  // oxlint-disable-next-line class-methods-use-this -- the Hibernation API's handler
  override webSocketClose(socket: WebSocket, code: number): void {
    watcherHandlers.close(socket, code);
  }

  // oxlint-disable-next-line class-methods-use-this -- the Hibernation API's handler
  override webSocketError(socket: WebSocket): void {
    watcherHandlers.error(socket);
  }
}
