// The person's acts in one start of a screen's frame, as the frame's
// document reports them (core's screen-frame.ts, its bootstrap): each
// click, tap or key the browser itself delivered there, over a port only
// that bootstrap holds. The page can't see input inside a frame, and a
// screen can focus itself while the activation of a click elsewhere
// lasts; this is what tells a person acting in this frame from that.
//
// Only a message on this port is an act: the screen's code can post on
// its other ports and on the page's window, and none of that counts. What
// a message carries is never read. One act is one navigation (`take`), and
// it counts only while the browser could still hold its activation
// (`actLifetimeMs`); the page also checks that the browser has activation
// now, and that the frame holds the focus (navigation-policy.ts).

/**
 * How long one input's activation lasts at most: 5 s in Chromium and
 * Firefox (HTML leaves it to the browser). An act older than this counts
 * for nothing, whatever activation the page has.
 */
export const actLifetimeMs = 5000;

/** The acts of one start of a frame, read from `port`. */
export interface FrameActs {
  /** Spends the person's latest act in the frame, if one is unspent. */
  readonly take: () => boolean;
  /** Stops listening and closes the port. */
  readonly close: () => void;
}

/** Listens on `port` for the frame's acts, timed by `now` (monotonic, ms). */
export const frameActs = (port: MessagePort, now: () => number): FrameActs => {
  let actedAt: number | undefined;
  const acted = (): void => {
    actedAt = now();
  };
  port.addEventListener("message", acted);
  port.start();
  return {
    take: () => {
      const at = actedAt;
      actedAt = undefined;
      return at !== undefined && now() - at < actLifetimeMs;
    },
    close: () => {
      port.removeEventListener("message", acted);
      port.close();
    },
  };
};
