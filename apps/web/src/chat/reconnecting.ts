import { useEffect, useState } from "react";

import { useCoreReach, useKeepAlive } from "../use-core-reach.ts";

// Whether the chat says it is reconnecting: one quiet line under the box
// (composer.tsx) while the tab's connection to core is gone, on the chat's
// page, its dock and Chat's start alike. An answer that was coming in
// picks up where it was once the connection is back (follow-chat.ts), and
// a question that couldn't leave says so and keeps its words (use-ask.ts),
// so the line is all there is to say meanwhile. While something depends on
// hearing from core (an answer coming in, a question on its way), the
// connection is asked every few seconds whether it still answers
// (`CoreConnection.keepAlive`): a socket that died without saying so is
// noticed in seconds, not when the person next clicks.

/**
 * How long the connection may be gone before the line shows, as T3 Code
 * waits before its own: a reconnect quicker than that says nothing, so a
 * blip never flashes a line.
 */
export const reconnectQuietMs = 2000;

/**
 * Whether to say the chat is reconnecting: the connection gone for longer
 * than {@link reconnectQuietMs}. Keeps it checked while `depends`.
 */
export const useReconnecting = (depends: boolean): boolean => {
  useKeepAlive(depends);
  const reach = useCoreReach();
  const lost = reach !== undefined && reach !== "reachable";
  const [waited, setWaited] = useState(false);
  if (!lost && waited) {
    setWaited(false);
  }
  useEffect(() => {
    if (!lost) {
      return () => {
        // Nothing waits.
      };
    }
    const timer = setTimeout(() => {
      setWaited(true);
    }, reconnectQuietMs);
    return () => {
      clearTimeout(timer);
    };
  }, [lost]);
  return lost && waited;
};
