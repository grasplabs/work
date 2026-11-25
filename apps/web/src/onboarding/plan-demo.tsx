import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

import type { Moment } from "./plan.ts";

// The plan's story shown as the thing itself, sped up (plan-story.tsx):
// while Stephen tells the two weeks, the admin watches them happen, one
// scene morphing into the next rather than one replacing another. A rail
// of the plan's four days runs along the top, lit up to where the story
// is. On the left, one interview: Mila, who knows the work, talking with
// Stephen about her mornings. Then her words fold away and the whole
// company comes out of her: a tile for each person flies out of her
// picture into place and lights up as they talk, counted, until every one
// has and the interviews close. On the right, the report waits for its
// day; when it comes, the people fly over into it, grouped by what they
// raised, each theme a row of the very tiles that said it, the longest
// first. Then the first theme opens, and Mila's own words are in it. The
// moves are FLIP: an element measured where it was and played from there
// to where it is now (Web Animations), so nothing snaps. Decoration for
// sighted people only (the words above it say it all).

/** The parts of the story, in its order. */
export type Scene =
  | "you"
  | "first"
  | "everyone"
  | "close"
  | "learned"
  | "finding"
  | "rest";

const order: Scene[] = [
  "you",
  "first",
  "everyone",
  "close",
  "learned",
  "finding",
  "rest",
];

/** How far into the story `scene` is, by its place in it. */
const indexOf = (scene: Scene): number => order.indexOf(scene);

/** How many people the company has, in the demo. */
const PEOPLE = 42;

const hash = (n: number): number => {
  const s = Math.sin(n * 127.1 + 311.7) * 43_758.5453;
  return s - Math.floor(s);
};

/** Each person's initials; the first is Mila de Vries. */
const initialsOf = (i: number): string =>
  i === 0
    ? "MV"
    : String.fromCodePoint(65 + Math.floor(hash(i * 3.7) * 26)) +
      String.fromCodePoint(65 + Math.floor(hash(i * 9.1) * 26));

/** The order people talk in, Mila first: a person's rank, by index. */
const talkRank = (() => {
  const rest = Array.from({ length: PEOPLE - 1 }, (_, k) => k + 1).toSorted(
    (a, b) => hash(a * 5.3) - hash(b * 5.3)
  );
  const rank = new Map<number, number>([[0, 0]]);
  for (const [r, i] of rest.entries()) {
    rank.set(i, r + 1);
  }
  return rank;
})();

/** How many raised each theme, most first; Mila raised the first. */
const themeSizes = [13, 9, 7, 5] as const;

/** Who raised each theme: people by index, Mila first in the first. */
const themePeople = (() => {
  const pool = Array.from({ length: PEOPLE - 1 }, (_, k) => k + 1).toSorted(
    (a, b) => hash(a * 2.9) - hash(b * 2.9)
  );
  let at = 0;
  return themeSizes.map((size, theme) => {
    const people = theme === 0 ? [0] : [];
    while (people.length < size) {
      people.push(pool[at] ?? 1);
      at += 1;
    }
    return people;
  });
})();

const EASE = "cubic-bezier(0.2, 0.75, 0.2, 1)";

/**
 * FLIP: `element`, already where it now stands, played from `from` (the box it comes out of) to
 * there: moved and scaled from that box's middle, faded in on the way if `fade`.
 */
const flyFrom = (
  element: Element,
  from: DOMRect,
  { delay = 0, ms = 900, fade = true } = {}
): void => {
  const to = element.getBoundingClientRect();
  if (to.width === 0 || from.width === 0) {
    return;
  }
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const scale = from.width / to.width;
  element.animate(
    [
      {
        transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
        opacity: fade ? 0 : 1,
      },
      { transform: "none", opacity: 1 },
    ],
    { duration: ms, delay, easing: EASE, fill: "backwards" }
  );
};

