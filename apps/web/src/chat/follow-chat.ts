import { agentErrors } from "@grasp-os/shared/agent";
import {
  applyOutput,
  applyPartial,
  chatToolEventsKept,
} from "@grasp-os/shared/chat";
import type {
  ChatMessage,
  ChatOutput,
  ChatPartial,
  ChatProvenance,
  ChatToolEvent,
  ChatUpdate,
} from "@grasp-os/shared/chat";
import { failureText } from "@grasp-os/shared/errors";
import type { ModelWait } from "@grasp-os/shared/models";
import { RpcStub } from "capnweb";

import type { CoreConnection } from "../core-connection.ts";
import { CoreTimeoutError, isTransient, retrying } from "../core.ts";

// Following one chat as it streams (`chats.watch` in core), on the tab's
// connection, which connects again when it drops. After a drop, the watch starts
// again after the last message this page has, so nothing is missed or
// shown twice; a reload starts from the first.

/** A chat as the page shows it, put together from its updates. */
export interface ChatView {
  messages: ChatMessage[];
  /** The response being written; `null` between responses. */
  partial: ChatPartial | null;
  /** What the running code step has logged so far; `null` while none runs. */
  output: ChatOutput | null;
  /** The calls the chat's code made, oldest first: the latest core keeps. */
  tools: ChatToolEvent[];
  running: boolean;
  provenance: ChatProvenance;
  /** Why the last question stopped short; `null` once another starts. */
  stopped: string | null;
  /** Changes whenever the agent had a write held: read them again. */
  held: number;
  /** Changes whenever the agent writes an App's draft: read what it worked on again. */
  worked: number;
  /** Whether the turn checks the drafts it wrote now, past its answer. */
  checking: boolean;
  /** What the turn's model request waits on now, if anything. */
  waiting: ModelWait | null;
  /** Whether the first update has come. */
  loaded: boolean;
}

export const emptyView: ChatView = {
  messages: [],
  partial: null,
  output: null,
  tools: [],
  running: false,
  provenance: { sources: [], restricted: false },
  stopped: null,
  held: 0,
  worked: 0,
  checking: false,
  waiting: null,
  loaded: false,
};

/** `kept` with `added` merged by ID, oldest first, the latest core keeps. */
const mergedTools = (
  kept: readonly ChatToolEvent[],
  added: readonly ChatToolEvent[] | undefined
): ChatToolEvent[] => {
  if (added === undefined || added.length === 0) {
    return [...kept];
  }
  const byId = new Map(kept.map((event) => [event.id, event]));
  for (const event of added) {
    byId.set(event.id, event);
  }
  return [...byId.values()]
    .toSorted((a, b) => a.id - b.id)
    .slice(-chatToolEventsKept);
};

/** `view` with `update` applied: new messages and calls added once, in order. */
export const applyUpdate = (view: ChatView, update: ChatUpdate): ChatView => {
  const last = view.messages.at(-1)?.id ?? 0;
  return {
    messages: [
      ...view.messages,
      ...update.messages.filter(({ id }) => id > last),
    ],
    partial: applyPartial(view.partial, update.partial),
    output: applyOutput(view.output, update.output),
    tools: mergedTools(view.tools, update.tools),
    running: update.running,
    // Sent first, then only when it changes.
    provenance: update.provenance ?? view.provenance,
    stopped: update.stopped,
    held: update.held,
    worked: update.worked,
    checking: update.checking ?? false,
    waiting: update.waiting ?? null,
    loaded: true,
  };
};

/**
 * The pauses before trying again to start following while core fails: only
 * a few, so a chat whose core keeps failing says so. The first try, as the
 * chat opens, waits a few seconds for the tab's connection, and says core
 * can't be reached if none comes; a try after the connection dropped waits
 * for the next one as long as it takes, so a chat is followed again the
 * moment core is back, however long it was gone.
 */
const startRetryMs = [1000, 2000, 4000] as const;

/** Lets go of a watch; one whose connection is gone already is let go. */
const releaseQuietly = async (subscription: {
  release: () => Promise<void>;
}): Promise<void> => {
  try {
    await subscription.release();
  } catch {
    // The connection is gone, and core drops the watch with it.
  }
};

/**
 * Follows `chatId` over `core`: `onUpdate` gets every update, `onFailed`
 * why following stopped for good, and whether that is because core has no
 * such chat for the person (`gone`: deleted, or not theirs). Any other
 * refusal (too many pages following chats, say) leaves the chat theirs, and
 * only says why. Returns what stops it.
 */
export const followChat = (
  core: Pick<CoreConnection, "withSession">,
  chatId: string,
  onUpdate: (update: ChatUpdate) => void,
  onFailed: (reason: string, gone: boolean) => void
): (() => void) => {
  let closed = false;
  // Gives up waiting for a connection once following stops.
  const stopping = new AbortController();
  let after: number | null = null;
  let release: (() => void) | undefined;
  const received = (update: ChatUpdate): void => {
    const last = update.messages.at(-1);
    if (last !== undefined) {
      after = last.id;
    }
    onUpdate(update);
  };
  const watch = async (again: boolean): Promise<void> => {
    try {
      const subscription = await retrying(
        async () =>
          await core.withSession(
            async (session) =>
              await session.chats.watch(chatId, after, received),
            again ? stopping.signal : undefined
          ),
        startRetryMs,
        // No connection came in its few seconds: say so, rather than wait
        // on, as a page does when core is out of reach.
        (failure) =>
          isTransient(failure) && !(failure instanceof CoreTimeoutError)
      );
      release = () => {
        void releaseQuietly(subscription);
        subscription[Symbol.dispose]();
      };
      if (closed) {
        release();
        return;
      }
      // The connection dropped: watch again on the next, after the last
      // message this page has. Core answers the watch with a stub.
      const stub: unknown = subscription;
      if (stub instanceof RpcStub) {
        stub.onRpcBroken(() => {
          if (!closed) {
            void watch(true);
          }
        });
      }
    } catch (error) {
      if (!closed) {
        onFailed(
          failureText(error),
          agentErrors.codeOf(error) === "agent.chat_not_found"
        );
      }
    }
  };
  void watch(false);
  return () => {
    closed = true;
    stopping.abort();
    release?.();
  };
};
