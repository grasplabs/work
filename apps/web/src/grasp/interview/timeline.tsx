// InterviewTimeline: the whole conversation as one calm strip on one line, which is also its
// player: play and the time where the sound is at its start, the length, speed and sound at its
// end. Each speaker's stretches meet end to end in their own quiet tone, the same tone as the ring
// round their portrait in the transcript (`look="strip"`; `look="lanes"`: thin lines stacked in
// one rounded track, so talking over each other and silence show). A chapter is a two-pixel cut
// where it starts. Moments are small dots on the strip in their kind's tone, each a button named
// for its kind and time ("Blocker at 12:04"). One quiet line under the strip, always as tall,
// names what is under the pointer or focus (a speaker and when, a moment's pill and time), else
// the chapter the sound is in. Everything stands by percentages from the first paint: nothing
// is measured, nothing moves in.
//
//   <Interview turns={turns} speakers={speakers} chapters={chapters} highlights={highlights} kinds={kinds} media={media}>
//     <InterviewTimeline />
//   </Interview>
//
// Never colour alone: every stretch says its speaker and time to a screen reader, every mark its
// kind and time; the transcript's portraits wear the same tones; and in forced colours, where every
// tone is one ink, each speaker's stretches stand at a height of their own in the strip.
//
// The marks are one tab stop (a toolbar): Left and Right move between them (the other way right to
// left), Home and End to the first and the last, Enter or Space presses one. A press anywhere else
// on the strip sends the sound there. It needs times: with a turn that has none it draws nothing.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";

import { focus, focusMarker } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { useInterview, useInterviewTime } from "./context";
import type { InterviewValue } from "./context";
import { Interview } from "./interview";
import { langOf } from "./lang";
import type { InterviewLayoutStyle } from "./layout";
import { InterviewMoment } from "./moment";
import { KindPill } from "./pill";
import { endOf, lengthOf, timed } from "./read";
import { tones } from "./tone";
import { toneVars } from "./tone.stylex";
import type { InterviewDataProps, InterviewTone, InterviewTurn } from "./types";

/** How the timeline draws who spoke when: end to end in one bar, or as thin lines stacked in one track. */
export type InterviewTimelineLook = "strip" | "lanes";

/** Every prop an InterviewTimeline takes. Alone, outside an Interview, it takes the interview's props too. */
export interface InterviewTimelineProps extends InterviewDataProps {
  /**
   * Its name, for a screen reader and an agent: its marks' toolbar's, and its player's when it is the
   * player, so two on one page are told apart. The interview's words say "Conversation timeline" and
   * "Interview sound" without it.
   */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /**
   * How who spoke when is drawn. `strip`: each speaker's stretches end to end in one bar, in their
   * tone. `lanes`: each speaker a thin line of their own inside one rounded track, so talking over
   * each other and silence show.
   * @default "strip"
   */
  variant?: InterviewTimelineLook;
  /** @deprecated Use `variant`. */
  look?: InterviewTimelineLook;
  /**
   * With the interview's sound (`media`), the timeline is its player: play and the time at the
   * strip's start, the length, speed and sound at its end, the strip itself the scrubber. `false`
   * leaves the sound to a player elsewhere on the page.
   * @default true
   */
  player?: boolean;
  /** @deprecated Use `layout`. */
  style?: InterviewLayoutStyle;
  /** Layout only: where it sits and how wide it is. */
  layout?: InterviewLayoutStyle;
}

const COARSE = media.coarse;
const FORCED = media.forced;

