import type { ChatSummary } from "@grasp-os/shared/chat";
import { useEffect, useState } from "react";

import { connectionNames } from "../connections/integrations.ts";
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
  /** The connections' names, by ID, for provenance. */
  sourceNames: ReadonlyMap<string, SourceName>;
}

/** The catalog's entries, or none where core refused them. */
const catalogEntries = async (session: Session) => {
  try {
    const { entries } = await session.connections.catalog();
    return entries;
  } catch {
    return [];
  }
};

/**
 * The names of the connections the person can see, by ID, as the
 * Connectors page names them: a list refused only leaves those IDs
 * unnamed, a catalog refused names each by what the list says alone.
 */
const readSourceNames = async (
  session: Session
): Promise<ReadonlyMap<string, SourceName>> => {
  const names = new Map<string, SourceName>();
  try {
    const [listed, entries] = await Promise.all([
      session.connections.list(),
      catalogEntries(session),
    ]);
    for (const [id, name] of connectionNames(entries, listed)) {
      names.set(id, { name });
    }
  } catch {
    // Refused: the IDs stay unnamed.
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
 * `retitle` shows a new name the person gave chat `chatId` at once, only
 * while that chat is the one read: a rename answered after the person
 * moved to another chat never names that one.
 */
export const useChatSummary = (
  chatId: string | undefined,
  running: boolean
): {
  summary: ChatSummary | undefined;
  retitle: (chatId: string, title: string) => void;
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
    retitle: (renamed, title) => {
      setRead((now) => (now?.id === renamed ? { ...now, title } : now));
    },
  };
};
