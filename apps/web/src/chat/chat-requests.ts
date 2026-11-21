import { useEffect, useState } from "react";

import type { Session } from "../core.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";

// What a chat's agent asked for and waits on a person's decision
// (connection-requests.tsx, package-requests.tsx): read from core for the
// chat, again when `version` changes (`ChatUpdate.held`: something waits,
// or no longer does) and after each decision.

/** How a kind of request is listed for a chat. */
type ListRequests<Request> = (
  session: Session,
  chatId: string
) => Promise<Request[]>;

/**
 * The chat's requests as `list` reads them, undefined while they come,
 * and `again` to read them once a decision is made.
 */
export const useChatRequests = <Request>(
  chatId: string,
  version: number,
  list: ListRequests<Request>
): { read: Loaded<Request[]> | undefined; again: () => void } => {
  const [read, setRead] = useState<Loaded<Request[]>>();
  const core = useCore();
  const [reads, setReads] = useState(0);
  useEffect(() => {
    const left = new AbortController();
    const load = async (): Promise<void> => {
      const found = await loadFromCore(
        core,
        async (session) => await list(session, chatId),
        left.signal
      );
      // A read for another chat, or an older one, doesn't show.
      if (!left.signal.aborted) {
        setRead(found);
      }
    };
    void load();
    return () => {
      left.abort();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `version` and `reads` say when to read again
  }, [core, chatId, list, version, reads]);
  return {
    read,
    again: () => {
      setReads(reads + 1);
    },
  };
};
