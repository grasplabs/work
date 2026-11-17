// ChatMessage: one message in a conversation with an assistant, in the Composer's language. A
// person's message is a soft bubble at the end of the line; the agent's is plain words across the
// column, under its name, with a row of quiet actions once it is done. While the agent writes, the
// working mark stands under its words; when it fails, it says so and offers to try again.
//
//   <ChatMessage from="person">Which invoices are unpaid?</ChatMessage>
//   <ChatMessage from="agent" name="Assistant" copyText={answer}>{answer}</ChatMessage>
//   <ChatMessage from="agent" status="streaming">{soFar}</ChatMessage>
//   <ChatMessage from="agent" status="failed" failedLabel="Could not answer" onRetry={retry} />
//
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { Button as PressPrimitive } from "@ui-sdk/react/button";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode, RefObject } from "react";

import { AgentIndicator } from "../agent-indicator";
import { announce } from "../announce/announce";
import { Button } from "../button";
import { Collapsible } from "../collapsible";
import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { Alert, Icon, Retry, Stop } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { useArriving } from "../motion/use-arriving";
import { ArrivingContext, usePaced } from "../motion/use-paced";
import type { PacedOptions } from "../motion/use-paced";
import { Shimmer } from "../shimmer";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords as useCatalogue, withGiven } from "../words/words";
import { ChatMessageCopy } from "./copy";
import { Thoughts } from "./thoughts";
import type { ChatMessageThoughtsLook } from "./thoughts";
import { chatMessageWords } from "./words";
import type { ChatMessageWords } from "./words";

/** What a caller may style: where the message sits. Never its look. */
export type ChatMessageLayoutStyle = LayoutStyle;

/** Where an agent's message is: being written, done, stopped part way, or failed. */
export type ChatMessageStatus =
  | "thinking"
  | "streaming"
  | "done"
  | "stopped"
  | "failed";

