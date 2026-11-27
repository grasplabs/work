import type { ChatMessage } from "@grasp-os/shared/chat";
import { useMessageScroller } from "@grasp-os/ui/components/message-scroller";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { isConnectionFailure } from "../core.ts";
import { useCore } from "../use-core.ts";
import { useTabShown } from "../use-tab-shown.ts";
import { readTo } from "./chat-watch.ts";

// Where the person has read a chat to, as Slack and Linear keep it: one
// place per chat, on core (`ChatsApi.markRead`), so it holds on every
// device. An answer stored after it is unread: the sidebar's dot, once
// the agent is done. A chat open in front of them, its tab shown, is read
// as it opens and again each time an answer ends there, so an answer they
// watch arrive is never unread. Opened with answers they hadn't seen, the
// thread draws a New line over the first of them, decided once as it
// opens and kept while it stays open: reading it moves nothing, and the
// next time the chat opens it is gone. Their own questions are never news.
// A chat made before chats kept this counts as read.

/**
 * The first answer stored after `seenUpTo`, the last message the person
 * had seen (0 for none): the New line goes over it. Only the agent's
 * answers count, never the person's own questions; none when every answer
 * was seen, and none for null, a chat made before chats kept where their
 * person read to, which counts as read.
 */
export const firstUnseenAnswer = (
  messages: readonly ChatMessage[],
  seenUpTo: number | null
): number | undefined =>
  seenUpTo === null
    ? undefined
    : messages.find(
        (message) => message.role === "assistant" && message.id > seenUpTo
      )?.id;

/** What the chat's open thread draws of where the person had read to. */
export interface NewLine {
  /**
   * Whether it is decided: until core said where they had read to, the
   * thread stays loading, so it opens where the line is.
   */
  decided: boolean;
  /** The answer the New line goes over; none when nothing was unread. */
  before: number | undefined;
}

/** The newest answer in `messages`, if any. */
const latestAnswer = (messages: readonly ChatMessage[]): number | undefined =>
  messages.findLast(({ role }) => role === "assistant")?.id;

/**
 * An opening's line, once it can be decided: none while the agent works
 * (the person watches that answer come), else from where core said they
 * had read to (`seenUpTo`; `false` when it couldn't say), with the newest
 * answer core marked read as it answered. Undefined until the thread has
 * loaded and core has answered.
 */
const lineOf = (
  view: {
    messages: readonly ChatMessage[];
    running: boolean;
    loaded: boolean;
    stale?: boolean;
    resuming?: boolean;
  },
  seenUpTo: number | null | false | undefined
): { before: number | null; read: number } | undefined => {
  // A kept view says nothing of what came since, nor one behind after a
  // dropped connection: the chat as core has it now decides.
  if (!view.loaded || view.stale === true || view.resuming === true) {
    return undefined;
  }
  if (view.running) {
    return { before: null, read: 0 };
  }
  if (seenUpTo === undefined) {
    return undefined;
  }
  if (seenUpTo === false) {
    return { before: null, read: 0 };
  }
  return {
    before: firstUnseenAnswer(view.messages, seenUpTo) ?? null,
    read: latestAnswer(view.messages) ?? 0,
  };
};

/**
 * Where the person had read to, for opening `count`: core's answer to its
 * mark; for the first line, until that answer comes, where core's watch
 * said they had read to as it began (`seenUpTo`).
 */
const seenUpToFor = ({
  reply,
  count,
  decided,
  watched,
}: {
  reply: { count: number; seenUpTo: number | null | false } | undefined;
  count: number;
  /** Whether a line was decided already. */
  decided: boolean;
  /** Where core's watch said they had read to (`seenUpTo`). */
  watched: number | null | undefined;
}): number | null | false | undefined => {
  if (reply?.count === count) {
    return reply.seenUpTo;
  }
  return decided ? undefined : watched;
};

/** The tab's watch of chat `id` is told it was read up to `upTo`. */
const told = (id: string, upTo: number | undefined): void => {
  if (upTo !== undefined) {
    readTo(id, upTo);
  }
};

/**
 * Marks `chatId` read while the person looks at it, and gives the New line
 * its thread draws: over the first answer they hadn't seen as it opened
 * (`view`, once loaded), for as long as it stays open. They look at it
 * while it is `seen` (a chat's page; the dock while it is open, never
 * while it is closed to its bar) and the tab is shown.
 *
 * The first open is decided from where core's watch said they had read
 * to as it began (`seenUpTo`, its first update), so the thread opens where
 * the line is with nothing more to wait for; without it, the thread stays
 * loading until the mark's answer, unseen. A chat whose agent
 * works as it opens draws no line and waits for nothing (the person
 * watches that answer come, and it is read as it ends). Closed (`seen`
 * false) and opened again, the thread stays as it was, its rows, scroll
 * and cards, and only the line is decided again, from core's new answer:
 * gone when nothing came meanwhile. Coming back to the tab opens it again
 * too: an answer that ended while the tab was hidden is read only then,
 * with the line over it, as the person has not seen it; with nothing new,
 * the line stays where it was. A failed mark draws none, and the chat
 * stays unread. One chat a mount: its caller keys it.
 */
