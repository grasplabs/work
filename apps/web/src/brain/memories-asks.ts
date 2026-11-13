import { failureText } from "@grasp-os/shared/errors";
import { useEffect, useRef, useState } from "react";

import { useCoreRead } from "../apps/use-core-read.ts";
import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";

// How the Memories page (memories-page.tsx) asks core anything: every
// reply on the page goes through one of these two, each tied to the key
// of what it was asked for (a list as read at one change, an open entity,
// one opening of the correction dialog). A reply for a key that is no
// longer current is dropped whole, its answer, its waiting and its error
// alike, so nothing the person moved on from lands on what they see now.
// First pages are read with the app's own keyed read (`useCoreRead`);
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

/** An ask's own state, for the key it was asked for. */
type Asking =
  | { key: string; state: "busy" }
  | { key: string; state: "refused"; message: string }
  | { key: string; state: "done" };

/**
 * Asks core for `key`, the thing the asking is about: `ask` sends one
 * call and hands its answer to `onAnswer` only while `key` is still the
 * current one; `busy` and `failure` are this key's alone, so a change of
 * key shows neither of an older ask's.
 */
export const useAsk = (key: string) => {
  const core = useCore();
  // The key now, for an answer that arrives after a render moved on.
  const current = useRef(key);
  useEffect(() => {
    current.current = key;
  }, [key]);
  const [asking, setAsking] = useState<Asking>();
  const ask = async <T>(
    call: (memories: Memories) => Promise<T>,
    onAnswer: (answer: T) => void
  ): Promise<void> => {
    const asked = key;
    setAsking({ key: asked, state: "busy" });
    const answer = await answerOf(core, call);
    if (current.current !== asked) {
      return;
    }
    if (answer.state === "refused") {
      setAsking({ key: asked, state: "refused", message: answer.message });
      return;
    }
    setAsking({ key: asked, state: "done" });
    onAnswer(answer.data);
  };
  const mine = asking?.key === key ? asking : undefined;
  return {
    busy: mine?.state === "busy",
    failure: mine?.state === "refused" ? mine.message : undefined,
    ask,
  };
};

/** A page of a listing, as `usePaged` takes one: its rows and where it goes on. */
export interface Page<T, N> {
  items: readonly T[];
  next: N | null;
}

/**
 * A listing read for `key` (a list as read at one change) a page at a
 * time: the first with `useCoreRead`, held under `scope` while a newer
 * key is read so it doesn't blink; further pages with `useAsk`, so one
 * asked for an older key lands nowhere, nor do its waiting and its error.
 * Rows are kept once each, by `keyOf`.
 */
export const usePaged = <T, N>(
  key: string,
  scope: string,
  read: (memories: Memories, next?: N) => Promise<Page<T, N>>,
  keyOf: (item: T) => string
) => {
  const first: Loaded<Page<T, N>> | undefined = useCoreRead(
    key,
    async (session) => await read(session.brainMemories),
    scope
  );
  const [further, setFurther] = useState<{
    key: string;
    items: readonly T[];
    next: N | null;
  }>();
  const { busy, failure, ask } = useAsk(key);
  const firstPage = first?.state === "ready" ? first.data : undefined;
  const mine = further?.key === key ? further : undefined;
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
    if (next === null) {
      return;
    }
    void ask(
      async (memories) => await read(memories, next),
      (page) => {
        setFurther((now) => ({
          key,
          items: [...(now?.key === key ? now.items : []), ...page.items],
          next: page.next,
        }));
      }
    );
  };
  return { first, items, next, showMore, busy, failure };
};