/** Every prop a ChatMessage takes. */
export interface ChatMessageProps {
  /** Who wrote it: `person`, the one using the product, or `agent`, the assistant. */
  from: "person" | "agent";
  /** The words, or what the message holds. While streaming, what has arrived so far. */
  children?: ReactNode;
  /** The agent's name over its message ("Assistant"). A person's messages need none. */
  name?: string;
  /**
   * Keeps the name off the page while a screen reader still hears who speaks: the message stays
   * named by `name`, and no name is drawn over it. For a chat with one agent, where its name on
   * every answer is noise.
   * @default false
   */
  nameHidden?: boolean;
  /** When it was sent, as people say it ("2 min ago"), small beside the name or under the bubble. */
  time?: string;
  /** When it was sent, for machines: an ISO date and time ("2026-11-13T14:02"). */
  dateTime?: string;
  /**
   * Who a person's message is from, said to a screen reader, since a bubble has no name on it.
   * @default "You"
   */
  personLabel?: string;
  /**
   * For an agent's message: `thinking` while it works and has not begun to write, `streaming`
   * while it is written, `done` once it is, `stopped` when it was stopped part way (the words kept
   * as written, `stoppedLabel` under them, the actions still offered), `failed` if it could not be
   * written. A person's message is always done.
   * @default "done"
   */
  status?: ChatMessageStatus;
  /**
   * The words when the message failed, shown in its place ("Could not answer. Try again.").
   * @default "Could not answer"
   */
  failedLabel?: string;
  /** Tries again after a failure. Without it there is no Try again. */
  onRetry?: () => unknown;
  /**
   * The words on Try again.
   * @default "Try again"
   */
  retryLabel?: string;
  /** The words Copy puts on the clipboard. Without it there is no Copy. */
  copyText?: string;
  /** More actions, after Copy: ChatMessageAction. For the agent once its message is done; for a person, under the bubble (Edit). */
  actions?: ReactNode;
  /**
   * The name of the row of actions.
   * @default "Message actions"
   */
  actionsLabel?: string;
  /**
   * Copy's name, and its words when it worked and when it did not.
   * @default { copy: "Copy", copied: "Copied", failed: "Could not copy" }
   */
  copyLabels?: { copy: string; copied: string; failed: string };
  /**
   * The words said to a screen reader while the agent writes.
   * @default "Writing"
   */
  streamingLabel?: string;
  /**
   * The words said to a screen reader when the agent has finished writing.
   * @default "Answer ready"
   */
  doneLabel?: string;
  /**
   * The words under a message that was stopped part way, said to a screen reader when it stops.
   * @default "Stopped"
   */
  stoppedLabel?: string;
  /**
   * A working mark under the words while the agent writes. Off by default: while text arrives
   * there is nothing but the text, and before the first word the thinking line stands in.
   * @default false
   */
  streamingMark?: boolean;
  /**
   * What the agent is doing while it is `thinking`, shown as a line the light crosses and said
   * once to a screen reader: its current step ("Searching 3 sources") where there is one.
   * @default "Thinking"
   */
  thinkingLabel?: string;
  /**
   * What that line settles to once the thinking has ended, from how many seconds it took.
   * @default (seconds) => `Thought for ${seconds} seconds`
   */
  thoughtLabel?: (seconds: number) => string;
  /**
   * The agent's thoughts, as much as has arrived: the thinking line then opens to them, small and
   * quiet, set apart from the answer. Closed at first, and closed again when the answer starts.
   * Words are drawn through Markdown: a line that is only bold (the model's step title) becomes a
   * small label over its note; lists and code in a sentence are drawn, never raw marks.
   */
  thoughts?: ReactNode;
  /**
   * How the opened thoughts stand apart from the answer: a hairline down their start edge, a soft
   * sunken panel, or a slim timeline of steps. A study for Ruben to pick from; one stays.
   * @default "rule"
   */
  thoughtsLook?: ChatMessageThoughtsLook;
  /**
   * How long the thinking took, in seconds, for a message that is drawn after it ended (from
   * history). While a message is on the page as it thinks, it times itself.
   */
  thoughtSeconds?: number;
  /**
   * How fast the words of a message still being written come: `calm`, `steady` or `quick`. They
   * are never drawn as the network sends them; each pace keeps up with a fast stream.
   * @default "quick"
   */
  pace?: PacedOptions["pace"];
  /** @deprecated Use `layout`. */
  style?: ChatMessageLayoutStyle;
  /** Layout only: margins and alignment. The look belongs to the message. */
  layout?: ChatMessageLayoutStyle;
}

