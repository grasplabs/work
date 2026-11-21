"use client";

import * as stylex from "@stylexjs/stylex";
import { useId } from "react";
import type { ReactNode } from "react";

import { grasp, media } from "../tokens/tokens.stylex";
import { marginVars } from "./margin.stylex";
import { marginMarker } from "./tone.stylex";

/** Prose wide enough for a column of notes at its end. */
const WIDE = "@container (width >= 36rem)";
/** An engine that places by anchors. */
const ANCHORS = "@supports (anchor-name: --a)";

/** The margin's own styles, shared by Interview's transcript and MarginPassage. */
export const marginStyles = stylex.create({
  // The words are the anchor the rule and the note stand beside.
  anchor: (name: string) => ({ anchorName: name }),
  placed: (name: string) => ({ positionAnchor: name }),
  // A note after another in the same margin stands at its passage's first line or under the note
  // before, whichever is lower, so two passages that start on one line never stack their notes.
  below: (before: string) => ({
    insetBlockStart: `max(anchor(start), anchor(${before} end))`,
  }),
  // The rule beside the lines the passage is on. A real border, so forced colours keep it.
  rule: {
    position: "absolute",
    // Laid out but unseen until the margin has been measured placed right (proveMargin, below);
    // gone where it would cross the rule before it (data-collides).
    display: {
      default: "none",
      ":not([data-collides])": { default: "none", [ANCHORS]: "block" },
    },
    visibility: {
      default: "hidden",
      [stylex.when.ancestor(":is([data-margin=placed])", marginMarker)]:
        "visible",
    },
    insetBlockStart: "anchor(start)",
    insetBlockEnd: "anchor(end)",
    insetInlineEnd: marginVars.ruleEnd,
    inlineSize: 0,
    borderInlineStartWidth: grasp.ringWidth,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: {
      default: grasp.quiet,
      [media.forced]: "CanvasText",
    },
    borderRadius: grasp.ringWidth,
    pointerEvents: "none",
  },
});

const styles = stylex.create({
  // The prose's own width decides whether its notes stand in a column.
  prose: {
    [marginVars.noteSize]: `calc(${grasp.space24} + ${grasp.space20})`,
    [marginVars.noteEnd]: "0px",
    [marginVars.ruleEnd]: `calc(${marginVars.noteSize} + ${grasp.space3})`,
    containerType: "inline-size",
    minWidth: 0,
  },
  // The room the rules and notes are placed in; its end keeps the notes' column once placed.
  place: {
    position: "relative",
    display: "grid",
    gap: grasp.space3,
    minWidth: 0,
    // Kept from the start, so the rules can be measured beside the words; given back where the margin is off.
    paddingInlineEnd: {
      default: 0,
      [stylex.when.ancestor(":not([data-margin=off])", marginMarker)]: {
        default: null,
        [WIDE]: `calc(${marginVars.noteSize} + ${grasp.space6})`,
      },
    },
  },
  // The rule shows only beside a column of notes; narrower, the note's own edge is the rule.
  ruleWide: {
    display: {
      default: "none",
      [ANCHORS]: { default: "none", [WIDE]: "block" },
    },
  },
  passage: { scrollMarginBlock: grasp.space8 },
  // The note: under its words, the rule down its start; placed and wide, at the rule's head.
  note: {
    display: "block",
    marginBlockStart: {
      default: grasp.space1,
      [stylex.when.ancestor(":is([data-margin=placed])", marginMarker)]: {
        default: null,
        [WIDE]: 0,
      },
    },
    paddingInlineStart: {
      default: grasp.space3,
      [stylex.when.ancestor(":is([data-margin=placed])", marginMarker)]: {
        default: null,
        [WIDE]: 0,
      },
    },
    borderInlineStartWidth: {
      default: grasp.ringWidth,
      [stylex.when.ancestor(":is([data-margin=placed])", marginMarker)]: {
        default: null,
        [WIDE]: 0,
      },
    },
    borderInlineStartStyle: "solid",
    borderInlineStartColor: {
      default: grasp.quiet,
      [media.forced]: "CanvasText",
    },
    position: {
      default: "static",
      [stylex.when.ancestor(":is([data-margin=placed])", marginMarker)]: {
        default: null,
        [WIDE]: "absolute",
      },
    },
    insetBlockStart: {
      default: null,
      [stylex.when.ancestor(":is([data-margin=placed])", marginMarker)]: {
        default: null,
        [WIDE]: "anchor(start)",
      },
    },
    insetInlineEnd: {
      default: null,
      [stylex.when.ancestor(":is([data-margin=placed])", marginMarker)]: {
        default: null,
        [WIDE]: marginVars.noteEnd,
      },
    },
    inlineSize: {
      default: null,
      [stylex.when.ancestor(":is([data-margin=placed])", marginMarker)]: {
        default: null,
        [WIDE]: marginVars.noteSize,
      },
    },
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightRegular,
    color: { default: grasp.muted, [media.forced]: "CanvasText" },
    overflowWrap: "anywhere",
  },
});