const styles = stylex.create({
  demo: {
    display: "grid",
    gap: space[5],
    width: "100%",
    maxWidth: "62rem",
  },
  rail: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: space[2],
  },
  stop: {
    display: "grid",
    alignContent: "start",
    gap: space[1],
    paddingTop: space[3],
    borderTopWidth: 2,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    color: colors.subtleForeground,
    transitionProperty: "border-color, color",
    transitionDuration: "600ms",
    transitionTimingFunction: duration.ease,
  },
  stopPast: {
    borderTopColor: colors.mintDeep,
    color: colors.mutedForeground,
  },
  stopNow: { color: colors.foreground },
  stopDate: {
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    fontVariantNumeric: "tabular-nums",
  },
  stopWhat: {
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    display: { default: "block", [media.maxSm]: "none" },
  },
  panels: {
    display: "grid",
    gridTemplateColumns: { default: "1fr 1fr", [media.maxSm]: "1fr" },
    gap: space[4],
    alignItems: "stretch",
  },
  card: {
    display: "grid",
    alignContent: "start",
    gap: space[4],
    minHeight: { default: "21rem", [media.maxSm]: "auto" },
    padding: space[5],
    borderRadius: radius.xl,
    backgroundColor: colors.card,
    boxShadow: shadow.md,
  },
  // Two heads in one place, one fading into the other.
  heads: { display: "grid" },
  head: {
    gridArea: "1 / 1",
    display: "flex",
    alignItems: "center",
    gap: space[3],
    minHeight: "2.75rem",
    transitionProperty: "opacity, transform",
    transitionDuration: "600ms",
    transitionTimingFunction: duration.ease,
  },
  headGone: {
    opacity: 0,
    transform: "translateY(-6px)",
    pointerEvents: "none",
  },
  eyebrow: {
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightMedium,
    color: colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  avatar: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: "2.75rem",
    height: "2.75rem",
    borderRadius: radius.full,
    backgroundColor: colors.brandMint,
    color: colors.brandNight,
    fontSize: font.textSm,
    fontWeight: font.weightMedium,
  },
  who: { display: "grid", flexGrow: 1, minWidth: 0 },
  name: {
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
  },
  role: {
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
  },
  live: {
    display: "flex",
    alignItems: "center",
    gap: "3px",
    height: "1.25rem",
  },
  bar: {
    display: "block",
    width: "3px",
    height: "100%",
    borderRadius: radius.full,
    backgroundColor: colors.mintDeep,
    animationName: stylex.keyframes({
      "0%, 100%": { transform: "scaleY(0.3)" },
      "50%": { transform: "scaleY(1)" },
    }),
    animationDuration: "900ms",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
  },
  quiet: { animationPlayState: "paused", opacity: 0.35 },
  // What folds away: its row goes to nothing, so what is below rises into its place.
  fold: {
    display: "grid",
    gridTemplateRows: "1fr",
    transitionProperty: "grid-template-rows, opacity",
    transitionDuration: "700ms",
    transitionTimingFunction: duration.ease,
  },
  folded: { gridTemplateRows: "0fr", opacity: 0 },
  foldInner: {
    display: "grid",
    gap: space[3],
    minHeight: 0,
    overflow: "hidden",
  },
  turn: {
    margin: 0,
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    color: colors.foreground,
    opacity: 0,
    transform: "translateY(6px)",
    transitionProperty: "opacity, transform",
    transitionDuration: "500ms",
    transitionTimingFunction: duration.ease,
  },
  stephen: { color: colors.mutedForeground, fontStyle: "italic" },
  turnShown: { opacity: 1, transform: "none" },
  crowd: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(2.25rem, 1fr))",
    gap: space[2],
  },
  tile: {
    display: "grid",
    placeItems: "center",
    aspectRatio: "1",
    borderRadius: radius.full,
    backgroundColor: colors.muted,
    color: colors.subtleForeground,
    fontSize: font.textXs,
    fontWeight: font.weightMedium,
    transitionProperty: "background-color, color, opacity, box-shadow",
    transitionDuration: "400ms",
    transitionTimingFunction: duration.ease,
  },
  tileTalking: {
    backgroundColor: colors.brandMint,
    color: colors.brandNight,
    boxShadow: `0 0 0 3px ${colors.successSubtle}`,
  },
  tileDone: { backgroundColor: colors.successSubtle, color: colors.pine },
  // Gone over to the report: what is left is a trace.
  tileLeft: { opacity: 0.25 },
  count: {
    fontFamily: font.serif,
    fontSize: font.headingMd,
    lineHeight: font.headingMdLine,
    color: colors.foreground,
    fontVariantNumeric: "tabular-nums",
  },
  pill: {
    justifySelf: "start",
    paddingInline: space[3],
    paddingBlock: space[1],
    borderRadius: radius.full,
    backgroundColor: colors.foreground,
    color: colors.background,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    opacity: 0,
    transform: "scale(0.9)",
    transitionProperty: "opacity, transform",
    transitionDuration: "500ms",
    transitionTimingFunction: duration.ease,
  },
  pillShown: { opacity: 1, transform: "none" },
  themes: { display: "grid", gap: space[1] },
  theme: {
    display: "grid",
    gap: space[2],
    padding: space[3],
    borderRadius: radius.lg,
    transitionProperty: "background-color",
    transitionDuration: "700ms",
  },
  themeOpen: { backgroundColor: colors.successSubtle },
  themeHead: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    alignItems: "baseline",
    gap: space[3],
  },
  titleCell: { display: "grid" },
  themeTitle: {
    gridArea: "1 / 1",
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
    transitionProperty: "opacity",
    transitionDuration: "500ms",
  },
  themeTitleOpen: {
    fontFamily: font.serif,
    fontWeight: font.weightNormal,
    fontSize: font.headingSm,
    lineHeight: font.headingSmLine,
  },
  themeCount: {
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    transitionProperty: "opacity",
    transitionDuration: "500ms",
  },
  hidden: { opacity: 0 },
  // Before its day: where a theme will be, a grey line.
  placeholder: {
    gridArea: "1 / 1",
    alignSelf: "center",
    height: "0.6rem",
    width: "70%",
    borderRadius: radius.full,
    backgroundColor: colors.muted,
    transitionProperty: "opacity",
    transitionDuration: "500ms",
  },
  dots: { display: "flex", flexWrap: "wrap", gap: "4px" },
  dot: {
    display: "grid",
    placeItems: "center",
    width: "1.375rem",
    height: "1.375rem",
    borderRadius: radius.full,
    backgroundColor: colors.successSubtle,
    color: colors.pine,
    fontSize: "0.5625rem",
    fontWeight: font.weightMedium,
    transitionProperty: "background-color, color",
    transitionDuration: "500ms",
  },
  dotMila: { backgroundColor: colors.brandMint, color: colors.brandNight },
  dotEmpty: { backgroundColor: colors.muted, color: "transparent" },
  quote: {
    margin: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
    fontStyle: "italic",
  },
});

