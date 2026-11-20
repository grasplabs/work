// The comments panel: every thread on the file, in the order of the file, each with the words it
// holds on to, its comments, a reply and resolve. Threads whose words have changed or gone are
// listed apart. The viewer stores nothing: a new comment, a reply or a resolve is handed to the
// caller, who passes the threads back.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  startTransition,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode, RefObject } from "react";

import type { PlacedThread } from "../artifact-viewer/extras";
import type {
  ArtifactViewerLabels,
  CommentAuthor,
  CommentItem,
  CommentThread,
} from "../artifact-viewer/types";
import { Avatar, AvatarFallback, AvatarImage } from "../avatar/avatar";
import { BarClose } from "../bar-actions/bar-actions";
import { Button } from "../button/button";
import { Empty, EmptyHeader, EmptyDescription } from "../empty/empty";
import { Field, FieldLabel } from "../field";
import { Tick, Undo } from "../icons";
import { scroll } from "../scroll/scroll";
import { Switch } from "../switch/switch";
import { Textarea } from "../textarea/textarea";
import { grasp, media } from "../tokens/tokens.stylex";

const NARROW = "@container viewer (max-width: 560px)";

const styles = stylex.create({
  panel: {
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr)",
    boxSizing: "border-box",
    // An absolute box in a grid is placed in its grid area: in a narrow viewer, all of it.
    gridColumn: { default: 3, [NARROW]: "1 / -1" },
    gridRow: 1,
    width: { default: grasp.viewerPanelWidth, [NARROW]: "100%" },
    minHeight: 0,
    // Beside the document; in a narrow viewer, over it, as a sheet.
    position: { default: "relative", [NARROW]: "absolute" },
    insetBlock: { default: null, [NARROW]: 0 },
    insetInline: { default: null, [NARROW]: 0 },
    zIndex: { default: null, [NARROW]: 3 },
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftMedium,
    fontFamily: grasp.fontSans,
    color: grasp.text,
    outline: {
      default: "none",
      [media.forced]: `${grasp.hairline} solid CanvasText`,
    },
  },
  head: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    paddingBlock: grasp.space2,
    paddingInline: `${grasp.space4} ${grasp.space2}`,
    boxShadow: `inset 0 calc(-1 * ${grasp.hairline}) 0 ${grasp.line}`,
  },
  title: {
    margin: 0,
    flexGrow: 1,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  // Room at its foot for the line an edit leaves along the bottom (Undo), which may lie over it.
  body: {
    overflow: "auto",
    overscrollBehavior: "auto",
    padding: grasp.space3,
    paddingBlockEnd: grasp.space12,
    display: "grid",
    alignContent: "start",
    gap: grasp.space3,
  },
  group: {
    margin: 0,
    marginBlockStart: grasp.space2,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    color: grasp.muted,
  },
  thread: {
    display: "grid",
    gap: grasp.space2,
    padding: grasp.space3,
    borderRadius: grasp.cornerMark,
    backgroundColor: {
      default: "transparent",
      ":is([aria-current=true])": grasp.soft,
    },
    boxShadow: grasp.edge,
  },
  resolved: { opacity: 0.72 },
  // The words it holds on to: a quote, two lines at most, tinted as they are in the file.
  quote: {
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
    margin: 0,
    paddingInline: grasp.space2,
    paddingBlock: grasp.space1,
    borderRadius: grasp.cornerMark,
    borderWidth: 0,
    width: "100%",
    textAlign: "start",
    fontFamily: "inherit",
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.ink,
    backgroundColor: grasp.viewerComment,
    cursor: "pointer",
    outline: {
      default: "none",
      ":focus-visible": `${grasp.ringWidth} solid ${grasp.ring}`,
    },
    outlineOffset: grasp.ringOffset,
  },
  quoteActive: { backgroundColor: grasp.viewerCommentActive },
  item: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    columnGap: grasp.space2,
    alignItems: "start",
  },
  who: {
    display: "flex",
    alignItems: "baseline",
    gap: grasp.space2,
    minWidth: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  name: {
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  time: { color: grasp.muted, fontSize: grasp.textXs, flexShrink: 0 },
  words: {
    margin: 0,
    gridColumn: 2,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  actions: { display: "flex", flexWrap: "wrap", gap: grasp.space1 },
  second: { gridColumn: 2 },
  form: { display: "grid", gap: grasp.space2 },
  formActions: { display: "flex", gap: grasp.space2, justifyContent: "end" },
});

// "3 days ago", with the full date on hover.
const When = ({
  at,
  labels,
}: {
  at: CommentItem["at"];
  labels: ArtifactViewerLabels;
}) => {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return (
    <time
      dateTime={date.toISOString()}
      title={labels.date(date)}
      {...stylex.props(styles.time)}
    >
      {labels.ago(date)}
    </time>
  );
};

// Escape lets a comment box go. Returns the clean-up.
const cancelOnEscape = (form: HTMLFormElement | null, onCancel: () => void) => {
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };
  form?.addEventListener("keydown", escape);
  return () => {
    form?.removeEventListener("keydown", escape);
  };
};