const styles = stylex.create({
  root: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "grid",
    gap: grasp.space2,
    minWidth: 0,
    margin: 0,
    color: grasp.ink,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
  },
  person: {
    justifyItems: "end",
  },
  bubble: {
    boxSizing: "border-box",
    maxWidth: grasp.chatBubbleWidth,
    minWidth: 0,
    paddingBlock: grasp.space3,
    paddingInline: grasp.space4,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.soft,
    boxShadow: grasp.edge,
    overflowWrap: "anywhere",
    whiteSpace: "pre-wrap",
    outline: { default: "none", [media.forced]: `${grasp.hairline} solid` },
  },
  head: {
    display: "flex",
    alignItems: "baseline",
    gap: grasp.space2,
    minWidth: 0,
  },
  // A heading, so a screen reader can move from message to message; its own type, so no page's
  // heading styles reach it.
  name: {
    margin: 0,
    fontFamily: grasp.fontSans,
    letterSpacing: "normal",
    color: grasp.ink,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
  },
  time: {
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
  },
  // The agent's words keep their line breaks, as a person's do; wide content (a line of code)
  // scrolls inside them rather than widening the page.
  words: {
    minWidth: 0,
    overflowWrap: "anywhere",
    whiteSpace: "pre-wrap",
    overflowX: "auto",
  },
  // Written but with no word yet: the thinking line in the words' own place and size, so the
  // first word takes its line and nothing moves.
  // A flex row, so the shimmer inside is laid out as the row's one item and the line is exactly as
  // tall as a line of words. As an inline box in a paragraph it stood 6.7px taller in WebKit, and
  // the first word then arrived 3px off.
  waiting: { display: "flex", margin: 0 },
  // The words' box while it holds no word: no box at all, so it takes no row and no gap, and the
  // first word comes to stand exactly where the thinking line stood.
  blank: { display: "contents" },
  // While the agent writes, when asked for (`streamingMark`): the working mark, at the start of the line under its words.
  stream: { justifySelf: "start" },
  // The thinking line: small and quiet over the answer.
  thought: { margin: 0, fontSize: grasp.textSm, lineHeight: grasp.textSmLine },
  // With no thoughts yet the line is as tall as the trigger it becomes when they arrive, so
  // nothing under it moves then.
  thoughtAlone: {
    display: "flex",
    alignItems: "center",
    minHeight: grasp.collapsibleTrigger,
  },
  failed: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: grasp.space2,
    margin: 0,
    color: grasp.danger,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  // A stopped answer: one quiet line under its words, before its actions.
  stopped: {
    display: "inline-flex",
    alignItems: "center",
    justifySelf: "start",
    gap: grasp.space1,
    margin: 0,
    color: grasp.muted,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  failedWords: {
    margin: 0,
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
  },
  // A fieldset, for its group role; its own border, padding, margin and minimum width taken off,
  // so it lays out as the div it replaced.
  actions: {
    boxSizing: "border-box",
    minInlineSize: "auto",
    margin: 0,
    padding: 0,
    border: "none",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    // On a touch screen the buttons stand a finger apart: each is drawn as it is, with 44px to
    // press that meets its neighbour's and never lies over another button.
    gap: {
      default: grasp.space1,
      [media.coarse]: `calc(${grasp.tap} - ${grasp.controlSm})`,
    },
    // The first button's icon stands under the first letter of the words.
    marginInlineStart: `calc(-1 * (${grasp.controlSm} - ${grasp.iconSm}) / 2)`,
  },
  personTime: {
    paddingInlineEnd: grasp.space2,
  },
  // A person's actions sit under the bubble, at the end, their last icon under its edge.
  personActions: {
    marginInlineStart: 0,
    marginInlineEnd: `calc(-1 * (${grasp.controlSm} - ${grasp.iconSm}) / 2)`,
  },
  // The corner its focus ring takes, as the ring round a control's words does (focus.label).
  focusable: {
    borderRadius: grasp.cornerMark,
    cornerShape: grasp.cornerShape,
  },
});

/** A string with words in it: an empty one counts as none, as it always has. */
const filled = (text: string | undefined): text is string =>
  text !== undefined && text !== "";

/** Whether React draws anything for a node; 0 was never taken as actions. */
const present = (node: ReactNode) =>
  node !== undefined &&
  node !== null &&
  node !== false &&
  node !== "" &&
  node !== 0;

interface Heard {
  from: ChatMessageProps["from"];
  status: ChatMessageStatus;
  thinkingLabel: string | undefined;
  streamingLabel: string;
  doneLabel: string;
  stoppedLabel: string;
}

const sameAs = (heard: Heard, now: Heard) =>
  heard.from === now.from &&
  heard.status === now.status &&
  heard.thinkingLabel === now.thinkingLabel &&
  heard.streamingLabel === now.streamingLabel &&
  heard.doneLabel === now.doneLabel &&
  heard.stoppedLabel === now.stoppedLabel;

/** What the status region says after a change, given the status before it. */
const sayFor = (now: Heard, before: ChatMessageStatus) => {
  if (now.status === "thinking") {
    return now.thinkingLabel ?? "";
  }
  if (now.status === "streaming") {
    return now.streamingLabel;
  }
  if (now.status === "done" && before === "streaming") {
    return now.doneLabel;
  }
  // Stopped while it thought or wrote; a message drawn stopped (from history) says nothing.
  if (
    now.status === "stopped" &&
    (before === "streaming" || before === "thinking")
  ) {
    return now.stoppedLabel;
  }
  return "";
};