const styles = stylex.create({
  root: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    gridTemplateAreas: '"now plot length" ". caption ."',
    columnGap: grasp.space3,
    minWidth: 0,
    fontFamily: grasp.fontSans,
  },
  // The times at the strip's ends: where the sound is, in ink; the whole length, quiet. Each as
  // wide as the length (laid under it, unseen) and never narrower than a token, so the strip's
  // width does not change while the sound moves or when the font arrives.
  time: {
    alignSelf: "center",
    display: "grid",
    minInlineSize: grasp.space8,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  timeStack: { gridArea: "1 / 1" },
  unseen: { gridArea: "1 / 1", visibility: "hidden" },
  now: { gridArea: "now", justifyItems: "start", color: grasp.ink },
  length: { gridArea: "length", justifyItems: "end", color: grasp.muted },
  // The strip's own room, as tall as a control, so it stands level with a player's buttons.
  plot: {
    gridArea: "plot",
    position: "relative",
    blockSize: grasp.controlSm,
    minWidth: 0,
  },
  seeks: { cursor: "pointer" },
  // Strip: one bar, the ground where nobody speaks.
  bar: {
    position: "absolute",
    insetInline: 0,
    insetBlockStart: `calc((${grasp.controlSm} - ${grasp.space2}) / 2)`,
    blockSize: grasp.space2,
    overflow: "hidden",
    borderRadius: grasp.cornerPill,
    backgroundColor: { default: grasp.line, [FORCED]: "Canvas" },
    outlineWidth: { default: 0, [FORCED]: grasp.hairline },
    outlineStyle: "solid",
    outlineColor: "CanvasText",
  },
  // Lanes: one rounded track, the speakers' lines inside it.
  track: {
    position: "absolute",
    insetInline: 0,
    insetBlock: grasp.space1,
    overflow: "hidden",
    borderRadius: grasp.cornerMark,
    backgroundColor: { default: grasp.soft, [FORCED]: "Canvas" },
    boxShadow: grasp.edge,
    outlineWidth: { default: 0, [FORCED]: grasp.hairline },
    outlineStyle: "solid",
    outlineColor: "CanvasText",
  },
  // The list of stretches: the bar's or the track's whole room.
  runs: {
    position: "absolute",
    inset: 0,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // The lanes take most of the track's height, so each speaker's line stands apart from the next
  // (at space-2 in from each edge they had 8px and read as one broken line: eyes-b, B3-interview-17).
  trackLanes: {
    insetBlock: grasp.space1,
  },
  // A speaker's stretch, in their quiet tone; stretches meet with no gap.
  run: {
    position: "absolute",
    backgroundColor: { default: toneVars.mid, [FORCED]: "CanvasText" },
    forcedColorAdjust: "none",
  },
  runStrip: {
    insetBlock: { default: 0, [FORCED]: null },
  },
  runLane: {
    blockSize: `calc(3 * ${grasp.hairline})`,
    borderRadius: grasp.cornerPill,
  },
  place: (start: string, size: string) => ({
    insetInlineStart: start,
    inlineSize: size,
  }),
  // In forced colours, where every tone is one ink, a speaker's stretches stand at a height of their own.
  forcedLane: (lane: number, count: number) => ({
    insetBlockStart: {
      default: null,
      [FORCED]: `${((lane / count) * 100).toFixed(2)}%`,
    },
    blockSize: { default: null, [FORCED]: `${(100 / count).toFixed(2)}%` },
  }),
  // Lanes: each speaker's line at their place in the track, the first at the top.
  lane: (lane: number, count: number) => ({
    insetBlockStart: `calc(${lane} * (100% - 3 * ${grasp.hairline}) / ${Math.max(count - 1, 1)})`,
  }),
  // Where a chapter starts: two pixels of the box's own ground through the strip, its only gap.
  cut: {
    position: "absolute",
    insetBlock: 0,
    zIndex: 1,
    inlineSize: `calc(2 * ${grasp.hairline})`,
    marginInlineStart: `calc(-1 * ${grasp.hairline})`,
    backgroundColor: { default: grasp.raised, [FORCED]: "Canvas" },
    pointerEvents: "none",
  },
  at: (start: string) => ({ insetInlineStart: start }),
  // A moment: an unseen press area on the strip, its mark a small round dot in the middle of it.
  mark: {
    position: "absolute",
    zIndex: 2,
    insetBlock: 0,
    display: "grid",
    placeItems: "center",
    inlineSize: grasp.space6,
    marginInlineStart: `calc(-0.5 * ${grasp.space6})`,
    padding: 0,
    borderWidth: 0,
    borderRadius: grasp.cornerCircle,
    backgroundColor: "transparent",
    cursor: "pointer",
    touchAction: "manipulation",
  },
  // The dot, in its kind's tone, ringed in the box's own ground so it reads on any speaker's tone;
  // it grows a little under the pointer and with keyboard focus, by transform alone.
  dot: {
    boxSizing: "border-box",
    inlineSize: `calc(${grasp.space1} + 2 * ${grasp.hairline})`,
    blockSize: `calc(${grasp.space1} + 2 * ${grasp.hairline})`,
    borderRadius: grasp.cornerCircle,
    backgroundColor: { default: toneVars.ink, [FORCED]: "ButtonText" },
    boxShadow: {
      default: `0 0 0 ${grasp.ringWidth} ${grasp.raised}`,
      [FORCED]: "none",
    },
    // In forced colours, where shadows are dropped, a real edge of the page's ground round it.
    borderWidth: { default: 0, [FORCED]: grasp.ringWidth },
    borderStyle: "solid",
    borderColor: "Canvas",
    forcedColorAdjust: "none",
    transform: {
      default: null,
      [stylex.when.ancestor(":hover")]: {
        default: null,
        [media.hover]: "scale(1.5)",
      },
      [stylex.when.ancestor(":focus-visible")]: "scale(1.5)",
    },
    transitionProperty: "transform",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
  },
  // The dot keeps its round shape under the system's ring (focus.label sets the small corner and its shape).
  round: {
    borderRadius: grasp.cornerCircle,
    cornerShape: "round",
    outlineOffset: grasp.ringOffsetMark,
  },
  // The active moment: the same dot, a step stronger: its ring in its own tone, not the ground.
  dotActive: {
    // Its halo as tall as the playhead (space-2 and space-1), so the playhead never pokes out of it.
    boxShadow: {
      default: `0 0 0 calc((${grasp.space2} + ${grasp.space1} - ${grasp.space1} - 2 * ${grasp.hairline}) / 2) ${toneVars.mid}`,
      [FORCED]: "none",
    },
    backgroundColor: { default: toneVars.ink, [FORCED]: "Highlight" },
  },
  // A finger needs 44px: on a touch screen an unseen area round the mark makes up the difference.
  reach: {
    position: "absolute",
    insetInline: {
      default: 0,
      [COARSE]: `calc((${grasp.space6} - ${grasp.tap}) / 2)`,
    },
    insetBlock: {
      default: 0,
      [COARSE]: `calc((${grasp.controlSm} - ${grasp.tap}) / 2)`,
    },
  },
  // Where the sound is: a mint hairline through the strip.
  playhead: {
    position: "absolute",
    zIndex: 1,
    // A little past the strip at each end, no taller than the chosen moment's halo, so where the
    // sound stands on a moment the halo covers it (eyes-b, B3-interview-30).
    insetBlockStart: `calc((${grasp.controlSm} - ${grasp.space2}) / 2 - ${grasp.space1} / 2)`,
    blockSize: `calc(${grasp.space2} + ${grasp.space1})`,
    inlineSize: grasp.ringWidth,
    marginInlineStart: `calc(-0.5 * ${grasp.ringWidth})`,
    borderRadius: grasp.hairline,
    backgroundColor: { default: grasp.mintDeep, [FORCED]: "Highlight" },
    forcedColorAdjust: "none",
    pointerEvents: "none",
  },
  // One quiet line under the strip, always as tall: what is under the pointer or focus, else the
  // chapter the sound is in.
  caption: {
    gridArea: "caption",
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    blockSize: grasp.badgeHeight,
    margin: 0,
    minWidth: 0,
    overflow: "hidden",
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  captionWords: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});

/** A share of the whole as a length: "12.5%". */
const share = (ms: number, total: number) =>
  `${((Math.min(Math.max(ms, 0), total) / total) * 100).toFixed(2)}%`;

/** A run of turns by one speaker: who, and from when to when. */
interface Run {
  speaker: string;
  start: number;
  end: number;
}

/** The turns joined into runs by speaker, so a long transcript draws a stretch per run, not per turn. */
const runsOf = (turns: readonly InterviewTurn[]) => {
  const runs: Run[] = [];
  for (const [index, turn] of turns.entries()) {
    const start = turn.startMs ?? 0;
    const end = endOf(turns, index);
    const last = runs.at(-1);
    if (last?.speaker === turn.speaker) {
      runs[runs.length - 1] = { ...last, end: Math.max(last.end, end) };
    } else {
      runs.push({ speaker: turn.speaker, start, end });
    }
  }
  // Each stretch reaches the next, so speakers meet with no slit between them.
  return runs.map((run, index) => ({
    ...run,
    end: runs[index + 1]?.start ?? run.end,
  }));
};

/** One mark: a highlight at its turn's start. */
interface Mark {
  id: string;
  turn: number;
  ms: number;
  kind: ReturnType<InterviewValue["kindOf"]>;
}

/** Every highlight as a mark, in the order of the conversation. */
const marksOf = (shared: InterviewValue): Mark[] =>
  [...shared.marks.values()]
    .flat()
    .map((placed) => ({
      id: placed.highlight.id,
      turn: placed.turn,
      ms: shared.turns[placed.turn]?.startMs ?? 0,
      kind: shared.kindOf(placed.highlight.kind),
    }))
    .toSorted((a, b) => a.ms - b.ms);

/** The chapters by where they start, in the order of the conversation. */
const chaptersOf = (shared: InterviewValue) =>
  shared.chapters
    .map((chapter) => ({
      title: chapter.title,
      ms: shared.turns[chapter.firstTurn]?.startMs ?? 0,
    }))
    .toSorted((a, b) => a.ms - b.ms);

/** The mark a key moves to, or null for a key that does not move. Left and Right turn round right to left. */
const moveFor = (
  key: string,
  at: number,
  count: number,
  rtl: boolean
): number | null => {
  const back = rtl ? "ArrowRight" : "ArrowLeft";
  const on = rtl ? "ArrowLeft" : "ArrowRight";
  const moves: Record<string, number> = {
    [back]: at - 1,
    [on]: at + 1,
    ArrowUp: at - 1,
    ArrowDown: at + 1,
    Home: 0,
    End: count - 1,
  };
  const to = moves[key];
  return to === undefined ? null : Math.min(Math.max(to, 0), count - 1);
};

/** What the caption names: a moment, by its place among the marks, or a speaker's stretch, by its run. */
type Shown = { mark: number } | { run: number } | null;

/** Where the sound is in milliseconds, or where the active turn starts before it plays; null for neither. */
const useNow = (shared: InterviewValue) => {
  const time = useInterviewTime();
  return (
    time ??
    (shared.active === null
      ? null
      : (shared.turns[shared.active]?.startMs ?? null))
  );
};

/** Where the sound is, as a mint hairline. Its own part, so only it follows the sound. */
const Playhead = ({
  shared,
  total,
}: {
  shared: InterviewValue;
  total: number;
}) => {
  const ms = useNow(shared);
  return ms === null ? null : (
    <span
      aria-hidden="true"
      data-slot="interview-playhead"
      {...stylex.props(styles.playhead, styles.at(share(ms, total)))}
    />
  );
};

/** A time at the strip's end, as wide as the length laid unseen under it. */
const Time = ({
  slot,
  side,
  words,
  length,
}: {
  slot: string;
  side: "now" | "length";
  words: string;
  length: string;
}) => (
  <span
    aria-hidden="true"
    data-slot={slot}
    {...stylex.props(styles.time, styles[side])}
  >
    <span {...stylex.props(styles.unseen)}>{length}</span>
    <span {...stylex.props(styles.timeStack)}>{words}</span>
  </span>
);

/** Where the sound is, written at the strip's start. */
const Now = ({ shared, total }: { shared: InterviewValue; total: number }) => (
  <Time
    slot="interview-now"
    side="now"
    words={shared.words.clock(useNow(shared) ?? 0)}
    length={shared.words.clock(total)}
  />
);

interface MarksProps {
  shared: InterviewValue;
  marks: readonly Mark[];
  total: number;
  label: string;
  onShow: (shown: Shown) => void;
}

/** The marks, one tab stop, the arrows between them. */
const Marks = ({ shared, marks, total, label, onShow }: MarksProps) => {
  const [focused, setFocused] = useState<number | null>(null);
  const activeMark = marks.findIndex((mark) => mark.turn === shared.active);
  const stop = focused ?? Math.max(activeMark, 0);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const to = moveFor(event.key, stop, marks.length, rtl);
    if (to === null) {
      return;
    }
    event.preventDefault();
    setFocused(to);
    const all = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        "[data-slot=interview-mark]"
      ),
    ];
    all[to]?.focus();
  };
  return (
    <div
      role="toolbar"
      aria-label={label}
      // The toolbar itself is never a stop: its marks are, one at a time.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (
          !(
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          )
        ) {
          setFocused(null);
          onShow(null);
        }
      }}
    >
      {marks.map((mark, index) => (
        <button
          key={mark.id}
          type="button"
          data-slot="interview-mark"
          data-tone={mark.kind.tone}
          tabIndex={index === stop ? 0 : -1}
          aria-label={shared.words.mark(
            mark.kind.label,
            shared.words.clock(mark.ms)
          )}
          aria-current={mark.turn === shared.active ? "true" : undefined}
          onFocus={() => {
            setFocused(index);
            onShow({ mark: index });
          }}
          onPointerEnter={() => {
            onShow({ mark: index });
          }}
          onPointerLeave={() => {
            onShow(focused === null ? null : { mark: focused });
          }}
          onClick={() => {
            shared.go(mark.turn);
          }}
          // The ring is the system's, drawn round the dot itself, not the press area, so it stays on the strip.
          {...stylex.props(
            styles.mark,
            styles.at(share(mark.ms, total)),
            tones[mark.kind.tone],
            stylex.defaultMarker(),
            focusMarker,
            focus.carrier
          )}
        >
          <span aria-hidden="true" {...stylex.props(styles.reach)} />
          <span
            aria-hidden="true"
            data-slot="interview-mark-sign"
            {...stylex.props(
              styles.dot,
              mark.turn === shared.active && styles.dotActive,
              focus.label,
              styles.round
            )}
          />
        </button>
      ))}
    </div>
  );
};

