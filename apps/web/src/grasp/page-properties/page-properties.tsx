// Page properties: under a page's title, one quiet button ("Properties · 1 open") that opens the
// page's facts and its open questions in place, and closes them again. The facts are read only (kind,
// source, team, updated); an open question waits for its answer with the person who can give it,
// and Ask. It is a native disclosure, so it opens with no script and reads as one to a screen
// reader: the button says what waits, aria-expanded says whether it is open. The rows grow from the
// button (from its start, either way round), at once with reduced motion; on a phone each name
// stands over its value.
//
//   <PageProperties facts={[{ key: "Kind", value: "Document", icon: File }]} questions={[{ id: "ai", question: "Monthly budget for AI", who: "Head of finance", onAsk }]} />
"use client";

import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";
import type { ReactNode, SyntheticEvent } from "react";

import { Button, useAction } from "../button";
import { focus } from "../focus/focus";
import { ChevronDown, Icon, Question, Rows } from "../icons";
import type { IconData } from "../icons";
import type { LayoutStyle } from "../layout/layout";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords } from "../words/words";
import { pagePropertiesWords } from "./words";
import type { PagePropertiesWords } from "./words";

/** One of the page's facts: read only, a short name, its value and, if it helps, an icon. */
export interface PageFact {
  key: string;
  value: ReactNode;
  icon?: IconData;
}

/** A question the page cannot answer yet, and the person (a role) who can. */
export interface PageOpenQuestion {
  id: string;
  question: string;
  who: string;
  /** Asks them; Ask shows Asking, then Asked (or Not asked if it throws). Without it there is no Ask. */
  onAsk?: () => Promise<unknown>;
}

/** What a caller may style: where it sits and how wide it is. */
export type PagePropertiesLayoutStyle = LayoutStyle;

export interface PagePropertiesProps {
  facts: readonly PageFact[];
  /** Waiting for an answer: each a row of its own after the facts, and their count on the button. */
  questions?: readonly PageOpenQuestion[];
  /** Open now: with `onOpenChange`, the caller keeps it. */
  open?: boolean;
  /** Open at first, when it keeps its own. @default false */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** This instance's own words, over the catalogue's, key by key. */
  words?: Partial<PagePropertiesWords>;
  /** Layout only: where it sits and how wide it is. */
  layout?: PagePropertiesLayoutStyle;
}

const grow = stylex.keyframes({
  from: { opacity: 0, transform: "scaleY(0.96)" },
  to: { opacity: 1, transform: "none" },
});

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    minWidth: 0,
  },
  // The quiet button: muted words, its count in ink, a chevron; no box until the pointer is on it.
  toggle: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    maxWidth: "100%",
    marginInlineStart: `calc(-1 * ${grasp.space1})`,
    paddingBlock: grasp.space1,
    paddingInline: grasp.space1,
    borderRadius: grasp.cornerMark,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [media.hover]: grasp.ghostFillHover },
    },
    color: grasp.muted,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    listStyleType: "none",
    cursor: "pointer",
    userSelect: "none",
    "::-webkit-details-marker": { display: "none" },
  },
  count: { color: grasp.ink },
  icon: { display: "inline-flex", flexShrink: 0, color: grasp.muted },
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    transitionProperty: "transform",
    transitionDuration: { default: "150ms", [media.reduced]: "0s" },
  },
  chevronOpen: { transform: "rotate(180deg)" },
  // What opens: the facts, then the questions, grown from the button's start.
  body: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    width: "100%",
    paddingBlockStart: grasp.space2,
    transformOrigin: { default: "top left", ":dir(rtl)": "top right" },
    animationName: { default: grow, [media.reduced]: "none" },
    animationDuration: simply.ui,
    animationTimingFunction: grasp.ease,
  },
  rows: {
    display: "grid",
    // The names take what their words need, up to two fifths of the column; the values the rest.
    gridTemplateColumns: {
      default: "fit-content(40%) minmax(0, 1fr)",
      [media.belowPhone]: "minmax(0, 1fr)",
    },
    columnGap: grasp.space4,
    rowGap: { default: grasp.space1, [media.belowPhone]: 0 },
    margin: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  pair: { display: "contents" },
  name: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    margin: 0,
    paddingBlock: grasp.space1,
    color: grasp.muted,
  },
  // On a phone each name stands over its value, so a long value keeps the whole width.
  value: {
    margin: 0,
    paddingBlock: grasp.space1,
    paddingBlockEnd: {
      default: grasp.space1,
      [media.belowPhone]: grasp.space2,
    },
    paddingInlineStart: {
      default: 0,
      [media.belowPhone]: `calc(1em + ${grasp.space2})`,
    },
    color: grasp.ink,
    minWidth: 0,
    overflowWrap: "break-word",
  },
  // Not answered yet and who, then Ask held at the row's end, so the Asks stand in one column.
  waiting: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: grasp.space2,
    color: grasp.muted,
  },
  waitingWords: { flexGrow: 1, minWidth: 0 },
});

