import type { ChatMessage } from "@grasp-os/shared/chat";
import { useMessageScroller } from "@grasp-os/ui/components/message-scroller";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useCore } from "../use-core.ts";
import { tellChatsChanged } from "./chats-changed.ts";

// Where the person has read a chat to, as Slack and Linear keep it: one
// place per chat, on core (`ChatsApi.markRead`), so it holds on every
// device. An answer stored after it is unread: the sidebar's dot, once
// the agent is done. A chat open in front of them, its tab shown, is read
// as it opens and again each time an answer ends there, so an answer they
// watch arrive is never unread. Opened with answers they hadn't seen, the
// thread draws a New line over the first of them, decided once as it
// opens and kept while it stays open: reading it moves nothing, and the
// next time the chat opens it is gone. Their own questions are never news.

/**
 * The first answer stored after `seenUpTo`, the last message the person
 * had seen (none for null): the New line goes over it. Only the agent's
 * answers count, never the person's own questions; none when every answer
 * was seen.
 */
export const firstUnseenAnswer = (
  messages: readonly ChatMessage[],
  seenUpTo: number | null
): number | undefined =>
  messages.find(
    (message) => message.role === "assistant" && message.id > (seenUpTo ?? 0)
  )?.id;

/** Whether the tab is shown now, followed as it changes. */
const useTabShown = (): boolean =>
  useSyncExternalStore(
    (onChange) => {
      document.addEventListener("visibilitychange", onChange);
      return () => {
        document.removeEventListener("visibilitychange", onChange);
      };
    },
    () => document.visibilityState === "visible",
    () => false
  );

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

/**
 * Marks `chatId` read while the person looks at it, and gives the New line
 * its thread draws: over the first answer they hadn't seen as it opened
 * (`view`, once loaded), for as long as it stays open. They look at it
 * while it is `seen` (a chat's page; the dock while it is open, never
 * while it is closed to its bar) and the tab is shown: until then nothing
 * is marked and nothing decided, and the thread stays loading, unseen.
 * Closed (`seen` false), it is opened afresh the next time. A chat whose
 * agent works as it opens decides no line: the person watches that answer
 * come, and it is read as it ends. A failed mark draws none, and the chat
 * stays unread. One chat a mount: its caller keys it by chat.
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
  // Where core said they had read to as the chat opened: a number or
  // null, or `false` when it couldn't say; undefined until it answered.
  const [opened, setOpened] = useState<number | null | false>();
  // The answer the line goes over, decided once as the chat opens; null
  // for none, undefined until decided.
  const [line, setLine] = useState<number | null>();
  // Whether it was marked as it opened, and the latest answer marked since.
  const asked = useRef(false);
  const marked = useRef(0);
  const mark = useEffectEvent(async (id: string): Promise<number | null> => {
    const before = await core.withSession(
      async (session) => await session.chats.markRead(id)
    );
    // Its row loses its dot.
    tellChatsChanged();
    return before;
  });
  // Closed: the next time it is seen, it opens afresh.
  if (!seen && (opened !== undefined || line !== undefined)) {
    setOpened(undefined);
    setLine(undefined);
  }
  useEffect(() => {
    if (!seen) {
      asked.current = false;
      marked.current = 0;
    }
    if (chatId === undefined || !looking || asked.current) {
      return;
    }
    asked.current = true;
    void (async () => {
      try {
        setOpened(await mark(chatId));
      } catch {
        setOpened(false);
      }
    })();
  }, [chatId, looking, seen]);
  // Decided once the thread has loaded and core has answered.
  if (line === undefined && view.loaded && opened !== undefined) {
    setLine(
      opened === false || view.running
        ? null
        : (firstUnseenAnswer(view.messages, opened) ?? null)
    );
  }
  const decided = line !== undefined;
  // An answer that ends while the person looks is read at once: no dot,
  // no line.
  const latest = view.running
    ? undefined
    : view.messages.findLast(({ role }) => role === "assistant")?.id;
  useEffect(() => {
    if (
      chatId === undefined ||
      !decided ||
      !looking ||
      latest === undefined ||
      latest <= marked.current
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
  }, [chatId, decided, looking, latest]);
  return { decided, before: line ?? undefined };
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
 * (`content-visibility: auto`); drawn where the browser can't say.
 */
const drawn = (row: Element | null | undefined): boolean =>
  row?.firstElementChild?.checkVisibility({ contentVisibilityAuto: true }) ??
  true;

/**
 * Opens the thread `logId` (its MessageScrollerViewport) at its New line,
 * near the top with the log's own room over it (its scroll padding), when
 * what is unread doesn't fit (`opensAtNewLine`); else it stays at the end,
 * where it opened. At once, never animated. Once the rows are laid out at
 * their size, not the size a row out of view is given before it is first
 * drawn, as their size changes: before the page is painted, so nothing
 * shows the end first. Inside the thread's MessageScrollerProvider; a
 * thread without the line, or one placed already, is left alone.
 */
export const OpenAtNewLine = ({
  logId,
  line,
}: {
  logId: string;
  line: boolean;
}): null => {
  const { scrollToMessage } = useMessageScroller();
  const placed = useRef(false);
  const place = useEffectEvent((log: HTMLElement): boolean => {
    const row = log.querySelector(`[data-message-id="${newLineRow}"]`);
    // Until the browser has drawn the rows in view, at the end, sizes are
    // a skipped row's stand-in.
    const items = [...(log.firstElementChild?.children ?? [])];
    const last = items.findLast((item) => item.firstElementChild !== null);
    if (row === null || !drawn(last)) {
      return false;
    }
    // The answer under the line is drawn when it is near the view: then
    // measured. Not drawn, it lies further up than that, so what is unread
    // is taller than the view.
    const near = drawn(row.nextElementSibling);
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
    // Placed again once the thread has a line again (closed and opened).
    if (!line) {
      placed.current = false;
    }
    const log = document.querySelector<HTMLElement>(`#${CSS.escape(logId)}`);
    const rows = log?.firstElementChild;
    const sizes = new ResizeObserver(() => {
      if (log !== null && place(log)) {
        placed.current = true;
        sizes.disconnect();
      }
    });
    if (line && !placed.current && rows !== undefined && rows !== null) {
      sizes.observe(rows);
    }
    return () => {
      sizes.disconnect();
    };
  }, [line, logId]);
  return null;
};
