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
 * Marks `chatId` read while it is open here and the tab is shown, and
 * gives the New line its thread draws: over the first answer the person
 * hadn't seen as it opened (`view`, once loaded), for as long as it stays
 * open. A chat whose agent works as it opens, and a tab hidden as it
 * opens, decide no line; the hidden tab marks it read once it is shown. A
 * failed mark draws none, and the chat stays unread.
 */
export const useNewLine = (
  chatId: string | undefined,
  view: {
    messages: readonly ChatMessage[];
    running: boolean;
    loaded: boolean;
  }
): NewLine => {
  const core = useCore();
  const shown = useTabShown();
  // Where core said they had read to as the chat opened, by chat: a
  // number or null, or `false` when it couldn't say.
  const [opened, setOpened] = useState<{
    chatId: string;
    seenUpTo: number | null | false;
  }>();
  // The line, decided once for each chat as it opens.
  const [line, setLine] = useState<{
    chatId: string;
    before: number | undefined;
  }>();
  // The chat marked as it opened, and the latest answer marked since.
  const asked = useRef<string | null>(null);
  const marked = useRef<{ chatId: string; upTo: number } | null>(null);
  const mark = useEffectEvent(async (id: string): Promise<number | null> => {
    const before = await core.withSession(
      async (session) => await session.chats.markRead(id)
    );
    // Its row loses its dot.
    tellChatsChanged();
    return before;
  });
  useEffect(() => {
    if (chatId === undefined || !shown || asked.current === chatId) {
      return;
    }
    asked.current = chatId;
    void (async () => {
      try {
        setOpened({ chatId, seenUpTo: await mark(chatId) });
      } catch {
        setOpened({ chatId, seenUpTo: false });
      }
    })();
  }, [chatId, shown]);
  const decided = chatId !== undefined && line?.chatId === chatId;
  const answered =
    opened !== undefined && opened.chatId === chatId
      ? opened.seenUpTo
      : undefined;
  // Decided once the thread has loaded and core has answered, or at once
  // in a hidden tab, which waits for nobody. None while the agent works as
  // it opens: the person watches that answer come (a question they just
  // asked here, which opened the chat), and it is read as it ends.
  if (
    chatId !== undefined &&
    !decided &&
    view.loaded &&
    (answered !== undefined || !shown)
  ) {
    setLine({
      chatId,
      before:
        answered === undefined || answered === false || view.running
          ? undefined
          : firstUnseenAnswer(view.messages, answered),
    });
  }
  // An answer that ends while the chat is open and the tab shown is read
  // at once: no dot, no line.
  const latest = view.running
    ? undefined
    : view.messages.findLast(({ role }) => role === "assistant")?.id;
  useEffect(() => {
    if (chatId === undefined || !decided || !shown || latest === undefined) {
      return;
    }
    const done = marked.current?.chatId === chatId ? marked.current.upTo : 0;
    if (latest <= done) {
      return;
    }
    marked.current = { chatId, upTo: latest };
    void (async () => {
      try {
        await mark(chatId);
      } catch {
        // Still unread on core: marked again as the next answer ends, or
        // the next time the chat opens.
      }
    })();
  }, [chatId, decided, shown, latest]);
  return decided && line !== undefined
    ? { decided, before: line.before }
    : { decided: false, before: undefined };
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

/** Whether `row` is drawn, not skipped while out of view (`content-visibility: auto`). */
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
    if (row === null || !drawn(row.nextElementSibling)) {
      return false;
    }
    const lineTop =
      row.getBoundingClientRect().top -
      log.getBoundingClientRect().top +
      log.scrollTop;
    if (
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