// The status region is always there and starts empty, so a screen reader hears each change:
// Writing when the agent starts, the done words when it ends, never each arriving word.
const useSaid = (now: Heard) => {
  const [seen, setSeen] = useState(now);
  // The status it last spoke from: only the agent's message speaks, so a person's leaves it be.
  const [was, setWas] = useState(now.status);
  const [said, setSaid] = useState(
    now.from === "agent" ? sayFor(now, now.status) : ""
  );
  if (!sameAs(seen, now)) {
    setSeen(now);
    if (now.from === "agent") {
      setSaid(sayFor(now, was));
      setWas(now.status);
    }
  }
  // The words go in two frames after they change: once the empty region is on the page, so a
  // message that starts streaming is heard too, and after the last sentence or block said through
  // the page's announce region (which says it a frame on), so "Answer ready" comes after it.
  const [spoken, setSpoken] = useState("");
  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        setSpoken(said);
      });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [said]);
  // While new words are on their way in, the region is empty: the words of the state before never
  // stand in a message that has moved on (a stream that starts over still said "Answer ready" for
  // two frames), and a region that empties and fills is heard afresh.
  return spoken === said ? spoken : "";
};

// Leaving a failure (Try again) unmounts the button that had focus: keep focus on the message.
const useKeepFocus = (
  root: RefObject<HTMLElement | null>,
  from: ChatMessageProps["from"],
  status: ChatMessageStatus
) => {
  const was = useRef(status);
  useEffect(() => {
    if (from !== "agent") {
      return;
    }
    const lost =
      document.activeElement === document.body ||
      document.activeElement === null;
    if (was.current === "failed" && status !== "failed" && lost) {
      root.current?.focus();
    }
    was.current = status;
  }, [root, from, status]);
};

interface StampProps {
  time: string | undefined;
  dateTime: string | undefined;
  person: boolean;
}

const Stamp = ({ time, dateTime, person }: StampProps) =>
  filled(time) ? (
    <time
      dateTime={dateTime}
      {...stylex.props(styles.time, person && styles.personTime)}
    >
      {time}
    </time>
  ) : null;

interface ActionRowProps {
  from: ChatMessageProps["from"];
  status: ChatMessageStatus;
  copyText: string | undefined;
  actions: ReactNode;
  label: string;
  copyLabels: { copy: string; copied: string; failed: string };
}

const ActionRow = ({
  from,
  status,
  copyText,
  actions,
  label,
  copyLabels,
}: ActionRowProps) => {
  const person = from === "person";
  if (
    !(filled(copyText) || present(actions)) ||
    !(person || status === "done" || status === "stopped")
  ) {
    return null;
  }
  return (
    <fieldset
      aria-label={label}
      {...stylex.props(styles.actions, person && styles.personActions)}
    >
      {filled(copyText) && (
        <ChatMessageCopy
          text={copyText}
          label={copyLabels.copy}
          doneLabel={copyLabels.copied}
          failedLabel={copyLabels.failed}
        />
      )}
      {actions}
    </fieldset>
  );
};

interface HeadProps {
  name: string | undefined;
  nameHidden: boolean | undefined;
  time: string | undefined;
  dateTime: string | undefined;
}

const Head = ({ name: given, nameHidden, time, dateTime }: HeadProps) => {
  // Hidden, the name is still the message's name for a screen reader (the article's), not drawn.
  const name = nameHidden === true ? undefined : given;
  return filled(name) || filled(time) ? (
    <div {...stylex.props(styles.head)}>
      {filled(name) && <h3 {...stylex.props(styles.name)}>{name}</h3>}
      <Stamp time={time} dateTime={dateTime} person={false} />
    </div>
  ) : null;
};

/** How long the thinking took, in whole seconds, once it has ended; null until then. */
const useTook = (thinking: boolean) => {
  const [took, setTook] = useState<number | null>(null);
  useEffect(() => {
    const start = performance.now();
    return () => {
      if (thinking) {
        setTook(Math.max(1, Math.round((performance.now() - start) / 1000)));
      }
    };
  }, [thinking]);
  return took;
};

interface ThoughtProps {
  thinking: boolean;
  thoughts: ReactNode;
  look: ChatMessageThoughtsLook | undefined;
  label: string;
  thoughtLabel: (seconds: number) => string;
  seconds: number | undefined;
}

/**
 * The thinking line: what the agent is doing, the light crossing it, while it thinks; then, plain,
 * how long it thought. Never an icon line.
 */
