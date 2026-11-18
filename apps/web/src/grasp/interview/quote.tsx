// InterviewQuote: what someone said, with who said it, which interview and the moment, as a
// <figure>: the words in a <blockquote>, set in Geist Serif beside a bar in the theme's tint, and
// the citation in its <figcaption>. The citation goes to the moment: inside an Interview, with a
// `turn`, it is a button that makes the turn active and sends the sound there; with `href` it is a
// link; with neither it is plain words.
//
//   <InterviewQuote who="Operations lead" interview="Month end close" atMs={724_000} href="/brain/notes/412#t=724">
//     We still chase approvals by email.
//   </InterviewQuote>
//
// Sizes: `sm` in a list, `md` on its own, `lg` as a page's one quote. `emphasis` lights a quote or
// quiets it, for a wall where a theme is chosen: quieted words stay readable (4.5:1) and stay in
// the page for a screen reader.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Avatar, AvatarImage, AvatarFallback } from "../avatar";
import { focus } from "../focus/focus";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { useInterview } from "./context";
import type { InterviewValue } from "./context";
import { langOf } from "./lang";
import type { InterviewLayoutStyle } from "./layout";
import { hasWords } from "./read";
import { tones } from "./tone";
import { toneVars } from "./tone.stylex";
import type { InterviewTone, InterviewWords } from "./types";
import { useInterviewWords } from "./words";

export type InterviewQuoteSize = "sm" | "md" | "lg";

/** Every prop an InterviewQuote takes. */
export interface InterviewQuoteProps {
  /** What was said. */
  children: ReactNode;
  /** Who said it: a name or a role. Inside an Interview, the turn's speaker stands in without it. */
  who?: string;
  /** Their role, when `who` is a name. */
  role?: string;
  /** Their portrait's address; their initials stand in without one. */
  src?: string;
  /** Which interview it is from ("Month end close, finance"). */
  interview?: string;
  /** The moment, in milliseconds from the start. Inside an Interview, the turn's start stands in without it. */
  atMs?: number;
  /** Inside an Interview: the turn it is from, by its place. The citation then goes to that turn. */
  turn?: number;
  /** Where the moment opens, when the citation is a link. */
  href?: string;
  /** Runs when the citation is pressed: the citation is then a button. */
  onCite?: () => void;
  /**
   * `sm` in a list, `md` on its own, `lg` as a page's one quote.
   * @default "md"
   */
  size?: InterviewQuoteSize;
  /** Its kind or theme, in a word or two, shown over the words ("Blocker"). */
  kind?: string;
  /**
   * The tint of its bar and its kind.
   * @default "pine"
   */
  tone?: InterviewTone;
  /**
   * `lit` washes it in its tint, `quiet` sets it back, for a wall where a theme is chosen.
   * @default "normal"
   */
  emphasis?: "normal" | "lit" | "quiet";
  /** The words it writes itself, any of them replaced; inside an Interview, the interview's words. */
  words?: Partial<InterviewWords>;
  /** The language of its words ("nl"), so they hyphenate by its rules; inside an Interview, the interview's. */
  lang?: string;
  /** @deprecated Use `layout`. */
  style?: InterviewLayoutStyle;
  /** Layout only: where it sits and how wide it is. */
  layout?: InterviewLayoutStyle;
}

