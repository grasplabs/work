import type { ChatSummary } from "@grasp-os/shared/chat";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import type { SourceName } from "./sources.tsx";

// What Grasp's one chat names beside its conversation (global-chat.tsx):
// the open chat's summary, for its title and its menu, and where answers
// came from, for its sources.

/** Where answers came from, by ID. */
export interface ChatNames {
  /** The collections' and connections' names, by ID, for provenance. */
  sourceNames: ReadonlyMap<string, SourceName>;
}

/**
 * The names of the collections and connections the person can see, by
 * ID: a list refused only leaves those IDs unnamed.
 */
const readSourceNames = async (
  session: Session
): Promise<ReadonlyMap<string, SourceName>> => {
  const [collections, connections] = await Promise.allSettled([
    session.knowledge.listCollections(),
    session.connections.list(),
  ]);
  const names = new Map<string, SourceName>();
  if (collections.status === "fulfilled") {
    for (const { id, name } of collections.value) {
      names.set(id, { name, kind: "collection" });
    }
  }
  if (connections.status === "fulfilled") {
    for (const { id, provider, accountName } of connections.value) {
      names.set(id, {
        name: accountName === null ? provider : `${provider} (${accountName})`,
        kind: "connection",
      });
    }
  }
  return names;
};

/** The chat's names, as core says them (a frame read, `useFrameRead`). */
export const readChatNames = async (
  core: CoreConnection,
  signal: AbortSignal
): Promise<Loaded<ChatNames>> =>
  await loadFromCore(
    core,
    async (session) => ({ sourceNames: await readSourceNames(session) }),
    signal
  );

/**
 * The open chat's summary, read as it opens and again once a turn ends
 * (its agent may have named it); none before, or where core can't say.
 * `retitle` shows a new name the person gave it at once.
 */
export const useChatSummary = (
  chatId: string | undefined,
  running: boolean
): {
  summary: ChatSummary | undefined;
  retitle: (title: string) => void;
} => {
  const core = useCore();
  const [read, setRead] = useState<ChatSummary>();
  useEffect(() => {
    if (chatId === undefined || running) {
      return () => {
        // Nothing read.
      };
    }
    const left = new AbortController();
    const readNow = async (): Promise<void> => {
      const answer = await loadFromCore(
        core,
        async (session) => await session.chats.summary(chatId),
        left.signal
      );
      if (answer.state === "ready") {
        setRead(answer.data);
      }
    };
    void readNow();
    return () => {
      left.abort();
    };
  }, [core, chatId, running]);
  // Another chat's summary never shows.
  const summary = read?.id === chatId ? read : undefined;
  return {
    summary,
    retitle: (title) => {
      if (summary !== undefined) {
        setRead({ ...summary, title });
      }
    },
  };
};
