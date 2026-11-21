import { messageOf } from "@grasp-os/shared/errors";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { useCore } from "../use-core.ts";

// What a chat's agent asked for and waits on a person's decision
// (connection-requests.tsx, package-requests.tsx): read from core for the
// chat, again when `version` changes (`ChatUpdate.held`: something waits,
// or no longer does) and after each decision.

/** What the page read of the chat's requests. */
type Requests<Request> =
  | { state: "loading" }
  | { state: "refused"; message: string }
  | { state: "ready"; requests: Request[] };

/** How a kind of request is listed for a chat. */
type ListRequests<Request> = (
  session: Session,
  chatId: string
) => Promise<Request[]>;

/** The chat's requests. Outside the component, as the React Compiler can't compile `try`. */
const readRequests = async <Request>(
  core: CoreConnection,
  chatId: string,
  list: ListRequests<Request>
): Promise<Requests<Request>> => {
  try {
    const requests = await core.withSession(
      async (session) => await list(session, chatId)
    );
    return { state: "ready", requests };
  } catch (error) {
    return { state: "refused", message: messageOf(error) };
  }
};

/** The chat's requests as `list` reads them, and `again` to read them once a decision is made. */
export const useChatRequests = <Request>(
  chatId: string,
  version: number,
  list: ListRequests<Request>
): { read: Requests<Request>; again: () => void } => {
  const [read, setRead] = useState<Requests<Request>>({ state: "loading" });
  const core = useCore();
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      const found = await readRequests(core, chatId, list);
      // A read for another chat, or an older one, doesn't show.
      if (current) {
        setRead(found);
      }
    };
    void load();
    return () => {
      current = false;
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
