// InterviewThemes: what came up across several interviews. Each theme is a heading that opens its
// quotes (UI SDK's Accordion, one open at a time, in our Accordion's look): its title, how many interviews raised it in words
// ("7 of 12 interviews") and a thin bar of that share; opened, the quotes behind it, each with who
// said it, which interview and the moment.
//
//   <InterviewThemes themes={themes} total={12} />
//
// The open theme can be controlled (`value` with `onValueChange`) or left to it (`defaultValue`).
// A closed theme's quotes are in the page, hidden until found: the browser's find in page reaches
// them, and finding one opens its theme.
// The bar says nothing the count does not: it is hidden from a screen reader.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import {
  Accordion as AccordionPrimitive,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "@ui-sdk/react/accordion";
import { createElement, useState } from "react";

import { collapsibleStyles as parts } from "../collapsible/collapsible";
import { focus } from "../focus/focus";
import { ChevronDown, Icon } from "../icons";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { useInterview } from "./context";
import { langOf } from "./lang";
import type { InterviewLayoutStyle } from "./layout";
import { InterviewQuote } from "./quote";
import { tones } from "./tone";
import { toneVars } from "./tone.stylex";
import type { InterviewTheme, InterviewWords } from "./types";
import { useInterviewWords } from "./words";

/** Every prop an InterviewThemes takes. */
export interface InterviewThemesProps {
  /** The themes, most raised first, as the page orders them. */
  themes: readonly InterviewTheme[];
  /** How many interviews there were, for each theme's count and share. */
  total: number;
  /** The open theme's id, or null for none. Pass it with `onValueChange` to control it. */
  value?: string | null;
  /**
   * The theme open at first, when you do not control it.
   * @default null
   */
  defaultValue?: string | null;
  /** Runs with the open theme's id, or null when it closes. */
  onValueChange?: (value: string | null) => void;
  /**
   * The themes' headings' level, to fit the page's outline.
   * @default 3
   */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  /** @deprecated Use `headingLevel`. */
  level?: 2 | 3 | 4 | 5 | 6;
  /** The words it writes itself, any of them replaced: the count and the citations. */
  words?: Partial<InterviewWords>;
  /** The language of its words ("nl"), so they hyphenate by its rules; inside an Interview, the interview's. */
  lang?: string;
  /** @deprecated Use `layout`. */
  style?: InterviewLayoutStyle;
  /** Layout only: where it sits and how wide it is. */
  layout?: InterviewLayoutStyle;
}

const styles = stylex.create({
  root: {
    display: "grid",
    // On a touch screen the headings stand apart, so their 44px press areas meet and never overlap.
    rowGap: {
      default: grasp.space2,
      [media.coarse]: `calc(${grasp.tap} - ${grasp.collapsibleTrigger})`,
    },
    minWidth: 0,
    fontFamily: grasp.fontSans,
  },
  // Its own width decides where the count stands (below).
  item: { display: "grid", minWidth: 0, containerType: "inline-size" },
  header: {
    display: "grid",
    margin: 0,
    fontSize: "inherit",
    fontWeight: "inherit",
  },
  // The heading's button holds the whole title: the words, the count and the chevron on one line,
  // the bar under all three, so the chevron ends where the bar does.
  trigger: { paddingBlock: grasp.space1 },
  body: { paddingBlock: grasp.space2, color: grasp.ink },
  title: {
    flexGrow: 1,
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "baseline",
    columnGap: grasp.space3,
    rowGap: grasp.space2,
    paddingBlock: grasp.space2,
    minWidth: 0,
  },
  name: {
    minWidth: 0,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    color: grasp.ink,
    overflowWrap: "anywhere",
  },
  count: {
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightRegular,
    color: grasp.muted,
    fontVariantNumeric: "tabular-nums",
    textAlign: { default: "end", "@container (width < 22rem)": "start" },
    // Narrow (a phone), the count takes a line of its own under the title, so the title keeps
    // the width and never wraps for it (eyes-b, B3-interview-23).
    gridColumn: { default: null, "@container (width < 22rem)": "1" },
    gridRow: { default: null, "@container (width < 22rem)": "2" },
  },
  // The count and the chevron, side by side, on the title's first line; narrow, the chevron stays
  // there and the count goes under the title.
  end: {
    display: { default: "flex", "@container (width < 22rem)": "contents" },
    alignItems: "center",
    gap: grasp.space1,
  },
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    gridColumn: { default: null, "@container (width < 22rem)": "2" },
    gridRow: { default: null, "@container (width < 22rem)": "1" },
    alignSelf: { default: null, "@container (width < 22rem)": "center" },
    transitionProperty: "transform",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
  },
  // Open, it points up: the way the theme closes.
  chevronOpen: { transform: "rotate(180deg)" },
  track: {
    gridColumn: "1 / -1",
    position: "relative",
    blockSize: grasp.progressSm,
    borderRadius: grasp.cornerPill,
    overflow: "hidden",
    backgroundColor: {
      default: grasp.progressTrack,
      [media.forced]: "GrayText",
    },
  },
  fill: {
    position: "absolute",
    insetBlock: 0,
    insetInlineStart: 0,
    borderRadius: grasp.cornerPill,
    backgroundColor: { default: toneVars.ink, [media.forced]: "Highlight" },
  },
  share: (share: string) => ({ inlineSize: share }),
  quotes: {
    display: "grid",
    gap: grasp.space5,
    margin: 0,
    paddingBlock: grasp.space3,
    paddingInline: 0,
    listStyle: "none",
  },
});

