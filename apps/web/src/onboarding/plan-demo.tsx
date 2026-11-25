import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import type { Moment } from "./plan.tsx";

// The plan's story shown as the thing itself, sped up (plan-story.tsx):
// while Stephen tells the two weeks, the admin watches them happen. A rail
// of the plan's four days runs along the top, lit up to where the story
// is. On the left, the people: first one interview with someone who knows
// the work, its words coming in as they would; then the whole company, a
// tile for each person lighting up as they talk, counted, until every one
// has and the interviews close. On the right, from the start, the report
// they will get, empty and waiting for its day; it fills in team by team,
// and then the one finding the story names lifts out of the interview's
// own words to the top of it. Shown, not drawn: the same cards, type and
// colours as the product. Decoration for sighted people only (the words
// above it say it all).

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

/** How many people the company has, in the demo. */
const PEOPLE = 42;

const hash = (n: number): number => {
  const s = Math.sin(n * 127.1 + 311.7) * 43_758.5453;
  return s - Math.floor(s);
};

const initialsOf = (i: number): string =>
  String.fromCodePoint(65 + Math.floor(hash(i * 3.7) * 26)) +
  String.fromCodePoint(65 + Math.floor(hash(i * 9.1) * 26));

const styles = stylex.create({
  demo: {
    display: "grid",
    gap: space[5],
    width: "100%",
    maxWidth: "62rem",
  },
  // The rail of the four days.
  rail: {
    position: "relative",
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: space[2],
  },
  stop: {
    display: "grid",
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
  stopNow: {
    borderTopColor: colors.mintDeep,
    color: colors.foreground,
  },
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
    gridTemplateColumns: { default: "1.15fr 1fr", [media.maxSm]: "1fr" },
    gap: space[4],
    alignItems: "start",
  },
  card: {
    position: "relative",
    display: "grid",
    alignContent: "start",
    gap: space[3],
    minHeight: { default: "19rem", [media.maxSm]: "auto" },
    padding: space[5],
    borderRadius: radius.xl,
    backgroundColor: colors.card,
    boxShadow: shadow.md,
    overflow: "hidden",
  },
  cardHead: {
    display: "flex",
    alignItems: "center",
    gap: space[3],
    minHeight: "2.5rem",
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
    width: "2.5rem",
    height: "2.5rem",
    borderRadius: radius.full,
    backgroundColor: colors.successSubtle,
    color: colors.pine,
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
    width: "3px",
    borderRadius: radius.full,
    backgroundColor: colors.mintDeep,
    animationName: stylex.keyframes({
      "0%, 100%": { transform: "scaleY(0.3)" },
      "50%": { transform: "scaleY(1)" },
    }),
    animationDuration: "900ms",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
    height: "100%",
  },
  quiet: { animationPlayState: "paused", opacity: 0.4 },
  // The interview's words.
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
  mark: {
    borderRadius: radius.xs,
    transitionProperty: "background-color, box-shadow",
    transitionDuration: "600ms",
  },
  marked: {
    backgroundColor: colors.successSubtle,
    boxShadow: `0 0 0 2px ${colors.successSubtle}`,
  },
  // The whole company, a tile each.
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
    transitionProperty: "background-color, color, transform, box-shadow",
    transitionDuration: "400ms",
    transitionTimingFunction: duration.ease,
  },
  tileTalking: {
    backgroundColor: colors.brandMint,
    color: colors.brandNight,
    transform: "scale(1.12)",
    boxShadow: `0 0 0 3px ${colors.successSubtle}`,
  },
  tileDone: {
    backgroundColor: colors.successSubtle,
    color: colors.pine,
  },
  count: {
    fontSize: font.headingMd,
    lineHeight: font.headingMdLine,
    fontFamily: font.serif,
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
  // The report.
  report: {
    transitionProperty: "opacity",
    transitionDuration: "700ms",
  },
  waiting: { opacity: 0.55 },
  rows: { display: "grid", gap: space[3] },
  row: {
    display: "grid",
    gridTemplateColumns: "7rem 1fr auto",
    alignItems: "center",
    gap: space[3],
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.foreground,
  },
  track: {
    display: "block",
    height: "0.5rem",
    borderRadius: radius.full,
    backgroundColor: colors.muted,
    overflow: "hidden",
  },
  fill: {
    display: "block",
    width: "100%",
    height: "100%",
    borderRadius: radius.full,
    backgroundColor: colors.mintDeep,
    transformOrigin: "left",
    transform: "scaleX(0)",
    transitionProperty: "transform",
    transitionDuration: "900ms",
    transitionTimingFunction: duration.ease,
  },
  number: {
    minWidth: "1.5rem",
    textAlign: "end",
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
  },
  skeleton: {
    display: "block",
    height: "0.75rem",
    borderRadius: radius.full,
    backgroundColor: colors.muted,
  },
  finding: {
    display: "grid",
    gap: space[2],
    padding: space[4],
    borderRadius: radius.lg,
    backgroundColor: colors.successSubtle,
    opacity: 0,
    transform: "translateX(-2.5rem) scale(0.96)",
    transitionProperty: "opacity, transform",
    transitionDuration: "800ms",
    transitionTimingFunction: duration.ease,
  },
  findingShown: { opacity: 1, transform: "none" },
  findingTitle: {
    fontFamily: font.serif,
    fontSize: font.headingSm,
    lineHeight: font.headingSmLine,
    color: colors.foreground,
    textWrap: "balance",
  },
  findingQuote: {
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
    fontStyle: "italic",
  },
  skeletonWide: { width: "70%" },
  skeletonShort: { width: "45%" },
});

