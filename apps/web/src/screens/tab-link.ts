import { CoreLink } from "./core-link.ts";
import type { LinkEnded } from "./core-link.ts";

// The tab's one link to core for the App frames it runs (spec 11.2): every
// frame of the tab goes over it, so a tab holds one authenticated
// connection for its frames however many it opens, and one reading of the
// person's session. Each frame still gets its own bridge and its own way
// to its App on that connection (core's `screens.frame`), never the link
// itself, and closing a frame lets go of those, never of the link: the
// link stays for the tab's life, so moving between pages keeps it.
//
// A link is for one person (core-link.ts). Once it ends (signed out, or
// someone else signed in on the browser), or a frame learns from core
// that the browser's session is someone else's now, every frame on it is
// told, it is closed, and the next frame opens a new one, for whoever is
// signed in then. Nothing a frame sends or its App answers ends it: only
// core's own answers to the page (screen-host.ts).

/** A link to core that a tab's frames share: what `TabLinks` needs of one. */
export interface SharedLink {
  close: () => void;
}

/** A frame's place on the tab's link. */
export interface Joined<Link extends SharedLink> {
  link: Link;
  /** Ends the link for every frame on it, the frame that ends it too. */
  end: (why: LinkEnded) => void;
  /** The frame is gone: it hears no more of the link. The link stays. */
  leave: () => void;
}

type Ended = (why: LinkEnded) => void;

/** One link and the frames on it. */
interface Opened<Link> {
  readonly link: Link;
  /** The frames on it, each told once it ends. */
  readonly frames: Set<Ended>;
  ended: boolean;
}

/**
 * A tab's shared link: opened with `open` by the first frame that joins,
 * and again by the first to join after it ended.
 */
export class TabLinks<Link extends SharedLink> {
  readonly #open: (onEnded: Ended) => Link;
  #current: Opened<Link> | undefined;

  constructor(open: (onEnded: Ended) => Link) {
    this.#open = open;
  }

  /**
   * Joins the tab's link: `onEnded` is called once if it ends while the
   * frame is on it.
   */
  join(onEnded: Ended): Joined<Link> {
    const opened = this.#current ?? this.#opened();
    opened.frames.add(onEnded);
    return {
      link: opened.link,
      end: (why) => {
        this.#end(opened, why);
      },
      leave: () => {
        opened.frames.delete(onEnded);
      },
    };
  }

  /** A new link, the tab's from now on. */
  #opened(): Opened<Link> {
    // The link calls back only once it connected again, after this.
    const made: { opened?: Opened<Link> } = {};
    const link = this.#open((why) => {
      if (made.opened !== undefined) {
        this.#end(made.opened, why);
      }
    });
    const opened: Opened<Link> = { link, frames: new Set(), ended: false };
    made.opened = opened;
    this.#current = opened;
    return opened;
  }

  /** Closes `opened` and tells every frame on it, once. */
  #end(opened: Opened<Link>, why: LinkEnded): void {
    if (opened.ended) {
      return;
    }
    opened.ended = true;
    if (this.#current === opened) {
      this.#current = undefined;
    }
    opened.link.close();
    // Each frame told may leave as it stops, which a set allows.
    for (const frame of opened.frames) {
      frame(why);
    }
    opened.frames.clear();
  }
}

/**
 * The tab's link to core for its App frames. A module, so the tab keeps
 * it while pages come and go; a development reload of the page's other
 * modules (screen-host.ts, a page) keeps it too, as only what changed and
 * what imports it is loaded again.
 */
export const frameLinks = new TabLinks((onEnded) => new CoreLink(onEnded));
