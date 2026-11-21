"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { createElement, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { Avatar, AvatarImage, AvatarFallback } from "../avatar";
import { grasp } from "../tokens/tokens.stylex";
import { useInterview } from "./context";
import { langOf } from "./lang";
import type { InterviewLayoutStyle } from "./layout";
import { hasWords, lengthOf } from "./read";
import type { InterviewWords } from "./types";
import { useInterviewWords } from "./words";

/** Every prop an InterviewHead takes. */
export interface InterviewHeadProps {
  /** Who was interviewed: a name, or a role ("Operations lead"). The heading. */
  who: string;
  /** Their role, when `who` is a name. */
  role?: string;
  /** When it was held, as shown ("12 November"). */
  when?: string;
  /** The same moment for machines (`2026-11-12`), set on the `<time>`. */
  dateTime?: string;
  /** How long it ran, in milliseconds. Inside an Interview, the turns or the sound stand in without it. */
  durationMs?: number;
  /** How it was held, in a word or two ("Live", "Video call"). */
  how?: string;
  /** Their portrait's address; their initials stand in without one. */
  src?: string;
  /**
   * The heading's level, to fit the page's outline.
   * @default 3
   */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  /** @deprecated Use `headingLevel`. */
  level?: 2 | 3 | 4 | 5 | 6;
  /** Actions at the end of the head: a button, a menu. */
  end?: ReactNode;
  /** The words it shows, any of them replaced; inside an Interview, the interview's words. */
  words?: Partial<InterviewWords>;
  /** The language of its words ("nl"), so they hyphenate by its rules; inside an Interview, the interview's. */
  lang?: string;
  /** @deprecated Use `layout`. */
  style?: InterviewLayoutStyle;
  /** Layout only: where it sits and how wide it is. */
  layout?: InterviewLayoutStyle;
}

const styles = stylex.create({
  head: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: grasp.space3,
    rowGap: grasp.space2,
    minWidth: 0,
    fontFamily: grasp.fontSans,
  },
  who: {
    display: "flex",
    alignItems: "center",
    flexGrow: 1,
    flexBasis: "16rem",
    gap: grasp.space3,
    minWidth: 0,
  },
  words: {
    display: "grid",
    gap: 0,
    minWidth: 0,
  },
  title: {
    margin: 0,
    fontSize: grasp.titleUi,
    lineHeight: grasp.titleUiLine,
    fontWeight: grasp.weightMedium,
    letterSpacing: grasp.trackingUiTitle,
    color: grasp.ink,
    overflowWrap: "anywhere",
  },
  role: {
    margin: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.text,
    overflowWrap: "anywhere",
  },
  facts: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    // Room for the dot between two facts, with a step on each side of it.
    columnGap: `calc(1ch + 2 * ${grasp.space2})`,
    rowGap: 0,
    margin: 0,
    padding: 0,
    listStyle: "none",
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
    fontVariantNumeric: "tabular-nums",
  },
  // The dot before a fact stands in the gap before it and takes no room, so hiding it moves
  // nothing; a fact that opens a line hides its dot (watchFacts marks it), so no line starts
  // "· Videogesprek" (eyes-b, B3-interview-04). The first fact's is hidden from the start.
  fact: {
    position: "relative",
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  dot: {
    position: "absolute",
    insetInlineEnd: "100%",
    marginInlineEnd: grasp.space2,
    inlineSize: "1ch",
    textAlign: "center",
    color: grasp.quiet,
    visibility: { default: "visible", ":is([data-line-start])": "hidden" },
  },
  end: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    flexShrink: 0,
    marginInlineStart: "auto",
  },
});

/** The facts in the quiet line under the role, in order, each with a key. */
const factsOf = (
  when: ReactNode,
  length: string | undefined,
  how: string | undefined
) =>
  [
    { key: "when", words: when },
    { key: "length", words: length },
    { key: "how", words: how },
  ].filter((fact) => fact.words !== undefined && fact.words !== "");

/** Marks the facts that open a line, so their dots hide; again as the list changes size. */
const watchFacts = (list: HTMLElement) => {
  const mark = () => {
    let top: number | null = null;
    for (const fact of list.children) {
      const at = fact instanceof HTMLElement ? fact.offsetTop : 0;
      fact
        .querySelector("[data-fact-dot]")
        ?.toggleAttribute(
          "data-line-start",
          top === null || Math.abs(at - top) > 1
        );
      top = at;
    }
  };
  mark();
  const observer = new ResizeObserver(mark);
  observer.observe(list);
  return () => {
    observer.disconnect();
  };
};

/** Who was interviewed and how. */
export const InterviewHead = ({
  who,
  role,
  when,
  dateTime,
  durationMs,
  how,
  src,
  level: levelDeprecated,
  headingLevel: level = levelDeprecated ?? 3,
  end,
  words: given,
  lang: own,
  style: styleProp,
  layout,
}: InterviewHeadProps) => {
  const shared = useInterview();
  const { lang, words: wording } = langOf(own, shared?.lang);
  const catalogued = useInterviewWords(given);
  const words = shared === null ? catalogued : { ...shared.words, ...given };
  const known =
    shared === null || shared.turns.length === 0
      ? undefined
      : lengthOf(shared.turns, shared.media?.duration);
  const ms = durationMs ?? known;
  const said = ms === undefined || ms <= 0 ? undefined : words.length(ms);
  const time = hasWords(when) ? (
    <time dateTime={dateTime}>{when}</time>
  ) : undefined;
  const facts = factsOf(time, said, how);
  const [factList, setFactList] = useState<HTMLElement | null>(null);
  useEffect(
    () => (factList === null ? undefined : watchFacts(factList)),
    [factList]
  );
  return (
    <div
      data-slot="interview-head"
      lang={lang}
      {...stylex.props(styles.head, wording, layout ?? styleProp)}
    >
      <div {...stylex.props(styles.who)}>
        <Avatar name={who} size="md" decorative>
          <AvatarImage src={src} />
          <AvatarFallback />
        </Avatar>
        <div {...stylex.props(styles.words)}>
          {createElement(`h${level}`, stylex.props(styles.title), who)}
          {hasWords(role) ? <p {...stylex.props(styles.role)}>{role}</p> : null}
          {facts.length > 0 ? (
            <ul ref={setFactList} {...stylex.props(styles.facts)}>
              {facts.map((fact, index) => (
                <li
                  key={fact.key}
                  data-fact={fact.key}
                  {...stylex.props(styles.fact)}
                >
                  <span
                    aria-hidden="true"
                    data-fact-dot=""
                    data-line-start={index === 0 ? "" : undefined}
                    {...stylex.props(styles.dot)}
                  >
                    ·
                  </span>
                  {fact.words}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      {end === undefined ? null : (
        <div {...stylex.props(styles.end)}>{end}</div>
      )}
    </div>
  );
};