// What changes with each bar and row: a voice bar's moment, a team's share.
const moving = stylex.create({
  delay: (ms: string) => ({ animationDelay: ms }),
  share: (part: number) => ({ transform: `scaleX(${part})` }),
});

/** How far into the story `scene` is, by its place in it. */
const indexOf = (scene: Scene): number => order.indexOf(scene);

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
        const isNow = now >= stop.at && now < next;
        return (
          <div
            key={stop.id}
            {...stylex.props(
              styles.stop,
              now >= stop.at && styles.stopPast,
              isNow && styles.stopNow
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

/** The one interview: someone who knows the work, talking with Stephen. */
const Interview = ({
  progress,
  marked,
}: {
  progress: number;
  marked: boolean;
}) => {
  const { t } = useLingui();
  const turns = [
    { by: "stephen", text: t`Walk me through someone’s first week here.` },
    {
      by: "them",
      text: t`Honestly, the first days they mostly wait.`,
    },
    {
      by: "them",
      mark: t`IT needs two or three days to get a laptop ready.`,
    },
  ] as const;
  return (
    <>
      <div {...stylex.props(styles.cardHead)}>
        <span {...stylex.props(styles.avatar)}>MV</span>
        <span {...stylex.props(styles.who)}>
          <span {...stylex.props(styles.name)}>Mila de Vries</span>
          <span {...stylex.props(styles.role)}>{t`Operations lead`}</span>
        </span>
        <Live on={progress > 0 && progress < 1 && !marked} />
      </div>
      {turns.map((turn, i) => (
        <p
          key={turn.by + String(i)}
          {...stylex.props(
            styles.turn,
            turn.by === "stephen" && styles.stephen,
            (progress > i * 0.28 || marked) && styles.turnShown
          )}
        >
          {"mark" in turn ? (
            <span {...stylex.props(styles.mark, marked && styles.marked)}>
              {turn.mark}
            </span>
          ) : (
            turn.text
          )}
        </p>
      ))}
    </>
  );
};

/** The whole company, a tile each, lighting up as they talk, until every one has. */
const Crowd = ({ progress, closed }: { progress: number; closed: boolean }) => {
  const { t } = useLingui();
  // Each person's moment to talk, spread over the part; a few talking at any time.
  const done = closed ? PEOPLE : Math.round(progress * PEOPLE * 0.92);
  const people = Array.from({ length: PEOPLE }, (_, i) => ({
    i,
    at: hash(i * 5.3) * 0.85,
  }));
  const ranked = people.toSorted((a, b) => a.at - b.at);
  const talkedBy = new Map(ranked.map((one, rank) => [one.i, rank]));
  return (
    <>
      <div {...stylex.props(styles.cardHead)}>
        <span {...stylex.props(styles.who)}>
          <span
            {...stylex.props(styles.eyebrow)}
          >{t`Talked with Stephen`}</span>
          <span {...stylex.props(styles.count)}>
            {done} / {PEOPLE}
          </span>
        </span>
        <Live on={!closed} />
      </div>
      <div {...stylex.props(styles.crowd)}>
        {people.map(({ i }) => {
          const rank = talkedBy.get(i) ?? 0;
          const isDone = rank < done;
          const talking = !closed && rank >= done && rank < done + 4;
          return (
            <span
              key={i}
              {...stylex.props(
                styles.tile,
                isDone && styles.tileDone,
                talking && styles.tileTalking
              )}
            >
              {initialsOf(i)}
            </span>
          );
        })}
      </div>
      <span {...stylex.props(styles.pill, closed && styles.pillShown)}>
        {t`Interviews closed`}
      </span>
    </>
  );
};

/** What they get: the report, empty until its day, then team by team, then the finding on top. */
const Report = ({
  scene,
  progress,
  date,
}: {
  scene: Scene;
  progress: number;
  date: string;
}) => {
  const { t } = useLingui();
  const now = indexOf(scene);
  const filling = now >= indexOf("learned");
  const found = now >= indexOf("finding");
  const teams = [
    { name: t`Operations`, count: 7 },
    { name: t`Sales`, count: 5 },
    { name: t`IT`, count: 4 },
    { name: t`Finance`, count: 3 },
  ];
  const most = 7;
  const lit = scene === "learned" ? progress * (teams.length + 1) : 99;
  return (
    <div
      {...stylex.props(styles.card, styles.report, !filling && styles.waiting)}
    >
      <div {...stylex.props(styles.cardHead)}>
        <span {...stylex.props(styles.who)}>
          <span {...stylex.props(styles.eyebrow)}>{date}</span>
          <span {...stylex.props(styles.name)}>{t`What I learned`}</span>
        </span>
      </div>
      <div
        {...stylex.props(styles.finding, found && styles.findingShown)}
        aria-hidden={!found}
      >
        <span {...stylex.props(styles.eyebrow)}>{t`Operations · IT`}</span>
        <span {...stylex.props(styles.findingTitle)}>
          {t`New people wait two to three days for a laptop from IT.`}
        </span>
        <span {...stylex.props(styles.findingQuote)}>
          “{t`IT needs two or three days to get a laptop ready.`}” · Mila de
          Vries
        </span>
      </div>
      <div {...stylex.props(styles.rows)}>
        {teams.map((team, i) => (
          <div key={team.name} {...stylex.props(styles.row)}>
            <span>{team.name}</span>
            <span {...stylex.props(styles.track)}>
              <span
                {...stylex.props(
                  styles.fill,
                  filling && lit > i && moving.share(team.count / most)
                )}
              />
            </span>
            <span {...stylex.props(styles.number)}>
              {filling && lit > i ? team.count : "–"}
            </span>
          </div>
        ))}
        {filling ? null : (
          <>
            <span {...stylex.props(styles.skeleton, styles.skeletonWide)} />
            <span {...stylex.props(styles.skeleton, styles.skeletonShort)} />
          </>
        )}
      </div>
    </div>
  );
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
  const now = indexOf(scene);
  const crowd = now >= indexOf("everyone") && now < indexOf("finding");
  const closed = now >= indexOf("close");
  // The interview: told over its own part, whole once the story is past it.
  let heard = now > indexOf("first") ? 1 : 0;
  if (scene === "first") {
    heard = progress;
  }
  return (
    <div aria-hidden="true" {...stylex.props(styles.demo)}>
      <Rail dates={dates} scene={scene} />
      <div {...stylex.props(styles.panels)}>
        <div {...stylex.props(styles.card)}>
          {crowd ? (
            <Crowd
              closed={closed}
              progress={scene === "everyone" ? progress : 1}
            />
          ) : (
            <Interview marked={now >= indexOf("finding")} progress={heard} />
          )}
        </div>
        <Report date={dates.findings} progress={progress} scene={scene} />
      </div>
    </div>
  );
};