// A comment box: Cmd or Ctrl+Enter sends, Escape lets it go.
const Compose = ({
  label,
  send,
  cancel,
  onSend,
  onCancel,
  autoFocus = false,
}: {
  label: string;
  send: string;
  cancel: string;
  onSend: (body: string) => void;
  onCancel: () => void;
  autoFocus?: boolean;
}) => {
  const [body, setBody] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) {
      field.current?.focus();
    }
  }, [autoFocus]);
  useEffect(() => cancelOnEscape(form.current, onCancel), [onCancel]);
  return (
    <form
      ref={form}
      {...stylex.props(styles.form)}
      onSubmit={(event) => {
        event.preventDefault();
        if (body.trim()) {
          onSend(body.trim());
        }
        setBody("");
      }}
    >
      <Textarea
        ref={field}
        aria-label={label}
        placeholder={label}
        rows={2}
        value={body}
        onValueChange={(value) => {
          setBody(value);
        }}
        submitShortcut="mod+enter"
      />
      <div {...stylex.props(styles.formActions)}>
        <Button variant="ghost" size="sm" type="button" onClick={onCancel}>
          {cancel}
        </Button>
        <Button variant="ink" size="sm" type="submit" disabled={!body.trim()}>
          {send}
        </Button>
      </div>
    </form>
  );
};

export interface CommentsPanelProps {
  labels: ArtifactViewerLabels;
  threads: readonly PlacedThread[];
  active: string | null;
  showResolved: boolean;
  onShowResolved: (show: boolean) => void;
  /** A comment being written on new words: the words. */
  draft: string | null;
  author?: CommentAuthor;
  onComment: (body: string) => void;
  onCancelDraft: () => void;
  onOpen: (id: string) => void;
  onReply: (id: string, body: string) => void;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete?: (threadId: string, itemId: string) => void;
  onClose: () => void;
  /** At the top: a web page's preview note, an agent's edits on no thread. */
  note?: ReactNode;
  /** Under a thread's comments: an agent's proposed edit on it. */
  extra?: (threadId: string) => ReactNode;
}

interface ThreadActs {
  open: (id: string) => void;
  remove?: (threadId: string, itemId: string) => void;
  startReply: (id: string) => void;
  reply: (id: string, body: string) => void;
  cancelReply: (id: string) => void;
  resolve: (thread: CommentThread) => void;
}

interface ThreadCardProps {
  thread: CommentThread;
  quote: string;
  active: boolean;
  replying: boolean;
  deletable: boolean;
  extra: ReactNode;
  acts: RefObject<ThreadActs | null>;
  labels: ArtifactViewerLabels;
}

// One thread in the panel. Drawn again only when its own thread, words or state change.
const ThreadCard = ({
  thread,
  quote,
  active,
  replying,
  deletable,
  extra,
  acts,
  labels,
}: ThreadCardProps) => {
  const [first] = thread.items;
  return (
    <article
      // Focus comes here after a reply or a new comment, and to the next one after a resolve.
      tabIndex={-1}
      aria-current={active || undefined}
      aria-label={labels.thread(first?.author.name, quote)}
      data-thread={thread.id}
      {...stylex.props(
        styles.thread,
        thread.resolved === true && styles.resolved
      )}
    >
      <button
        type="button"
        onClick={() => {
          acts.current?.open(thread.id);
        }}
        title={labels.showInFile}
        {...stylex.props(styles.quote, active && styles.quoteActive)}
      >
        {quote}
      </button>
      {thread.items.map((item) => (
        <div key={item.id} {...stylex.props(styles.item)}>
          <Avatar name={item.author.name} size="xs" decorative>
            <AvatarImage src={item.author.avatar} />
            <AvatarFallback />
          </Avatar>
          <div {...stylex.props(styles.who)}>
            <span {...stylex.props(styles.name)}>{item.author.name}</span>
            <When at={item.at} labels={labels} />
          </div>
          <p {...stylex.props(styles.words)}>{item.body}</p>
          {deletable ? (
            <div {...stylex.props(styles.second)}>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => acts.current?.remove?.(thread.id, item.id)}
              >
                {labels.delete}
              </Button>
            </div>
          ) : null}
        </div>
      ))}
      {extra}
      {replying ? (
        <Compose
          label={labels.yourReply}
          send={labels.reply}
          cancel={labels.cancel}
          autoFocus
          onSend={(body) => {
            acts.current?.reply(thread.id, body);
          }}
          onCancel={() => {
            acts.current?.cancelReply(thread.id);
          }}
        />
      ) : (
        <div {...stylex.props(styles.actions)}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              acts.current?.startReply(thread.id);
            }}
          >
            {labels.reply}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={thread.resolved === true ? Undo : Tick}
            onClick={() => {
              acts.current?.resolve(thread);
            }}
          >
            {thread.resolved === true ? labels.reopen : labels.resolve}
          </Button>
        </div>
      )}
    </article>
  );
};

