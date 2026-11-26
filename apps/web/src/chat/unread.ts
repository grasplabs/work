import type { ChatMessage } from "@grasp-os/shared/chat";
import { useMessageScroller } from "@grasp-os/ui/components/message-scroller";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useCore } from "../use-core.ts";
import { useTabShown } from "../use-tab-shown.ts";

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
  view: { messages: readonly ChatMessage[]; running: boolean; loaded: boolean },
  seenUpTo: number | null | false | undefined
): { before: number | null; read: number } | undefined => {
  if (!view.loaded) {
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
 * Marks `chatId` read while the person looks at it, and gives the New line
 * its thread draws: over the first answer they hadn't seen as it opened
 * (`view`, once loaded), for as long as it stays open. They look at it
 * while it is `seen` (a chat's page; the dock while it is open, never
 * while it is closed to its bar) and the tab is shown.
 *
 * The first open waits for core's answer, and the thread stays loading
 * meanwhile, unseen, so it opens where the line is; a chat whose agent
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
  },
  seen: boolean
): NewLine => {
  const core = useCore();
  const looking = useTabShown() && seen;
  // Each time it is looked at again (opened again, or its tab shown
  // again) counts up: a reply core gives an earlier opening never decides
  // a later one's line. Whether this one is only the tab shown again.
  const [opening, setOpening] = useState({
    count: 0,
    looking,
    seen,
    byTab: false,
  });
  if (opening.looking !== looking) {
    setOpening({
      count: looking ? opening.count + 1 : opening.count,
      looking,
      seen,
      byTab: seen === opening.seen,
    });
  }
  const { count, byTab } = opening;
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
  const mark = useEffectEvent(
    async (id: string): Promise<number | null> =>
      // Its row loses its dot, here and on every device, as core pushes it.
      await core.withSession(
        async (session) => await session.chats.markRead(id)
      )
  );
  // Only once the page has the chat's messages: a watch core refused
  // (too many open, say) shows nothing, so nothing is read.
  const { loaded } = view;
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
        setReply({ count, seenUpTo: await mark(chatId) });
      } catch {
        setReply({ count, seenUpTo: false });
      }
    })();
  }, [chatId, looking, loaded, count]);
  const next =
    line?.count === count
      ? undefined
      : lineOf(view, reply?.count === count ? reply.seenUpTo : undefined);
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
        await mark(chatId);
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