const Thought = ({
  thinking,
  thoughts,
  look = "rule",
  label,
  thoughtLabel,
  seconds,
}: ThoughtProps) => {
  const took = useTook(thinking);
  const settled = seconds ?? took;
  // Open only if the reader opened it, and closed again when the answer starts.
  const [open, setOpen] = useState(false);
  const [was, setWas] = useState(thinking);
  if (was !== thinking) {
    setWas(thinking);
    setOpen(false);
  }
  // Once it has thought it has a line, for good: the moment thinking ends its time is not counted
  // yet, and the line must not go and come back (whoever has focus on it would lose it).
  const [began, setBegan] = useState(thinking);
  if (thinking && !began) {
    setBegan(true);
  }
  if (!began && settled === null) {
    return null;
  }
  const line = (
    <Shimmer active={thinking}>
      {thinking || settled === null ? label : thoughtLabel(settled)}
    </Shimmer>
  );
  if (!present(thoughts)) {
    return (
      <p data-thought="" {...stylex.props(styles.thought, styles.thoughtAlone)}>
        {line}
      </p>
    );
  }
  return (
    <div data-thought="" {...stylex.props(styles.thought)}>
      <Collapsible title={line} open={open} onOpenChange={setOpen} fit>
        <Thoughts thoughts={thoughts} look={look} writing={thinking} />
      </Collapsible>
    </div>
  );
};

interface FailureProps {
  label: string;
  onRetry: (() => unknown) | undefined;
  retryLabel: string;
}

const Failure = ({ label, onRetry, retryLabel }: FailureProps) => (
  <div {...stylex.props(styles.failed)}>
    <p role="alert" {...stylex.props(styles.failedWords)}>
      <Icon icon={Alert} />
      {label}
    </p>
    {onRetry !== undefined && (
      <PressPrimitive
        onClick={() => onRetry()}
        pendingAnnouncement=""
        render={(props: Record<string, unknown>) => (
          <Button {...props} variant="quiet" size="sm" icon={Retry}>
            {retryLabel}
          </Button>
        )}
      />
    )}
  </div>
);

interface EndingProps extends Omit<FailureProps, "label"> {
  status: ChatMessageStatus;
  stoppedLabel: string;
  failedLabel: FailureProps["label"];
}

/** How a message that did not end as done ends: Stopped under its words, or its failure. */
const Ending = ({
  status,
  stoppedLabel,
  failedLabel,
  onRetry,
  retryLabel,
}: EndingProps) => {
  if (status === "stopped") {
    return (
      <p data-slot="chat-message-stopped" {...stylex.props(styles.stopped)}>
        <Icon icon={Stop} />
        {stoppedLabel}
      </p>
    );
  }
  return status === "failed" ? (
    <Failure label={failedLabel} onRetry={onRetry} retryLabel={retryLabel} />
  ) : null;
};

/** Where the last whole sentence of `text` ends. */
const sentencesEnd = (text: string): number => {
  const last = [...text.matchAll(/[.!?…](?=\s)/gu)].at(-1);
  return last === undefined ? 0 : last.index + 1;
};

/**
 * While words given as text are written, a screen reader hears each sentence when it is finished,
 * never each word. Words that were there when the message was first drawn are not news.
 */
const useSaidSentences = (text: string, live: boolean) => {
  const said = useRef<number | null>(null);
  const cut = live ? sentencesEnd(text) : text.length;
  useEffect(() => {
    const from = said.current;
    said.current = cut;
    if (from === null || cut <= from) {
      return;
    }
    const words = text.slice(from, cut).trim();
    if (words !== "") {
      announce(words);
    }
  }, [text, cut]);
};

/**
 * A message's words while they are written. Words given as text are paced here; a part given
 * instead (Markdown) paces its own. It is still being written until the last word is out, a moment
 * after the stream has ended: the mark stays and the actions wait until then.
 */
/**
 * Whether a message being written has no word to show yet. Read from the page, since the words
 * may be a part of the caller's own (Markdown) that paces itself: the words' box is watched, and
 * it is blank while it holds no text. Before the box is on the page, the children say.
 */