/** A theme's heading: its title, its count in words and its share as a thin bar. */
const Title = ({
  theme,
  total,
  words,
  open,
}: {
  theme: InterviewTheme;
  total: number;
  words: InterviewWords;
  open: boolean;
}) => {
  const share = total > 0 ? Math.min(theme.count / total, 1) : 0;
  return (
    <span
      data-slot="interview-theme"
      {...stylex.props(styles.title, tones[theme.tone ?? "pine"])}
    >
      <span {...stylex.props(styles.name)}>{theme.title}</span>
      <span {...stylex.props(styles.end)}>
        <span data-slot="interview-theme-count" {...stylex.props(styles.count)}>
          {words.count(theme.count, total)}
        </span>
        <span
          aria-hidden="true"
          data-slot="interview-theme-chevron"
          {...stylex.props(styles.chevron, open && styles.chevronOpen)}
        >
          <Icon icon={ChevronDown} />
        </span>
      </span>
      <span aria-hidden="true" {...stylex.props(styles.track)}>
        <span
          {...stylex.props(
            styles.fill,
            styles.share(`${(share * 100).toFixed(1)}%`)
          )}
        />
      </span>
    </span>
  );
};

/** A theme's quotes, each with its citation. */
const Quotes = ({
  theme,
  words,
  lang,
}: {
  theme: InterviewTheme;
  words: Partial<InterviewWords>;
  lang: string | undefined;
}) => (
  <ul {...stylex.props(styles.quotes)}>
    {theme.quotes.map((quote) => (
      <li key={quote.id}>
        <InterviewQuote
          size="sm"
          who={quote.who}
          src={quote.src}
          interview={quote.interview}
          atMs={quote.atMs}
          href={quote.href}
          kind={quote.kind}
          tone={quote.tone ?? theme.tone ?? "pine"}
          words={words}
          lang={lang}
        >
          {quote.text}
        </InterviewQuote>
      </li>
    ))}
  </ul>
);

/** The open theme as Accordion's list of open sections: none or one. */
const openOf = (id: string | null) => (id === null ? [] : [id]);

/** Themes across several interviews, each opening the quotes behind it. */
export const InterviewThemes = ({
  themes,
  total,
  value,
  defaultValue = null,
  onValueChange,
  level: levelDeprecated,
  headingLevel: level = levelDeprecated ?? 3,
  words: given,
  lang: ownLang,
  style: styleProp,
  layout,
}: InterviewThemesProps) => {
  const shared = useInterview();
  const { lang, words: wording } = langOf(ownLang, shared?.lang);
  const catalogued = useInterviewWords(given);
  const words = shared === null ? catalogued : { ...shared.words, ...given };
  // Followed here for the chevron; the Accordion holds it unless the page controls it, so finding a
  // closed theme's words opens it at once, before the browser shows its panel.
  const [own, setOwn] = useState<string | null>(defaultValue);
  const open = value === undefined ? own : value;
  return (
    // A theme's heading is its title, then its count and share under it: more than one line by design.
    <div
      data-slot="interview-themes"
      data-may-wrap=""
      lang={lang}
      {...stylex.props(wording, layout ?? styleProp)}
    >
      <AccordionPrimitive
        value={value === undefined ? undefined : openOf(value)}
        defaultValue={openOf(defaultValue)}
        onValueChange={(next: string[]) => {
          const id = next[0] ?? null;
          setOwn(id);
          if (onValueChange !== undefined) {
            onValueChange(id);
          }
        }}
        {...stylex.props(styles.root)}
      >
        {themes.map((theme) => (
          <AccordionItem
            key={theme.id}
            value={theme.id}
            {...stylex.props(styles.item)}
          >
            <AccordionHeader
              render={(props: Record<string, unknown>) =>
                createElement(`h${level}`, props)
              }
              {...stylex.props(styles.header)}
            >
              <AccordionTrigger
                {...stylex.props(
                  parts.trigger,
                  parts.ghost,
                  styles.trigger,
                  focus.ring
                )}
              >
                <span aria-hidden="true" {...stylex.props(parts.target)} />
                <Title
                  theme={theme}
                  total={total}
                  words={words}
                  open={open === theme.id}
                />
              </AccordionTrigger>
            </AccordionHeader>
            {/* Every theme's quotes are in the page: a closed panel is hidden until found, so find in
                page reaches them and opens the theme. The class only: UI SDK writes the panel's
                measured height as its own inline (layout ?? styleProp). */}
            <AccordionPanel
              hiddenUntilFound
              className={
                stylex.props(parts.panel, parts.panelAccordion).className
              }
            >
              <div {...stylex.props(styles.body)}>
                <Quotes theme={theme} words={words} lang={lang} />
              </div>
            </AccordionPanel>
          </AccordionItem>
        ))}
      </AccordionPrimitive>
    </div>
  );
};