/** The speakers' keys in the order they first spoke: their places, from the first. */
const orderOf = (turns: readonly InterviewTurn[]) => [
  ...new Set(turns.map((turn) => turn.speaker)),
];

/** A speaker's tone, by their key. */
const toneFor = (shared: InterviewValue, key: string): InterviewTone =>
  shared.people.get(key)?.tone ?? "neutral";

/** A speaker's name, by their key. */
const nameFor = (shared: InterviewValue, key: string) =>
  shared.people.get(key)?.name ?? key;

interface RunsProps {
  shared: InterviewValue;
  order: readonly string[];
  runs: readonly Run[];
  total: number;
  lanes: boolean;
  onShow: (shown: Shown) => void;
}

/** The speakers' stretches, a list: each says who and when to a screen reader, and is named in the caption under the pointer. */
const Runs = ({ shared, order, runs, total, lanes, onShow }: RunsProps) => (
  <ol
    aria-label={shared.words.runs}
    {...stylex.props(styles.runs, lanes && styles.trackLanes)}
  >
    {runs.map((run, index) => {
      const lane = Math.max(order.indexOf(run.speaker), 0);
      return (
        <li
          key={`${run.start}-${run.speaker}`}
          data-slot="interview-run"
          data-speaker={run.speaker}
          onPointerEnter={() => {
            onShow({ run: index });
          }}
          onPointerLeave={() => {
            onShow(null);
          }}
          {...stylex.props(
            styles.run,
            tones[toneFor(shared, run.speaker)],
            lanes
              ? [styles.runLane, styles.lane(lane, order.length)]
              : [styles.runStrip, styles.forcedLane(lane, order.length)],
            styles.place(
              share(run.start, total),
              share(run.end - run.start, total)
            )
          )}
        >
          <span {...stylex.props(visuallyHidden)}>
            {shared.words.run(
              nameFor(shared, run.speaker),
              shared.words.clock(run.start),
              shared.words.clock(run.end)
            )}
          </span>
        </li>
      );
    })}
  </ol>
);