const useBlank = (
  box: HTMLElement | null,
  streaming: boolean,
  children: ReactNode
) => {
  const first =
    typeof children === "string" ? children === "" : !present(children);
  const watch = (changed: () => void) => {
    const observer = new MutationObserver(changed);
    if (box !== null) {
      observer.observe(box, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
    return () => {
      observer.disconnect();
    };
  };
  const blank = useSyncExternalStore(
    watch,
    () => (box === null ? first : (box.textContent ?? "").trim() === ""),
    () => first
  );
  return streaming && blank;
};

/**
 * The moment a message is being written and has no word yet. A message that thought first already
 * has its line ("Thought for 12 seconds") over the place the words come to; one that did not gets
 * a thinking line for that moment, gone with the first word. With `streamingMark` the mark is the
 * sign, and there is no line.
 */
const useWaiting = (
  box: HTMLElement | null,
  from: ChatMessageProps["from"],
  status: ChatMessageStatus,
  children: ReactNode,
  mark: boolean
) => {
  const blank = useBlank(
    box,
    from === "agent" && status === "streaming",
    children
  );
  const [thought, setThought] = useState(status === "thinking");
  if (status === "thinking" && !thought) {
    setThought(true);
  }
  return { blank, waiting: blank && !mark && !thought };
};

interface SignProps {
  waiting: boolean;
  mark: boolean;
  label: string;
}

/** What says the agent is at work beside the words: the thinking line before the first word, or the mark when asked for. */
const Sign = ({ waiting, mark, label }: SignProps) => (
  <>
    {waiting && (
      <p aria-hidden="true" data-waiting="" {...stylex.props(styles.waiting)}>
        <Shimmer active>{label}</Shimmer>
      </p>
    )}
    {mark && <AgentIndicator layout={styles.stream} />}
  </>
);

const useWords = (
  children: ReactNode,
  from: ChatMessageProps["from"],
  status: ChatMessageStatus,
  options: PacedOptions
) => {
  const words = typeof children === "string" ? children : null;
  const live = from === "agent" && status === "streaming";
  const paced = usePaced(words ?? "", live, options);
  // A part inside that paces its own words says here while they are still arriving.
  const [inside, setInside] = useState(false);
  // Done or stopped, the words already sent still come out at their pace before the end is said.
  const ended = status === "done" || status === "stopped";
  const arriving =
    from === "agent" && ended && ((words !== null && !paced.done) || inside);
  useSaidSentences(paced.text, live || arriving);
  // What fades in as it arrives: words paced here, or a part inside that paces its own (Markdown
  // streaming). Text a caller simply puts in, chunk by chunk, is drawn as it comes.
  const fades =
    from === "agent" && (inside || (words !== null && (live || arriving)));
  return {
    words,
    paced,
    arriving,
    streaming: live || arriving,
    fades,
    setInside,
  };
};

/** The caller's text props, by their key in the catalogue's entry (words.ts). */
const givenOf = (
  props: Pick<
    ChatMessageProps,
    | "personLabel"
    | "failedLabel"
    | "retryLabel"
    | "actionsLabel"
    | "copyLabels"
    | "streamingLabel"
    | "doneLabel"
    | "stoppedLabel"
    | "thinkingLabel"
    | "thoughtLabel"
  >
): Partial<ChatMessageWords> => ({
  person: props.personLabel,
  failed: props.failedLabel,
  retry: props.retryLabel,
  actions: props.actionsLabel,
  copy: props.copyLabels?.copy,
  copied: props.copyLabels?.copied,
  copyFailed: props.copyLabels?.failed,
  streaming: props.streamingLabel,
  done: props.doneLabel,
  stopped: props.stoppedLabel,
  thinking: props.thinkingLabel,
  thought: props.thoughtLabel,
});

/** One message in a conversation: a person's, or the agent's. */
export const ChatMessage = ({
  from,
  children,
  name,
  nameHidden,
  time,
  dateTime,
  personLabel,
  status = "done",
  failedLabel,
  onRetry,
  retryLabel,
  copyText,
  actions,
  actionsLabel,
  copyLabels,
  streamingLabel,
  doneLabel,
  stoppedLabel,
  streamingMark = false,
  thinkingLabel,
  thoughtLabel,
  thoughts,
  thoughtSeconds,
  thoughtsLook,
  pace,
  style: styleProp,
  layout,
}: ChatMessageProps) => {
  const root = useRef<HTMLElement | null>(null);
  // Its own words: the product's, by its catalogue, else English; a text prop given still wins.
  const text = withGiven(
    useCatalogue("chatMessage", chatMessageWords),
    givenOf({
      personLabel,
      failedLabel,
      retryLabel,
      actionsLabel,
      copyLabels,
      streamingLabel,
      doneLabel,
      stoppedLabel,
      thinkingLabel,
      thoughtLabel,
    })
  );
  const { words, paced, arriving, streaming, fades, setInside } = useWords(
    children,
    from,
    status,
    { pace }
  );
  // Still writing until the last word is out: the done words wait for it, and for its sentence.
  const said = useSaid({
    from,
    status: arriving ? "streaming" : status,
    thinkingLabel: text.thinking,
    streamingLabel: text.streaming,
    doneLabel: text.done,
    stoppedLabel: text.stopped,
  });
  useKeepFocus(root, from, status);
  const [wordsBox, setWordsBox] = useState<HTMLDivElement | null>(null);
  // Before the first word, with no mark asked for: the thinking line says something is happening.
  // Before the words' box is on the page (the server's HTML, a stage not yet seen), what is drawn
  // says: paced words start empty, so the thinking line stands there, not an empty box.
  const { blank, waiting } = useWaiting(
    wordsBox,
    from,
    status,
    words === null ? children : paced.text,
    streamingMark
  );
  // Paced words written into the words' box fade in as they arrive, with nothing round any word.
  useArriving(wordsBox, fades);

  const row = (
    <ActionRow
      from={from}
      status={arriving ? "streaming" : status}
      copyText={copyText}
      actions={actions}
      label={text.actions}
      copyLabels={{
        copy: text.copy,
        copied: text.copied,
        failed: text.copyFailed,
      }}
    />
  );

  if (from === "person") {
    return (
      <article
        ref={root}
        aria-label={text.person}
        data-slot="chat-message"
        data-from="person"
        {...stylex.props(styles.root, styles.person, layout ?? styleProp)}
      >
        <div {...stylex.props(styles.bubble)}>{children}</div>
        <Stamp time={time} dateTime={dateTime} person />
        {row}
      </article>
    );
  }

  return (
    <article
      ref={root}
      tabIndex={-1}
      aria-label={name}
      data-slot="chat-message"
      data-from="agent"
      data-status={status}
      // The message takes focus from code (after Try again): the one focus ring shows where the
      // keyboard is, for the keyboard only. A message is words with no box of its own, so the ring
      // is the one for words: a step off them, with the small corner.
      {...stylex.props(
        styles.root,
        styles.focusable,
        layout ?? styleProp,
        focus.words
      )}
    >
      <Head
        name={name}
        nameHidden={nameHidden}
        time={time}
        dateTime={dateTime}
      />
      <Thought
        thinking={status === "thinking"}
        thoughts={thoughts}
        look={thoughtsLook}
        label={text.thinking}
        thoughtLabel={text.thought}
        seconds={thoughtSeconds}
      />
      {children !== undefined && children !== null && children !== false && (
        <div
          ref={setWordsBox}
          aria-busy={streaming || undefined}
          {...stylex.props(styles.words, blank && styles.blank)}
        >
          {words === null ? (
            <ArrivingContext value={setInside}>{children}</ArrivingContext>
          ) : (
            paced.text
          )}
        </div>
      )}
      <Sign
        waiting={waiting}
        mark={streaming && streamingMark}
        label={text.thinking}
      />
      <Ending
        status={status}
        stoppedLabel={text.stopped}
        failedLabel={text.failed}
        onRetry={onRetry}
        retryLabel={text.retry}
      />
      {row}
      <output {...stylex.props(visuallyHidden)}>{said}</output>
    </article>
  );
};