/** The rule beside a passage's lines, placed by its anchor's name. Seen, not said. */
export const MarginRule = ({
  anchor,
  slot = "margin-rule",
  look,
}: {
  anchor: string;
  slot?: string;
  look?: stylex.StyleXStyles;
}) => (
  <span
    aria-hidden="true"
    data-slot={slot}
    {...stylex.props(marginStyles.rule, marginStyles.placed(anchor), look)}
  />
);

// ---- The margin, proven before it is shown ---------------------------------------------------------
//
// Anchor positioning is not done alike by every engine yet (an inline anchor across lines above
// all). So a margin starts unplaced, the rules laid out but unseen, and is measured once laid out:
// when every rule measured spans exactly the lines of its passage (2px either way) in the margin,
// and no two notes in a group overlap, it says `data-margin="placed"` and the margin shows. When
// one does not, it says `data-margin="off"` and stays unplaced for good.

/** Where a margin's parts are found, to measure them. */
export interface MarginSlots {
  /** A passage the rule stands beside. */
  mark: string;
  /** Its rule: the same place among its group's rules as the passage among its group's passages. */
  rule: string;
  /** A note in the margin. */
  note: string;
  /** What holds a passage and its rule: a transcript's turn, a paragraph. */
  group: string;
  /** Leave out passages whose rule is not drawn (a narrow prose draws none) rather than judge them. */
  skipUndrawn?: boolean;
  /** The word right after a passage that stands for its note there: told too when its rule gives way. */
  after?: string;
}

/** How far, in pixels, a rule may stand off its passage's lines. */
const SLACK = 2;
/** How many passages are measured: enough to judge the engine, few enough to stay cheap. */
const MEASURED = 8;

/** Whether one passage's rule spans its lines in the margin; null when it cannot be judged. */
const ruleHolds = (mark: HTMLElement, slots: MarginSlots) => {
  const group = mark.closest(slots.group);
  const words = mark.closest("p");
  const lines = [...mark.getClientRects()];
  const [first] = lines;
  const last = lines.at(-1);
  if (
    group === null ||
    words === null ||
    first === undefined ||
    last === undefined
  ) {
    return null;
  }
  if (mark.dataset.collides !== undefined) {
    return null;
  }
  const marks = [...group.querySelectorAll(slots.mark)];
  const ruleElement = [...group.querySelectorAll(slots.rule)].at(
    marks.indexOf(mark)
  );
  if (
    slots.skipUndrawn === true &&
    (ruleElement === undefined || ruleElement.getClientRects().length === 0)
  ) {
    return null;
  }
  const rule = ruleElement?.getBoundingClientRect();
  if (rule === undefined || rule.height === 0) {
    return false;
  }
  return (
    Math.abs(rule.top - first.top) <= SLACK &&
    Math.abs(rule.bottom - last.bottom) <= SLACK &&
    rule.left >= words.getBoundingClientRect().right - SLACK
  );
};

/**
 * Two passages on one line would draw two rules over each other in the same place, with no note in
 * a column to tell them apart (a narrow transcript): the second gives way. Its rule goes
 * (`data-collides` on the passage, its rule, its note and the word after it), and it is read by
 * the word after it, as an unplaced margin is; the first keeps its rule. Measured afresh each
 * time, so a wider page gives the rule back.
 */
const giveWay = (root: HTMLElement, slots: MarginSlots) => {
  for (const group of root.querySelectorAll(slots.group)) {
    const marks = [...group.querySelectorAll<HTMLElement>(slots.mark)];
    const rules = [...group.querySelectorAll<HTMLElement>(slots.rule)];
    const notes = [...group.querySelectorAll<HTMLElement>(slots.note)];
    const partsOf = (at: number) => {
      const mark = marks[at];
      const word = mark?.nextElementSibling;
      const after =
        slots.after !== undefined &&
        word instanceof HTMLElement &&
        word.matches(slots.after)
          ? word
          : undefined;
      return [mark, rules[at], notes[at], after].filter(
        (part) => part !== undefined
      );
    };
    for (const [at] of marks.entries()) {
      for (const part of partsOf(at)) {
        delete part.dataset.collides;
      }
    }
    const kept: DOMRect[] = [];
    for (const [at, rule] of rules.entries()) {
      const box = rule.getBoundingClientRect();
      if (box.height === 0) {
        continue;
      }
      // Where the notes stand in a column, each note says whose rule it is: the rules may share a line.
      const inColumn = (notes[at]?.getClientRects().length ?? 0) > 0;
      const crosses = kept.some(
        (other) =>
          Math.abs(other.left - box.left) < SLACK &&
          box.top < other.bottom - SLACK &&
          other.top < box.bottom - SLACK
      );
      if (crosses && !inColumn) {
        for (const part of partsOf(at)) {
          part.dataset.collides = "";
        }
      } else {
        kept.push(box);
      }
    }
  }
};