/** Where a press on the strip falls, in milliseconds: from its start, the other way right to left. */
const msAt = (event: MouseEvent<HTMLElement>, total: number) => {
  const box = event.currentTarget.getBoundingClientRect();
  const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
  const from = rtl ? box.right - event.clientX : event.clientX - box.left;
  return Math.min(Math.max(from / box.width, 0), 1) * total;
};

interface PlotProps {
  shared: InterviewValue;
  order: readonly string[];
  runs: readonly Run[];
  marks: readonly Mark[];
  total: number;
  label: string;
  lanes: boolean;
  onShow: (shown: Shown) => void;
}

/** The strip: who spoke when, the chapters' cuts, the marks and the playhead. A press anywhere on it sends the sound there. */
const Plot = ({
  shared,
  order,
  runs,
  marks,
  total,
  label,
  lanes,
  onShow,
}: PlotProps) => (
  // A pointer's way to a moment; the keyboard has the marks, and the player's keys move the sound.
  <div
    role="presentation"
    data-slot="interview-plot"
    onClick={(event) => {
      const onMark =
        event.target instanceof Element &&
        event.target.closest("[data-slot=interview-mark]") !== null;
      if (shared.seeks && !onMark) {
        shared.seek(msAt(event, total));
      }
    }}
    {...stylex.props(styles.plot, shared.seeks && styles.seeks)}
  >
    <span {...stylex.props(lanes ? styles.track : styles.bar)}>
      <Runs
        shared={shared}
        order={order}
        runs={runs}
        total={total}
        lanes={lanes}
        onShow={onShow}
      />
      {chaptersOf(shared)
        .filter((chapter) => chapter.ms > 0)
        .map((chapter) => (
          <span
            key={`${chapter.ms}-${chapter.title}`}
            aria-hidden="true"
            data-slot="interview-cut"
            {...stylex.props(styles.cut, styles.at(share(chapter.ms, total)))}
          />
        ))}
    </span>
    <Playhead shared={shared} total={total} />
    <Marks
      shared={shared}
      marks={marks}
      total={total}
      label={label}
      onShow={onShow}
    />
  </div>
);