const EMPTY: readonly PlacedThread[] = [];
// How many threads the panel adds to its list in a frame.
const SLICE = 6;

export const CommentsPanel = (props: CommentsPanelProps) => {
  const { labels } = props;
  const titleId = useId();
  const [replying, setReplying] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  // Where focus goes once the list has changed: a thread by its id, or "" for the panel itself.
  const focusing = useRef<string | null>(null);
  const focusLater = (id: string) => {
    focusing.current = id;
  };
  useEffect(() => {
    const id = focusing.current;
    if (id === null) {
      return;
    }
    const target = id
      ? panel.current?.querySelector<HTMLElement>(
          `[data-thread="${CSS.escape(id)}"]`
        )
      : null;
    if (id && !target) {
      return;
    }
    focusing.current = null;
    (target ?? panel.current)?.focus();
  });
  // The list is drawn in the background, in slices React can pause: a panel of hundreds of threads
  // opens without holding up the page. It is empty for that first moment, then grows a few threads
  // a frame, so no one frame puts them all on the page.
  const all = useDeferredValue(props.threads, EMPTY);
  const shown = all.filter(
    (placed) => props.showResolved || placed.thread.resolved !== true
  );
  const placed = shown.filter((entry) => entry.order !== null);
  const orphaned = shown.filter((entry) => entry.order === null);
  const hiddenCount = all.length - shown.length;
  const [limit, setLimit] = useState(SLICE);
  useEffect(() => {
    const frame =
      limit < shown.length
        ? requestAnimationFrame(() => {
            startTransition(() => {
              setLimit((count) => count + SLICE);
            });
          })
        : 0;
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [limit, shown.length]);

  // What a thread card does, read when it is pressed and kept up to date once drawn: the cards stay
  // as they were while the panel draws again, so a reply or a resolve draws only the threads it changed.
  const acts = useRef<ThreadActs | null>(null);
  useLayoutEffect(() => {
    acts.current = {
      open: props.onOpen,
      remove: props.onDelete,
      startReply: (id) => {
        setReplying(id);
      },
      reply: (id, body) => {
        props.onReply(id, body);
        setReplying(null);
        focusLater(id);
      },
      cancelReply: (id) => {
        setReplying(null);
        focusLater(id);
      },
      resolve: (thread) => {
        // A resolved thread leaves the list: focus goes to the next one, or the panel.
        const list = shown.map((entry) => entry.thread.id);
        const at = list.indexOf(thread.id);
        const next = props.showResolved
          ? thread.id
          : (list[at + 1] ?? list[at - 1] ?? "");
        props.onResolve(thread.id, thread.resolved !== true);
        focusLater(next);
      },
    };
  });
  const card = ({ thread, quote }: PlacedThread) => (
    <ThreadCard
      key={thread.id}
      thread={thread}
      quote={quote}
      active={props.active === thread.id}
      replying={replying === thread.id}
      deletable={Boolean(props.onDelete)}
      extra={props.extra?.(thread.id) ?? null}
      acts={acts}
      labels={labels}
    />
  );

  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-labelledby={titleId}
      data-slot="artifact-viewer-comments"
      {...stylex.props(styles.panel)}
    >
      <div {...stylex.props(styles.head)}>
        <h2 id={titleId} {...stylex.props(styles.title)}>
          {labels.comments}
        </h2>
        <Field orientation="horizontal">
          <FieldLabel>{labels.showResolved}</FieldLabel>
          <Switch
            checked={props.showResolved}
            onCheckedChange={(checked) => {
              props.onShowResolved(checked);
            }}
          />
        </Field>
        <BarClose label={labels.closeComments} onClick={props.onClose} />
      </div>
      <div {...stylex.props(styles.body, scroll.bar)}>
        {props.note}
        {props.draft === null ? null : (
          <div {...stylex.props(styles.thread)}>
            <p {...stylex.props(styles.quote, styles.quoteActive)}>
              {props.draft}
            </p>
            <Compose
              label={labels.yourComment}
              send={labels.comment}
              cancel={labels.cancel}
              autoFocus
              onSend={props.onComment}
              onCancel={props.onCancelDraft}
            />
          </div>
        )}
        {placed.slice(0, limit).map(card)}
        {orphaned.length && limit > placed.length ? (
          <>
            <h3 {...stylex.props(styles.group)}>{labels.changedOrGone}</h3>
            {orphaned.slice(0, limit - placed.length).map(card)}
          </>
        ) : null}
        {!shown.length && props.draft === null ? (
          <Empty size="sm">
            <EmptyHeader>
              <EmptyDescription>
                {hiddenCount
                  ? labels.resolvedHidden(hiddenCount)
                  : labels.noComments}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
      </div>
    </aside>
  );
};
