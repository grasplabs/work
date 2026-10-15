import type { CoreConnection, SessionEnded } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { CoreLink, retryingOn } from "./core-link.ts";

// How an App frame reaches core: over the tab's one connection, the
// shell's own (core-connection.ts, spec 11.2), so a tab holds one
// authenticated connection however many frames it opens, and one reading
// of the person's session. Each frame still gets its own bridge and its
// own way to its App on that connection (core's `screens.frame`), never
// the connection itself, and closing a frame lets go of those, never of
// the connection: it stays for the tab's life.
//
// The connection is for one person. Once their session ends (signed out,
// revoked, or someone else signed in on the browser), or a frame learns
// from core that the browser's session is someone else's now, every frame
// on it is told and stops before the page loads again. Nothing a frame
// sends or its App answers ends it: only core's own answers to the page
// (screen-host.ts).

type Ended = (why: SessionEnded) => void;

/** What a frame needs of its connection to core. */
export interface FrameLink {
  /**
   * The signed-in session, once connected: waited for across reconnects
   * for as long as it takes, and refused once the session ended.
   */
  session: () => Promise<Session>;
  /** Who the connection is for, refused as `session` is. */
  person: () => Promise<string>;
  /** Runs `run` on the session, and again while it fails in a way that may pass. */
  retrying: <T>(run: (session: Session) => Promise<T>) => Promise<T>;
}

/** A frame's place on its connection to core. */
export interface Joined {
  link: FrameLink;
  /** Ends the person's session on the page: every frame stops, this one too. */
  end: (why: SessionEnded) => void;
  /** The frame is gone: it hears no more of the connection, which stays. */
  leave: () => void;
}

/**
 * Joins the tab's connection `core`: `onEnded` is called once if the
 * person's session ends while the frame is on it. The frame waits for the
 * connection across reconnects for as long as it takes, as its start has
 * a deadline of its own (`screenLimits.openMs`) and a running screen waits
 * out a reconnect, but no longer than it is on it: once it leaves, what
 * it still waits for is refused, so nothing it asked for is sent once
 * core is back.
 */
export const tabLink = (core: CoreConnection, onEnded: Ended): Joined => {
  const left = new AbortController();
  const stopListening = core.onEnded(onEnded);
  const session = async (): Promise<Session> => await core.session(left.signal);
  return {
    link: {
      session,
      person: async () => {
        const { userId } = await core.person(left.signal);
        return userId;
      },
      // Ending closes the connection, so a session is refused from then.
      retrying: async (run) =>
        await retryingOn(session, run, () => !left.signal.aborted),
    },
    end: (why) => {
      core.end(why);
    },
    leave: () => {
      stopListening();
      left.abort(new Error("The frame was stopped."));
    },
  };
};

/**
 * A link of one frame's own, closed when the frame leaves: for a draft's
 * preview, as core keeps the callbacks its server calls pass
 * (`chats.previewCall`) per connection, with no capability of the frame's
 * own to let go of them, so only closing its connection when the preview
 * stops releases them. Ending it ends the preview alone.
 */
export const ownLink = (onEnded: Ended): Joined => {
  const link = new CoreLink(onEnded);
  return {
    link,
    end: (why) => {
      link.close();
      onEnded(why);
    },
    leave: () => {
      link.close();
    },
  };
};