interface CaptionProps {
  shared: InterviewValue;
  shown: Shown;
  marks: readonly Mark[];
  runs: readonly Run[];
}

/** The chapter the sound is in, or the first; its title, or nothing. */
const ChapterAt = ({ shared }: { shared: InterviewValue }) => {
  const ms = useNow(shared) ?? 0;
  const chapter =
    chaptersOf(shared).findLast((each) => each.ms <= ms) ??
    chaptersOf(shared)[0];
  return <span {...stylex.props(styles.captionWords)}>{chapter?.title}</span>;
};

/** What the caption reads: the moment or stretch under the pointer or focus, else the chapter. */
const CaptionWords = ({ shared, shown, marks, runs }: CaptionProps) => {
  const run = shown !== null && "run" in shown ? runs[shown.run] : undefined;
  const mark =
    shown !== null && "mark" in shown ? marks[shown.mark] : undefined;
  if (run !== undefined) {
    return (
      <span {...stylex.props(styles.captionWords)}>
        {shared.words.at(
          nameFor(shared, run.speaker),
          shared.words.clock(run.start)
        )}
      </span>
    );
  }
  if (mark !== undefined) {
    return (
      <>
        <KindPill
          tone={mark.kind.tone}
          icon={mark.kind.icon}
          mark={shared.kindMark}
        >
          {mark.kind.label}
        </KindPill>
        <span {...stylex.props(styles.captionWords)}>
          {shared.words.clock(mark.ms)}
        </span>
      </>
    );
  }
  return <ChapterAt shared={shared} />;
};