const moving = stylex.create({
  delay: (ms: string) => ({ animationDelay: ms }),
});

/** The rail of the plan's four days, lit up to where the story is. */
const Rail = ({
  scene,
  dates,
}: {
  scene: Scene;
  dates: Record<Moment, string>;
}) => {
  const { t } = useLingui();
  const now = indexOf(scene);
  const stops: { id: Moment; at: number; what: string }[] = [
    {
      id: "first",
      at: 1,
      what: t`The people who know the work best go first`,
    },
    { id: "everyone", at: 2, what: t`Everyone else gets their own link` },
    { id: "close", at: 3, what: t`The interviews close` },
    { id: "findings", at: 4, what: t`You get what I learned` },
  ];
  return (
    <div {...stylex.props(styles.rail)}>
      {stops.map((stop, i) => {
        const next = stops[i + 1]?.at ?? Number.POSITIVE_INFINITY;
        return (
          <div
            key={stop.id}
            {...stylex.props(
              styles.stop,
              now >= stop.at && styles.stopPast,
              now >= stop.at && now < next && styles.stopNow
            )}
          >
            <span {...stylex.props(styles.stopDate)}>{dates[stop.id]}</span>
            <span {...stylex.props(styles.stopWhat)}>{stop.what}</span>
          </div>
        );
      })}
    </div>
  );
};

/** A voice talking: a few bars, still when nobody is. */
const Live = ({ on }: { on: boolean }) => (
  <span {...stylex.props(styles.live)}>
    {[0, 1, 2, 3, 4].map((bar) => (
      <span
        key={bar}
        {...stylex.props(
          styles.bar,
          moving.delay(`${bar * -170}ms`),
          !on && styles.quiet
        )}
      />
    ))}
  </span>
);

/** What the story shows at a moment: how far each part of it has come. */
interface Shown {
  heard: number;
  crowd: boolean;
  talked: number;
  closed: boolean;
  reported: boolean;
  themesIn: number;
  open: boolean;
}