/** Whether the notes in one group stand clear of each other. */
const notesClear = (group: Element, slots: MarginSlots) => {
  const notes = [...group.querySelectorAll(slots.note)]
    .map((note) => note.getBoundingClientRect())
    .filter((box) => box.height > 0);
  return notes.every(
    (box, at) => at === 0 || box.top >= (notes[at - 1]?.bottom ?? 0) - SLACK / 2
  );
};

/** Whether the margin is placed right; null when nothing can be judged yet. */
const marginHolds = (root: HTMLElement, slots: MarginSlots) => {
  const marks = [...root.querySelectorAll<HTMLElement>(slots.mark)].slice(
    0,
    MEASURED
  );
  const seen = marks
    .map((mark) => ruleHolds(mark, slots))
    .filter((holds) => holds !== null);
  if (seen.length === 0) {
    return null;
  }
  return (
    !seen.includes(false) &&
    [...root.querySelectorAll(slots.group)].every((group) =>
      notesClear(group, slots)
    )
  );
};

/**
 * A ref for the box that carries `marginMarker`: measures its margin once laid out, and again when
 * its size changes, and says `data-margin="placed"` or `"off"` on it; once off, it stays off.
 */
export const proveMargin =
  (slots: MarginSlots) => (root: HTMLElement | null) => {
    const state = { frame: 0 };
    const judge = () => {
      state.frame = 0;
      if (root === null || root.dataset.margin === "off") {
        return;
      }
      giveWay(root, slots);
      const holds = marginHolds(root, slots);
      if (holds !== null) {
        root.dataset.margin = holds ? "placed" : "off";
      }
    };
    const watch = new ResizeObserver(() => {
      if (state.frame === 0) {
        state.frame = requestAnimationFrame(judge);
      }
    });
    if (root !== null) {
      watch.observe(root);
    }
    return () => {
      cancelAnimationFrame(state.frame);
      watch.disconnect();
    };
  };

// ---- Any prose ---------------------------------------------------------------------------------------

const proseSlots: MarginSlots = {
  mark: "[data-slot=margin-passage]",
  rule: "[data-slot=margin-rule]",
  note: "[data-slot=margin-note]",
  group: "[data-slot=margin-prose-place]",
  skipUndrawn: true,
};
const proveProse = proveMargin(proseSlots);

/** Every prop a MarginProse takes. */
export interface MarginProseProps {
  /** The prose: paragraphs whose passages are MarginPassage. */
  children: ReactNode;
}

/** Prose with a margin: its passages' notes stand in a column at its end once placed, under them before. */
export const MarginProse = ({ children }: MarginProseProps) => (
  <div
    ref={proveProse}
    data-slot="margin-prose"
    {...stylex.props(styles.prose, marginMarker)}
  >
    <div data-slot="margin-prose-place" {...stylex.props(styles.place)}>
      {children}
    </div>
  </div>
);

/** Every prop a MarginPassage takes. */
export interface MarginPassageProps {
  /** The words the rule stands beside: a sentence, a passage. */
  children: ReactNode;
  /** What stands at the rule's head: a source's name and date, a kind's word, a citation. */
  note: ReactNode;
  /** The anchor name of this passage's note, for the next passage's `after`; made for it without one. */
  name?: string;
  /** The note of the passage before: this note stands under it when the two would meet. */
  after?: string;
}

/** A dashed ident from React's id: letters, digits, hyphens and underscores only. */
const identOf = (id: string) => id.replaceAll(/[^\w-]/gu, "");

/** A passage in MarginProse: its words, the rule beside their lines, its note at the rule's head. */
export const MarginPassage = ({
  children,
  note,
  name,
  after,
}: MarginPassageProps) => {
  const own = `--margin-${identOf(useId())}`;
  // A CSS name, not words: joined.
  const noteName = name ?? [own, "note"].join("-");
  return (
    <>
      <span
        data-slot="margin-passage"
        {...stylex.props(styles.passage, marginStyles.anchor(own))}
      >
        {children}
      </span>
      <span
        data-slot="margin-note"
        {...stylex.props(
          styles.note,
          marginStyles.placed(own),
          marginStyles.anchor(noteName),
          after !== undefined && marginStyles.below(after)
        )}
      >
        {note}
      </span>
      <MarginRule anchor={own} look={styles.ruleWide} />
    </>
  );
};