interface BodyProps {
  shared: InterviewValue;
  label: string | undefined;
  look: InterviewTimelineLook;
  layout: InterviewLayoutStyle | undefined;
}

/** The strip inside its interview, with its times and its one caption line. */
const Strip = ({ shared, label, look, layout }: BodyProps) => {
  const [shown, setShown] = useState<Shown>(null);
  const total = lengthOf(shared.turns, shared.media?.duration);
  const order = orderOf(shared.turns);
  const { lang, words: wording } = langOf(undefined, shared.lang);
  const runs = runsOf(shared.turns);
  const marks = marksOf(shared);
  return (
    <div
      data-slot="interview-timeline"
      data-look={look}
      lang={lang}
      {...stylex.props(styles.root, wording, layout)}
    >
      <Now shared={shared} total={total} />
      <Plot
        shared={shared}
        order={order}
        runs={runs}
        marks={marks}
        total={total}
        label={label ?? shared.words.timeline}
        lanes={look === "lanes"}
        onShow={setShown}
      />
      <Time
        slot="interview-length"
        side="length"
        words={shared.words.clock(total)}
        length={shared.words.clock(total)}
      />
      {/* Seen, not said: each stretch, mark and chapter says itself. */}
      <p
        aria-hidden="true"
        data-slot="interview-caption"
        {...stylex.props(styles.caption)}
      >
        <CaptionWords shared={shared} shown={shown} marks={marks} runs={runs} />
      </p>
    </div>
  );
};