export const useNewLine = (
  chatId: string | undefined,
  view: {
    messages: readonly ChatMessage[];
    running: boolean;
    loaded: boolean;
    /** Where core's watch said they had read to as the tab began to follow it. */
    seenUpTo?: number | null;
    /** Whether it is the tab's last view of the chat, not core's yet. */
    stale?: boolean;
    /** Whether the tab follows it again after a dropped connection, not heard back yet. */
    resuming?: boolean;
  },
  seen: boolean
): NewLine => {
  const core = useCore();
  const looking = useTabShown() && seen;
  // Each time it is looked at again (opened again, or its tab shown
  // again) counts up: a reply core gives an earlier opening never decides
  // a later one's line. Whether this one is only the tab shown again.
  // Whether it opened on the tab's kept view of the chat (chat-watch.ts):
  // the mark then went out before the watch began, and only its answer
  // says where they had read to.
  const [opening, setOpening] = useState({
    count: 0,
    looking,
    seen,
    byTab: false,
    fromKept: view.stale === true,
  });
  if (opening.looking !== looking) {
    setOpening({
      ...opening,
      count: looking ? opening.count + 1 : opening.count,
      looking,
      seen,
      byTab: seen === opening.seen,
    });
  }
  const { count, byTab, fromKept } = opening;
  // Where core said they had read to, for the opening that asked: a
  // number or null, or `false` when it couldn't say.
  const [reply, setReply] = useState<{
    count: number;
    seenUpTo: number | null | false;
  }>();
  // The line, decided once for each opening: the answer it goes over, or
  // null for none, and the newest answer core marked read as it answered.
  // Undefined before the first opening was decided.
  const [line, setLine] = useState<{
    count: number;
    before: number | null;
    read: number;
  }>();
  // The opening that asked core, and the latest answer marked read since
  // an answer ended.
  const asked = useRef(-1);
  const marked = useRef(0);
  // Read up to the newest message the page shows, never past it: its row
  // loses its dot, here and on every device, as core pushes it. Answers
  // where they had read to before, and what it read up to, which the
  // tab's watch of the chat is told once the line is decided (`readTo`).
  const mark = useEffectEvent(
    async (
      id: string
    ): Promise<{ before: number | null; upTo: number | undefined }> => {
      const upTo = view.messages.at(-1)?.id;
      const before = await core.withSession(
        async (session) => await session.chats.markRead(id, upTo)
      );
      return { before, upTo };
    }
  );
  // Only once the page has the chat's messages, and has them as they are
  // now: not the tab's kept view (chat-watch.ts), nor following it again
  // after a dropped connection, when what came meanwhile isn't there yet.
  // A watch core refused (too many open, say) shows nothing, so nothing
  // is read.
  const loaded = view.loaded && view.stale !== true && view.resuming !== true;
  /** Whether the chat is being followed again after a dropped connection now. */
  const behind = useEffectEvent((): boolean => view.resuming === true);
  useEffect(() => {
    if (
      chatId === undefined ||
      !looking ||
      !loaded ||
      asked.current === count
    ) {
      return;
    }
    asked.current = count;
    void (async () => {
      try {
        const { before, upTo } = await mark(chatId);
        setReply({ count, seenUpTo: before });
        told(chatId, upTo);
      } catch (error) {
        // The connection dropped on the way, and the chat is being
        // followed again: asked again once it is. Else no line, and the
        // chat stays unread.
        if (isConnectionFailure(error) && behind()) {
          asked.current = -1;
          return;
        }
        setReply({ count, seenUpTo: false });
      }
    })();
  }, [chatId, looking, loaded, count]);
  // The first line needs no mark's answer: core's watch said where they
  // had read to as it began, and the thread shows at once. The mark still
  // goes, and decides each later opening's line.
  const known = seenUpToFor({
    reply,
    count,
    decided: line !== undefined,
    watched: fromKept ? undefined : view.seenUpTo,
  });
  const next = line?.count === count ? undefined : lineOf(view, known);
  if (next !== undefined) {
    // Back on the tab with nothing new: the line stays where it was.
    setLine({
      count,
      ...next,
      before: next.before ?? (byTab ? (line?.before ?? null) : null),
    });
  }
  // An answer that ends while the person looks is read at once: no dot,
  // no line.
  const latest = view.running ? undefined : latestAnswer(view.messages);
  const decided = line !== undefined;
  // This opening's line is decided: core marked it read as it answered.
  const current = line?.count === count;
  const read = line?.read ?? 0;
  useEffect(() => {
    if (
      chatId === undefined ||
      !current ||
      !looking ||
      latest === undefined ||
      latest <= Math.max(marked.current, read)
    ) {
      return;
    }
    marked.current = latest;
    void (async () => {
      try {
        const { upTo } = await mark(chatId);
        told(chatId, upTo);
      } catch {
        // Still unread on core: marked again as the next answer ends, or
        // the next time the chat opens.
      }
    })();
  }, [chatId, current, looking, latest, read]);
  // The line last decided, until the next opening's is: it never blinks
  // out while core answers.
  return { decided, before: line?.before ?? undefined };
};