const shownAt = (scene: Scene, progress: number): Shown => {
  const now = indexOf(scene);
  const closed = now >= indexOf("close");
  const open = now >= indexOf("finding");
  // The interview, told over its own part, whole once the story is past it.
  let heard = now > indexOf("first") ? 1 : 0;
  if (scene === "first") {
    heard = progress;
  }
  // The company talking over its part: Mila first, then the rest in their order.
  let talked = 0;
  if (scene === "everyone") {
    talked = Math.max(1, Math.round(progress * PEOPLE * 0.93));
  } else if (closed) {
    talked = PEOPLE;
  }
  // The themes coming in one after another over the report's part.
  let themesIn = 0;
  if (scene === "learned") {
    themesIn = Math.min(themeSizes.length, Math.floor(progress * 5.5));
  } else if (open) {
    themesIn = themeSizes.length;
  }
  return {
    heard,
    crowd: now >= indexOf("everyone"),
    talked,
    closed,
    reported: now >= indexOf("learned"),
    themesIn,
    open,
  };
};

/** The morphs, played as the story moves on: what was where, flown to where it is now. */
const useMorphs = (
  root: RefObject<HTMLDivElement | null>,
  crowd: boolean,
  themesIn: number
): void => {
  const was = useRef({ crowd, themesIn });
  useLayoutEffect(() => {
    const element = root.current;
    const before = was.current;
    was.current = { crowd, themesIn };
    if (
      element === null ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    // The company comes out of Mila: every tile flies out of her picture into its place.
    if (crowd && !before.crowd) {
      const from = element
        .querySelector("[data-mila]")
        ?.getBoundingClientRect();
      if (from !== undefined) {
        for (const tile of element.querySelectorAll<HTMLElement>(
          "[data-tile]"
        )) {
          const i = Number(tile.dataset.tile);
          flyFrom(tile, from, {
            delay: i === 0 ? 0 : 120 + (talkRank.get(i) ?? 0) * 16,
            fade: i !== 0,
          });
        }
      }
    }
    // The people go over to the report: each dot of a theme just come flies from its tile.
    if (themesIn > before.themesIn) {
      for (const dot of element.querySelectorAll<HTMLElement>("[data-dot]")) {
        const [theme = 0, i = 0, k = 0] = (dot.dataset.dot ?? "")
          .split(":")
          .map(Number);
        if (theme >= before.themesIn && theme < themesIn) {
          const from = element
            .querySelector(`[data-tile="${String(i)}"]`)
            ?.getBoundingClientRect();
          if (from !== undefined) {
            flyFrom(dot, from, { delay: k * 24, ms: 1000, fade: false });
          }
        }
      }
    }
  }, [root, crowd, themesIn]);
};

/** The two weeks, happening: the rail, the people, the report. */
export const PlanDemo = ({
  scene,
  progress,
  dates,
}: {
  scene: Scene;
  /** How far the current part is told, 0 to 1. */
  progress: number;
  /** The plan's four days, as the rail shows them. */
  dates: Record<Moment, string>;
}) => {
  const { t } = useLingui();
  const root = useRef<HTMLDivElement>(null);
  const { heard, crowd, talked, closed, reported, themesIn, open } = shownAt(
    scene,
    progress
  );
  const turns = [
    { by: "stephen", text: t`Walk me through a normal morning.` },
    { by: "mila", text: t`I spend the first two hours just sorting email.` },
    {
      by: "mila",
      text: t`Half of it is the same questions, answered again and again.`,
    },
  ] as const;
  const themes = [
    t`Email eats the first hours of the day`,
    t`Approvals wait on one person`,
    t`The same numbers are typed in twice`,
    t`Nobody knows where the latest file is`,
  ];

  useMorphs(root, crowd, themesIn);

  const inReport = new Set(themePeople.slice(0, themesIn).flat());
  return (
    <div aria-hidden="true" ref={root} {...stylex.props(styles.demo)}>
      <Rail dates={dates} scene={scene} />
      <div {...stylex.props(styles.panels)}>
        <div {...stylex.props(styles.card)}>
          <div {...stylex.props(styles.heads)}>
            <div {...stylex.props(styles.head, crowd && styles.headGone)}>
              <span data-mila="" {...stylex.props(styles.avatar)}>
                MV
              </span>
              <span {...stylex.props(styles.who)}>
                <span {...stylex.props(styles.name)}>Mila de Vries</span>
                <span {...stylex.props(styles.role)}>{t`Operations lead`}</span>
              </span>
              <Live on={heard > 0 && heard < 1} />
            </div>
            <div {...stylex.props(styles.head, !crowd && styles.headGone)}>
              <span {...stylex.props(styles.who)}>
                <span {...stylex.props(styles.eyebrow)}>
                  {t`Talked with Stephen`}
                </span>
                <span {...stylex.props(styles.count)}>
                  {talked} / {PEOPLE}
                </span>
              </span>
              <Live on={crowd && !closed} />
            </div>
          </div>
          <div {...stylex.props(styles.fold, crowd && styles.folded)}>
            <div {...stylex.props(styles.foldInner)}>
              {turns.map((turn, i) => (
                <p
                  key={turn.text}
                  {...stylex.props(
                    styles.turn,
                    turn.by === "stephen" && styles.stephen,
                    heard > i * 0.28 && styles.turnShown
                  )}
                >
                  {turn.text}
                </p>
              ))}
            </div>
          </div>
          {crowd ? (
            <div {...stylex.props(styles.crowd)}>
              {Array.from({ length: PEOPLE }, (_, i) => {
                const rank = talkRank.get(i) ?? 0;
                return (
                  <span
                    data-tile={i}
                    key={i}
                    {...stylex.props(
                      styles.tile,
                      rank < talked && styles.tileDone,
                      !closed &&
                        rank >= talked &&
                        rank < talked + 4 &&
                        styles.tileTalking,
                      inReport.has(i) && styles.tileLeft
                    )}
                  >
                    {initialsOf(i)}
                  </span>
                );
              })}
            </div>
          ) : null}
          {crowd ? (
            <span
              {...stylex.props(
                styles.pill,
                closed && !reported && styles.pillShown
              )}
            >
              {t`Interviews closed`}
            </span>
          ) : null}
        </div>
        <div {...stylex.props(styles.card)}>
          <div {...stylex.props(styles.head)}>
            <span {...stylex.props(styles.who)}>
              <span {...stylex.props(styles.eyebrow)}>{dates.findings}</span>
              <span {...stylex.props(styles.name)}>{t`What I learned`}</span>
              <span {...stylex.props(styles.role)}>
                {t`Each theme, with the people who raised it`}
              </span>
            </span>
          </div>
          <div {...stylex.props(styles.themes)}>
            {themes.map((title, theme) => {
              const shown = theme < themesIn;
              const isOpen = open && theme === 0;
              const people = themePeople[theme] ?? [];
              const count = people.length;
              return (
                <div
                  key={title}
                  {...stylex.props(styles.theme, isOpen && styles.themeOpen)}
                >
                  <div {...stylex.props(styles.themeHead)}>
                    <span {...stylex.props(styles.titleCell)}>
                      <span
                        {...stylex.props(
                          styles.placeholder,
                          shown && styles.hidden
                        )}
                      />
                      <span
                        {...stylex.props(
                          styles.themeTitle,
                          isOpen && styles.themeTitleOpen,
                          !shown && styles.hidden
                        )}
                      >
                        {title}
                      </span>
                    </span>
                    <span
                      {...stylex.props(
                        styles.themeCount,
                        !shown && styles.hidden
                      )}
                    >
                      {t`${plural(count, { one: "# person", other: "# people" })}`}
                    </span>
                  </div>
                  <span {...stylex.props(styles.dots)}>
                    {people.map((i, k) => (
                      <span
                        data-dot={`${String(theme)}:${String(i)}:${String(k)}`}
                        key={i}
                        {...stylex.props(
                          styles.dot,
                          isOpen && i === 0 && styles.dotMila,
                          !shown && styles.dotEmpty
                        )}
                      >
                        {initialsOf(i)}
                      </span>
                    ))}
                  </span>
                  {theme === 0 ? (
                    <div
                      {...stylex.props(styles.fold, !isOpen && styles.folded)}
                    >
                      <div {...stylex.props(styles.foldInner)}>
                        <p {...stylex.props(styles.quote)}>
                          “
                          {t`Half of it is the same questions, answered again and again.`}
                          ” · Mila de Vries
                        </p>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