/** The timeline inside its interview: the strip, inside the interview's player when it has sound; nothing without times. */
const Body = ({
  shared,
  label,
  look,
  player,
  layout,
}: BodyProps & { player: boolean }) => {
  const total = lengthOf(shared.turns, shared.media?.duration);
  if (!timed(shared.turns) || total <= 0) {
    return null;
  }
  const strip = (
    <Strip
      shared={shared}
      label={label}
      look={look}
      layout={player && shared.media !== undefined ? undefined : layout}
    />
  );
  return player && shared.media !== undefined ? (
    <InterviewMoment track={strip} aria-label={label} layout={layout} />
  ) : (
    strip
  );
};

/** The conversation as one strip. Inside an Interview it shows that one; alone, the one its props give. */
export const InterviewTimeline = ({
  label: labelDeprecated,
  "aria-label": label = labelDeprecated,
  look: lookDeprecated,
  variant: look = lookDeprecated ?? "strip",
  player = true,
  style: styleProp,
  layout,
  ...data
}: InterviewTimelineProps) => {
  const shared = useInterview();
  if (shared === null) {
    return (
      <Interview {...data}>
        <InterviewTimeline
          label={label}
          look={look}
          player={player}
          layout={layout ?? styleProp}
        />
      </Interview>
    );
  }
  return (
    <Body
      shared={shared}
      label={label}
      look={look}
      player={player}
      layout={layout ?? styleProp}
    />
  );
};
