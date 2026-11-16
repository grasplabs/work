import { failureText } from "@grasp-os/shared/errors";
import { useEffect, useRef, useState } from "react";

import { useHeldCoreRead } from "../apps/use-core-read.ts";
import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { useCore } from "../use-core.ts";

// How the Memories page (memories-page.tsx) asks core anything: every
// reply on the page goes through one of these two, each tied to the key
// of what it was asked for (a list as read at one change, an open entity,
// one opening of the correction dialog). A reply for a key that is no
// longer current is dropped whole, its answer, its waiting and its error
// alike, so nothing the person moved on from lands on what they see now.
// First pages are read with the app's own keyed read (`useHeldCoreRead`);
// actions and further pages with `useAsk`.

/** The person's memories, as the page reaches them. */
export type Memories = Session["brainMemories"];

/** What an ask came to: core's answer, or why not. */
type Answer<T> =
  | { state: "ready"; data: T }
  | { state: "refused"; message: string };

/**
 * What `call` answers on the person's session, or why not. Outside the
 * hooks, as the React Compiler can't compile `try`.
 */
const answerOf = async <T>(
  core: CoreConnection,
  call: (memories: Memories) => Promise<T>
): Promise<Answer<T>> => {
  try {
    const data = await core.withSession(
      async (session) => await call(session.brainMemories)
    );
    return { state: "ready", data };
  } catch (error) {
    return { state: "refused", message: failureText(error) };
  }
};

/** An ask's own state, for the key it was asked for, and what its failure is shown with. */
type Asking =
  | { key: string; state: "busy" }
  | { key: string; state: "refused"; message: string; shownFor: string }
  | { key: string; state: "done" };

/**
 * Asks core for `key`, the thing the asking is about: `ask` sends one
 * call and hands its answer to `onAnswer` only while `key` is still the
 * current one; a second call for a key while one is out is not sent.
 * `busy` and `failure` are this key's alone, so a change of key shows
 * neither of an older ask's; a failure shows only while `shownFor` (the
 * read of the page it was made on, by default the key) is what it was.
 */
export const useAsk = (key: string, shownFor: string = key) => {
  const core = useCore();
  // The key now, for an answer that arrives after a render moved on.
  const current = useRef(key);
  useEffect(() => {
    current.current = key;
  }, [key]);
  // The key a call is out for, set as it is sent: two clicks in one tick
  // send one call.
  const out = useRef<string | null>(null);
  const [asking, setAsking] = useState<Asking>();
  const ask = async <T>(
    call: (memories: Memories) => Promise<T>,
    onAnswer: (answer: T) => void
  ): Promise<void> => {
    const asked = key;
    if (out.current === asked) {
      return;
    }
    out.current = asked;
    const failedFor = shownFor;
    setAsking({ key: asked, state: "busy" });
    const answer = await answerOf(core, call);
    if (out.current === asked) {
      out.current = null;
    }
    if (current.current !== asked) {
      return;
    }
    if (answer.state === "refused") {
      setAsking({
        key: asked,
        state: "refused",
        message: answer.message,
        shownFor: failedFor,
      });
      return;
    }
    setAsking({ key: asked, state: "done" });
    onAnswer(answer.data);
  };
  const mine = asking?.key === key ? asking : undefined;
  return {
    busy: mine?.state === "busy",
    failure:
      mine?.state === "refused" && mine.shownFor === shownFor
        ? mine.message
        : undefined,
    ask,
  };
};

/**
 * A page of a listing, as `usePaged` takes one: its rows, where it goes
 * on, and what the first page says of the whole (an entity's own name).
 */
export interface Page<T, N, H = undefined> {
  items: readonly T[];
  next: N | null;
  head?: H;
}

/**
 * A listing read for `key` (a list as read at one change) a page at a
 * time: the first with the app's keyed read (`useHeldCoreRead`), held
 * under `scope` while a newer key is read so it doesn't blink; further
 * pages with `useAsk`, so one asked for an older key lands nowhere, nor
 * do its waiting and its error. No further page is asked for while an
 * older read is held: its place to go on from is the older read's. Rows
 * are kept once each, by `keyOf`.
 */
export const usePaged = <T, N, H = undefined>(
  key: string,
  scope: string,
  read: (memories: Memories, next?: N) => Promise<Page<T, N, H>>,
  keyOf: (item: T) => string
) => {
  const {
    loaded: first,
    current,
    id,
  } = useHeldCoreRead<Page<T, N, H>>(
    key,
    async (session) => await read(session.brainMemories),
    scope
  );
  // One identity owns everything paged beyond the first page: the read of
  // that first page shown now. A list read again (a change, its kind
  // left and come back to) is a new read, so rows, the place to go on
  // from, waiting and errors of an earlier read are dropped, never merged.
  const shown = id ?? `${key}#unread`;
  const [further, setFurther] = useState<{
    read: string;
    items: readonly T[];
    next: N | null;
  }>();
  const { busy, failure, ask } = useAsk(shown);
  const firstPage = first?.state === "ready" ? first.data : undefined;
  const mine = further?.read === shown ? further : undefined;
  const seen = new Set<string>();
  const items = [...(firstPage?.items ?? []), ...(mine?.items ?? [])].filter(
    (item) => {
      const itemKey = keyOf(item);
      if (seen.has(itemKey)) {
        return false;
      }
      seen.add(itemKey);
      return true;
    }
  );
  const next = mine === undefined ? (firstPage?.next ?? null) : mine.next;
  const showMore = (): void => {
    if (next === null || !current) {
      return;
    }
    void ask(
      async (memories) => await read(memories, next),
      (page) => {
        setFurther((now) => ({
          read: shown,
          items: [...(now?.read === shown ? now.items : []), ...page.items],
          next: page.next,
        }));
      }
    );
  };
  return {
    first,
    head: firstPage?.head,
    items,
    next,
    showMore,
    // Waiting for a further page, or for this key's own first one.
    busy: busy || !current,
    failure,
  };
};