/** The New line's row in the thread (`MessageScrollerItem`'s `messageId`). */
export const newLineRow = "new";

/**
 * Whether the thread opens at its New line, rather than at its end as
 * ever: only when what is unread, from the line down (`lineTop` of the
 * rows' `height`, in pixels), is taller than the view. What fits opens at
 * the end, so the person never lands past what they hadn't read, nor
 * scrolls for nothing.
 */
export const opensAtNewLine = ({
  lineTop,
  height,
  view,
}: {
  lineTop: number;
  height: number;
  view: number;
}): boolean => height - lineTop > view;

/**
 * Whether `row` is drawn, not skipped while out of view
 * (`content-visibility: auto`): undefined for a row with nothing in it, or
 * where the browser can't say.
 */
const drawn = (row: Element | null | undefined): boolean | undefined =>
  row?.firstElementChild?.checkVisibility({ contentVisibilityAuto: true });

/**
 * Opens the thread `logId` (its MessageScrollerViewport) at its New line,
 * near the top with the log's own room over it (its scroll padding), when
 * what is unread doesn't fit (`opensAtNewLine`); else it stays at the end,
 * where it opened. At once, never animated. Once the browser has drawn
 * the rows in view, not while every row still has a skipped row's size,
 * as their size changes: before the page is painted, so nothing shows the
 * end first. Each line once: a chat opened again in the dock
 * with a new line is placed at it, one without stays where it was. Inside
 * the thread's MessageScrollerProvider.
 */
export const OpenAtNewLine = ({
  logId,
  line,
}: {
  logId: string;
  /** The answer the line goes over, once the thread is loaded; none without a line. */
  line: number | undefined;
}): null => {
  const { scrollToMessage } = useMessageScroller();
  // The line placed last: each line is placed once.
  const placed = useRef<number | null>(null);
  const place = useEffectEvent((log: HTMLElement): boolean => {
    const rows = [...log.querySelectorAll<HTMLElement>("[data-message-id]")];
    const at = rows.findIndex((row) => row.dataset.messageId === newLineRow);
    const row = rows[at];
    // Until the browser has drawn any row, sizes are a skipped row's
    // stand-in: the first frame after the thread loads.
    if (row === undefined || !rows.some((each) => drawn(each) === true)) {
      return false;
    }
    // Measured when the rows from the line to the end are drawn: the view
    // stands at the end, and the line is near it. Else the line lies
    // further from the view than the browser draws, above the end or
    // above a place the person scrolled back to before the dock closed:
    // gone to at once. Where it fits after all, the log stops at its end.
    const near = drawn(rows[at + 1]) !== false && drawn(rows.at(-1)) !== false;
    const lineTop =
      row.getBoundingClientRect().top -
      log.getBoundingClientRect().top +
      log.scrollTop;
    if (
      !near ||
      opensAtNewLine({
        lineTop,
        height: log.scrollHeight,
        view: log.clientHeight,
      })
    ) {
      // The scroll padding is a computed length, in pixels ("64px").
      // oxlint-disable-next-line unicorn/prefer-number-coercion -- Number() reads no unit
      const room = Number.parseFloat(getComputedStyle(log).scrollPaddingTop);
      scrollToMessage(newLineRow, {
        scrollMargin: Number.isFinite(room) ? room : 0,
      });
    }
    return true;
  });
  useLayoutEffect(() => {
    const log = document.querySelector<HTMLElement>(`#${CSS.escape(logId)}`);
    const rows = log?.querySelector(
      `[data-message-id="${newLineRow}"]`
    )?.parentElement;
    const sizes = new ResizeObserver(() => {
      if (log !== null && place(log)) {
        placed.current = line ?? null;
        sizes.disconnect();
      }
    });
    if (
      line !== undefined &&
      placed.current !== line &&
      rows !== undefined &&
      rows !== null
    ) {
      sizes.observe(rows);
    }
    return () => {
      sizes.disconnect();
    };
  }, [line, logId]);
  return null;
};