/** One open question's value: not answered yet, who can answer, and Ask. */
const Waiting = ({
  open,
  words,
}: {
  open: PageOpenQuestion;
  words: PagePropertiesWords;
}) => {
  const ask = useAction(
    async () => {
      await open.onAsk?.();
    },
    { working: words.asking, done: words.asked, failed: words.askFailed }
  );
  return (
    <span {...stylex.props(styles.waiting)}>
      <span {...stylex.props(styles.waitingWords)}>
        {words.notAnswered} · {open.who}
      </span>
      {open.onAsk === undefined ? null : (
        <Button
          size="xs"
          variant="ghost"
          aria-label={words.askLabel(open.who, open.question)}
          {...ask.props}
        >
          {words.ask}
        </Button>
      )}
    </span>
  );
};

/** A row's name, with its icon when it has one. */
const Name = ({
  icon,
  children,
}: {
  icon: IconData | undefined;
  children: ReactNode;
}) => (
  <dt {...stylex.props(styles.name)}>
    {icon === undefined ? null : (
      <span aria-hidden="true" {...stylex.props(styles.icon)}>
        <Icon icon={icon} />
      </span>
    )}
    <span>{children}</span>
  </dt>
);

/** No open questions. */
const none: readonly PageOpenQuestion[] = [];

export const PageProperties = ({
  facts,
  questions = none,
  open: given,
  defaultOpen = false,
  onOpenChange,
  words: own,
  layout,
}: PagePropertiesProps) => {
  const words = useWords("pageProperties", pagePropertiesWords, own);
  const [kept, setKept] = useState(defaultOpen);
  const open = given ?? kept;
  const bodyId = useId();
  const toggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    const next = event.currentTarget.open;
    if (next !== open) {
      setKept(next);
      onOpenChange?.(next);
    }
  };
  return (
    <details
      open={open}
      onToggle={toggle}
      data-slot="page-properties"
      {...stylex.props(styles.root, layout)}
    >
      <summary
        aria-controls={bodyId}
        {...stylex.props(styles.toggle, focus.ring)}
      >
        <span aria-hidden="true" {...stylex.props(styles.icon)}>
          <Icon icon={Rows} />
        </span>
        <span>
          {words.properties}
          {questions.length > 0 && (
            <span
              {...stylex.props(styles.count)}
            >{` · ${words.open(questions.length)}`}</span>
          )}
        </span>
        <span
          aria-hidden="true"
          {...stylex.props(styles.chevron, open && styles.chevronOpen)}
        >
          <Icon icon={ChevronDown} />
        </span>
      </summary>
      <div id={bodyId} {...stylex.props(styles.body)}>
        <dl {...stylex.props(styles.rows)}>
          {facts.map((fact) => (
            <div key={fact.key} {...stylex.props(styles.pair)}>
              <Name icon={fact.icon}>{fact.key}</Name>
              <dd {...stylex.props(styles.value)}>{fact.value}</dd>
            </div>
          ))}
          {questions.map((question) => (
            <div key={question.id} {...stylex.props(styles.pair)}>
              <Name icon={Question}>{question.question}</Name>
              <dd {...stylex.props(styles.value)}>
                <Waiting open={question} words={words} />
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  );
};