const styles = stylex.create({
  figure: {
    position: "relative",
    display: "grid",
    gap: grasp.space3,
    minWidth: 0,
    margin: 0,
    paddingBlock: grasp.space1,
    paddingInlineStart: grasp.space4,
    fontFamily: grasp.fontSans,
    // The bar down its start, in its tint: a real line in forced colours too.
    borderInlineStartWidth: grasp.ringWidth,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: {
      default: toneVars.ink,
      [media.forced]: "CanvasText",
    },
  },
  // The wash a lit quote stands on, faded in and out; under the words.
  wash: {
    position: "absolute",
    inset: `calc(-1 * ${grasp.space2})`,
    insetInlineStart: 0,
    borderStartEndRadius: grasp.corner,
    borderEndEndRadius: grasp.corner,
    backgroundColor: toneVars.wash,
    opacity: 0,
    pointerEvents: "none",
    transitionProperty: "opacity",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  washLit: { opacity: 1 },
  kind: {
    position: "relative",
    margin: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: toneVars.ink,
    overflowWrap: "anywhere",
  },
  quote: {
    position: "relative",
    margin: 0,
    fontFamily: grasp.fontSerif,
    fontWeight: grasp.weightRegular,
    color: grasp.ink,
    overflowWrap: "anywhere",
    textWrap: "pretty",
  },
  sm: { fontSize: grasp.textMd, lineHeight: grasp.textMdLine },
  md: { fontSize: grasp.titleSm, lineHeight: grasp.titleSmLine },
  lg: {
    fontSize: grasp.titleMd,
    lineHeight: grasp.titleMdLine,
    letterSpacing: grasp.trackingTitle,
  },
  quiet: { color: grasp.muted },
  // Who said it on the first line, beside their portrait; the citation under it.
  caption: {
    position: "relative",
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    alignItems: "center",
    columnGap: grasp.space2,
    rowGap: 0,
    minWidth: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
  portrait: {
    display: "flex",
    gridRow: "span 2",
    alignSelf: "start",
    paddingBlockStart: `calc((${grasp.textSmLine} * 2 - ${grasp.avatarXs}) / 2)`,
  },
  line: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: grasp.space2,
    minWidth: 0,
  },
  alone: { gridColumn: "1 / -1" },
  who: {
    minWidth: 0,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
    overflowWrap: "anywhere",
  },
  role: {
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  cite: {
    position: "relative",
    justifySelf: "start",
    minWidth: 0,
    fontStyle: "normal",
    fontVariantNumeric: "tabular-nums",
    overflowWrap: "anywhere",
  },
  // A citation that goes somewhere: underlined, as a link is, with room for a finger.
  press: {
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: grasp.cornerMark,
    backgroundColor: "transparent",
    font: "inherit",
    textAlign: "start",
    color: {
      default: grasp.muted,
      ":hover": { default: null, [media.hover]: grasp.ink },
    },
    textDecorationLine: "underline",
    textDecorationThickness: grasp.linkUnderlineWidth,
    textUnderlineOffset: grasp.linkUnderlineOffset,
    textDecorationColor: {
      default: grasp.linkUnderline,
      ":hover": { default: null, [media.hover]: "currentColor" },
    },
    cursor: "pointer",
    touchAction: "manipulation",
  },
  // A finger needs 44px each way: on a touch screen an unseen area round the citation makes up the
  // difference, in height and, for a citation as short as "0:05", in width. The words do not move.
  reach: {
    position: "absolute",
    insetInline: {
      default: 0,
      [media.coarse]: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
    },
    insetBlock: {
      default: 0,
      [media.coarse]: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
    },
  },
});

interface Citing {
  /** The citation's words. */
  said: string;
  onCite?: () => void;
  href?: string;
}

/** The citation: a button, a link, or plain words. */
const Cite = ({ said, onCite, href }: Citing) => {
  if (onCite !== undefined) {
    return (
      <button
        type="button"
        data-slot="interview-cite"
        data-may-wrap=""
        onClick={onCite}
        {...stylex.props(styles.cite, styles.press, focus.words)}
      >
        <span aria-hidden="true" {...stylex.props(styles.reach)} />
        {said}
      </button>
    );
  }
  if (hasWords(href)) {
    return (
      <a
        href={href}
        data-slot="interview-cite"
        data-may-wrap=""
        {...stylex.props(styles.cite, styles.press, focus.words)}
      >
        <span aria-hidden="true" {...stylex.props(styles.reach)} />
        {said}
      </a>
    );
  }
  return (
    <span data-slot="interview-cite" {...stylex.props(styles.cite)}>
      {said}
    </span>
  );
};

/**
 * The words of the citation: the interview and the moment, either alone, or nothing. A turn with
 * no time is named by its passage, the number the transcript shows beside it.
 */
const citeWords = (
  words: InterviewWords,
  interview: string | undefined,
  ms: number | undefined,
  turn: number | undefined
) => {
  if (ms !== undefined) {
    return words.cite(interview ?? "", words.clock(ms));
  }
  if (turn !== undefined) {
    return words.cite(interview ?? "", words.atPassage(turn + 1));
  }
  return interview ?? "";
};

/** What the turn gives a quote inside an Interview: who said it, when, and a press that goes there. */
const fromTurn = (shared: InterviewValue | null, turn: number | undefined) => {
  const said = turn === undefined ? undefined : shared?.turns[turn];
  if (shared === null || turn === undefined || said === undefined) {
    return { who: undefined, src: undefined, atMs: undefined, go: undefined };
  }
  return {
    who: shared.people.get(said.speaker)?.name ?? said.speaker,
    src: shared.people.get(said.speaker)?.src,
    atMs: said.startMs,
    go: () => {
      shared.go(turn);
    },
  };
};

/** Who said it and the citation's words: the props given, else what the turn gives. */
const useCiting = (
  shared: InterviewValue | null,
  given: Partial<InterviewWords> | undefined,
  turn: number | undefined,
  who: string | undefined,
  interview: string | undefined,
  atMs: number | undefined
) => {
  const catalogued = useInterviewWords(given);
  const words = shared === null ? catalogued : { ...shared.words, ...given };
  const found = fromTurn(shared, turn);
  // A turn's passage stands in for its time only inside an Interview, where the turn is known.
  return {
    found,
    name: who ?? found.who ?? "",
    said: citeWords(
      words,
      interview,
      atMs ?? found.atMs,
      found.go === undefined ? undefined : turn
    ),
  };
};

/** A quote with who said it, which interview and the moment. */
export const InterviewQuote = ({
  children,
  who,
  role,
  src,
  interview,
  atMs,
  turn,
  href,
  onCite,
  size = "md",
  kind,
  tone = "pine",
  emphasis = "normal",
  words: given,
  lang: own,
  style: styleProp,
  layout,
}: InterviewQuoteProps) => {
  const shared = useInterview();
  const { lang, words: wording } = langOf(own, shared?.lang);
  const { found, name, said } = useCiting(
    shared,
    given,
    turn,
    who,
    interview,
    atMs
  );
  const quiet = emphasis === "quiet";
  return (
    <figure
      data-slot="interview-quote"
      data-size={size}
      data-emphasis={emphasis}
      lang={lang}
      {...stylex.props(
        styles.figure,
        wording,
        tones[quiet ? "neutral" : tone],
        layout ?? styleProp
      )}
    >
      <span
        aria-hidden="true"
        {...stylex.props(styles.wash, emphasis === "lit" && styles.washLit)}
      />
      {hasWords(kind) ? <p {...stylex.props(styles.kind)}>{kind}</p> : null}
      <blockquote
        {...stylex.props(styles.quote, styles[size], quiet && styles.quiet)}
      >
        {children}
      </blockquote>
      <figcaption {...stylex.props(styles.caption)}>
        {hasWords(name) ? (
          <>
            <span {...stylex.props(styles.portrait)}>
              <Avatar name={name} size="xs" decorative>
                <AvatarImage src={src ?? found.src} />
                <AvatarFallback />
              </Avatar>
            </span>
            <span {...stylex.props(styles.line)}>
              <span {...stylex.props(styles.who)}>{name}</span>
              {hasWords(role) ? (
                <span {...stylex.props(styles.role)}>{role}</span>
              ) : null}
            </span>
          </>
        ) : null}
        {!hasWords(name) && hasWords(role) ? (
          <span {...stylex.props(styles.line, styles.alone)}>{role}</span>
        ) : null}
        {hasWords(said) ? (
          <span {...stylex.props(styles.line, !hasWords(name) && styles.alone)}>
            <Cite said={said} onCite={onCite ?? found.go} href={href} />
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
};
