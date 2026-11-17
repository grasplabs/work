import type { BusinessProcess } from "@grasp-os/shared/business-processes";
import type {
  DecisionAnswerInput,
  DecisionView,
} from "@grasp-os/shared/decisions";
import type { TodayWaitsOn, WorkflowsToday } from "@grasp-os/shared/workflows";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";

import type { Session } from "../core.ts";
import {
  confirmAndAnswer,
  DecisionConfirmDialog,
} from "../decision-confirmation.tsx";
import type { PendingConfirmation } from "../decision-confirmation.tsx";
import { ErrorText } from "../error-text.tsx";
import { formatTime } from "../format.ts";
import { Button } from "../grasp/button/index.ts";
import { Card } from "../grasp/card/index.ts";
import { focus } from "../grasp/focus/focus.ts";
import { Heading } from "../grasp/heading/index.ts";
import { visuallyHidden } from "../grasp/hidden/hidden.ts";
import { Link as TextLink } from "../grasp/link/index.ts";
import { arrive } from "../grasp/motion/arrive.ts";
import { simply } from "../grasp/motion/simply.stylex.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { useGrace } from "../use-grace.ts";
import { ProcessGlyph } from "./business-process.tsx";
import {
  handovers,
  hoursOf,
  journeyOf,
  laneDay,
  laterDay,
  listedRuns,
  placeOf,
} from "./lanes.ts";
import type { Lane, LaneDay, LaneRun } from "./lanes.ts";

// Runs › Today (prototype `components/workflows/today-lanes.tsx`): a lane
// for every workflow that worked today, its runs as dots in time. A dot
// is filled when it went by itself, hollow when it went to people, orange
// when it waits on the reader, with a dotted trail to now. A lane that
// runs now has Grasp's dots at now. Where an item went from one workflow
// to the next, a light line joins its two dots. Pressing a dot follows its
// item across the lanes, said under them ("Where is it"); when it waits on
// the reader, the card says on whom and since when, with Reject or
// Approve, the decision's own confirmation, then five seconds to undo
// before the answer is given; leaving in those seconds gives it at once
// (`useGrace`), as pausing a workflow does. Narrower than 42rem, the
// lanes are a list.

/**
 * How tall a lane is, in pixels: its line runs through the middle. The
 * joins between lanes are drawn by it; `grasp.controlLg` is the same 44px.
 */
const laneHeight = 44;

/** How long an answer can be taken back before it is given, in seconds. */
const graceSeconds = 5;

/** How far along the day an hour may stand and still leave room for "now" at its end. */
const nowRoom = 0.94;

/** From this width of the section, the lanes are drawn in time; under it, a list. */
const WIDE = "@container (width >= 42rem)";

/** Three dots' slow breath while Grasp works; still under reduced motion. */
const pulse = stylex.keyframes({
  "0%": { opacity: 1 },
  "50%": { opacity: 0.5 },
  "100%": { opacity: 1 },
});

/** A dot followed across the lanes, or the "now" mark, ahead of the rest. */
const ahead = 1;

const styles = stylex.create({
  // A dot, a trail or an hour placed by its share of the day.
  at: (share: number) => ({ insetInlineStart: `${share * 100}%` }),
  section: {
    containerType: "inline-size",
    display: "flex",
    flexDirection: "column",
    gap: grasp.space3,
  },
  wide: { display: { default: "none", [WIDE]: "block" } },
  narrow: {
    display: { default: "flex", [WIDE]: "none" },
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  narrowLane: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    paddingBlock: grasp.space3,
    borderTopWidth: { default: grasp.hairline, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: grasp.line,
  },
  row: { display: "flex", alignItems: "center", gap: grasp.space2 },
  runs: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space1,
  },
  truncate: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 12rem) minmax(0, 1fr)",
    columnGap: grasp.space6,
  },
  names: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  name: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    height: grasp.controlLg,
    minWidth: 0,
    lineHeight: 1.25,
    textWrap: "pretty",
  },
  track: { position: "relative" },
  lane: { position: "relative", height: grasp.controlLg },
  laneLine: {
    position: "absolute",
    insetInline: 0,
    top: "50%",
    borderTopWidth: grasp.hairline,
    borderTopStyle: "solid",
    borderTopColor: grasp.line,
  },
  trail: {
    position: "absolute",
    top: "50%",
    insetInlineEnd: 0,
    height: 0,
    transform: "translateY(-1px)",
    borderTopWidth: `calc(2 * ${grasp.hairline})`,
    borderTopStyle: "dotted",
    borderTopColor: `color-mix(in oklab, ${grasp.attention} 60%, transparent)`,
    transitionProperty: "opacity",
    transitionDuration: simply.mark,
    transitionTimingFunction: grasp.ease,
  },
  faded: { opacity: 0.25 },
  dot: {
    position: "absolute",
    top: "50%",
    transform: "translate(-50%, -50%)",
    transitionProperty: "opacity",
    transitionDuration: simply.mark,
    transitionTimingFunction: grasp.ease,
  },
  hit: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: grasp.space5,
    height: grasp.space5,
    padding: 0,
    borderWidth: 0,
    borderRadius: grasp.cornerCircle,
    backgroundColor: "transparent",
    cursor: "pointer",
  },
  ahead: { zIndex: ahead },
  working: {
    position: "absolute",
    top: "50%",
    insetInlineEnd: 0,
    transform: "translate(50%, -50%)",
  },
  workingDots: {
    display: "flex",
    alignItems: "center",
    gap: `calc(${grasp.space1} / 2)`,
    paddingInline: grasp.space1,
    borderRadius: grasp.cornerPill,
    backgroundColor: grasp.paper,
  },
  workingDot: {
    width: grasp.space1,
    height: grasp.space1,
    borderRadius: grasp.cornerCircle,
    backgroundColor: grasp.ink,
    animationName: { default: pulse, [media.reduced]: "none" },
    animationDuration: "2s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.6, 1)",
    animationIterationCount: "infinite",
  },
  second: { animationDelay: grasp.durationStagger },
  third: { animationDelay: `calc(2 * ${grasp.durationStagger})` },
  joins: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    overflow: "visible",
    pointerEvents: "none",
  },
  join: {
    stroke: grasp.ink,
    opacity: 0.25,
    transitionProperty: "opacity",
    transitionDuration: simply.mark,
    transitionTimingFunction: grasp.ease,
  },
  joinLit: { opacity: 0.7 },
  joinDimmed: { opacity: 0.1 },
  hours: {
    position: "relative",
    height: grasp.space5,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    fontVariantNumeric: "tabular-nums",
  },
  hour: {
    position: "absolute",
    transform: "translateX(-50%)",
    whiteSpace: "nowrap",
  },
  now: {
    position: "absolute",
    insetInlineEnd: 0,
    transform: "translateX(50%)",
    whiteSpace: "nowrap",
    color: grasp.ink,
  },
  mark: {
    flexShrink: 0,
    width: grasp.space2,
    height: grasp.space2,
    borderRadius: grasp.cornerCircle,
    transitionProperty: "transform",
    transitionDuration: simply.mark,
    transitionTimingFunction: grasp.ease,
  },
  large: { transform: "scale(1.25)" },
  // Filled: it went by itself.
  ink: { backgroundColor: grasp.ink },
  // Hollow: it went to people.
  hollow: {
    borderWidth: grasp.hairline,
    borderStyle: "solid",
    borderColor: grasp.ink,
    backgroundColor: grasp.paper,
  },
  waits: { backgroundColor: grasp.attention },
  failed: { backgroundColor: grasp.danger },
  failedHollow: {
    borderWidth: grasp.hairline,
    borderStyle: "solid",
    borderColor: grasp.danger,
    backgroundColor: grasp.paper,
  },
  cancelled: { backgroundColor: grasp.muted },
  cancelledHollow: {
    borderWidth: grasp.hairline,
    borderStyle: "solid",
    borderColor: grasp.muted,
    backgroundColor: grasp.paper,
  },
  held: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
    marginInlineStart: grasp.space4,
  },
  count: {
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
    fontVariantNumeric: "tabular-nums",
  },
  asks: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    marginInlineStart: grasp.space4,
    padding: grasp.space3,
    borderWidth: grasp.hairline,
    borderStyle: "solid",
    borderColor: grasp.line,
    borderRadius: grasp.corner,
  },
  answers: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: grasp.space2,
  },
  comment: { marginInlineEnd: "auto" },
  card: { display: "flex", flexDirection: "column", gap: grasp.space3 },
  cardHead: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: grasp.space4,
  },
  steps: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  step: { display: "flex", flexDirection: "column", gap: grasp.space1 },
  stepName: { flexGrow: 1, minWidth: 0 },
  time: {
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    fontVariantNumeric: "tabular-nums",
  },
});

/** Grasp at work now: three ink dots. */
const WorkingDots = () => {
  const { t } = useLingui();
  return (
    <span {...stylex.props(styles.workingDots)}>
      <span {...stylex.props(visuallyHidden)}>{t`Running now`}</span>
      <span aria-hidden="true" {...stylex.props(styles.workingDot)} />
      <span
        aria-hidden="true"
        {...stylex.props(styles.workingDot, styles.second)}
      />
      <span
        aria-hidden="true"
        {...stylex.props(styles.workingDot, styles.third)}
      />
    </span>
  );
};

/**
 * How a run that ended without its result is marked: filled when it went
 * by itself, hollow when it went to people, as any run; red when it
 * failed, grey when it was cancelled.
 */
const unfinishedMarks = {
  failed: { alone: styles.failed, people: styles.failedHollow },
  cancelled: { alone: styles.cancelled, people: styles.cancelledHollow },
} as const;

/** How a run is marked, by how it stands. */
const markOf = (run: LaneRun) => {
  if (run.state === "failed" || run.state === "cancelled") {
    return unfinishedMarks[run.state][run.run.went];
  }
  if (run.state === "waits") {
    return styles.waits;
  }
  if (run.state === "toPerson" || run.state === "waitsElsewhere") {
    return styles.hollow;
  }
  return styles.ink;
};

/** The mark of a run: filled, hollow, orange, or red or grey when unfinished. */
const Mark = ({ run, large }: { run: LaneRun; large: boolean }) => (
  <span {...stylex.props(styles.mark, markOf(run), large && styles.large)} />
);

/** Whom a wait names, in words: you, your role, or your team. */
const useWaitsOnText = (on: TodayWaitsOn): string => {
  const { t } = useLingui();
  if (on.kind === "role") {
    const { role } = on;
    return t`waits on your role, ${role}`;
  }
  if (on.kind === "team") {
    const { team } = on;
    return t`waits on your team, ${team}`;
  }
  return t`waits on you`;
};

/** Whom a wait names, and since when, as a sentence. */
const useWaitsSinceText = (on: TodayWaitsOn, since: string): string => {
  const { t } = useLingui();
  if (on.kind === "role") {
    const { role } = on;
    return t`It waits on your role, ${role}, since ${since}.`;
  }
  if (on.kind === "team") {
    const { team } = on;
    return t`It waits on your team, ${team}, since ${since}.`;
  }
  return t`It waits on you since ${since}.`;
};

/** What came of a run, in a few words. */
const useRunText = (run: LaneRun): string => {
  const { t } = useLingui();
  const waitsOn = useWaitsOnText(run.run.waits?.on ?? { kind: "you" });
  const words: Readonly<Record<LaneRun["state"], string>> = {
    waits: waitsOn,
    waitsElsewhere: t`waits on someone`,
    running: t({ message: "running", context: "a run going on now" }),
    toPerson: t`went to people`,
    done: t({ message: "done by itself", context: "a run that ran alone" }),
    failed: t({ message: "failed", context: "a run that ended in failure" }),
    cancelled: t({
      message: "cancelled",
      context: "a run someone stopped before its end",
    }),
  };
  return words[run.state];
};

const RunText = ({ run }: { run: LaneRun }) => <>{useRunText(run)}</>;

/** A run as a dot on its lane; a press follows its item. */
const Dot = ({
  run,
  day,
  on,
  dimmed,
  chosen,
  onChoose,
}: {
  run: LaneRun;
  day: LaneDay;
  on: boolean;
  dimmed: boolean;
  chosen: boolean;
  onChoose: (id: string | null) => void;
}) => {
  const said = useRunText(run);
  const at = formatTime(run.at);
  return (
    <button
      aria-label={`${at} · ${said}`}
      aria-pressed={chosen}
      onClick={() => {
        onChoose(chosen ? null : run.id);
      }}
      title={`${at} · ${said}`}
      type="button"
      {...stylex.props(
        styles.hit,
        focus.ring,
        styles.dot,
        styles.at(placeOf(run.at, day)),
        dimmed && styles.faded,
        (run.state === "waits" || chosen) && styles.ahead
      )}
    >
      <Mark large={on} run={run} />
    </button>
  );
};

/** The business process each lane's workflow serves, by its ID, for their marks. */
export type LaneProcesses = ReadonlyMap<string, BusinessProcess | null>;

/** None known: lanes without their marks. */
const noProcesses: LaneProcesses = new Map();

/** A lane's process, by its mark, before its name, as the prototype has it. */
const LaneMark = ({
  lane,
  processes,
}: {
  lane: Lane;
  processes: LaneProcesses;
}) => {
  const process = processes.get(lane.of.id);
  return process === undefined || process === null ? null : (
    <ProcessGlyph process={process} />
  );
};

/** A lane's name, opening its workflow. */
const LaneLink = ({ lane }: { lane: Lane }) => (
  <TextLink
    render={
      <Link params={{ workflow: lane.of.id }} to="/workflows/$workflow" />
    }
    variant="standalone"
  >
    {lane.name}
  </TextLink>
);

/** The width of `element`, as it changes. */
const useWidth = () => {
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry?.contentRect.width ?? 0);
    });
    if (track.current !== null) {
      observer.observe(track.current);
    }
    return () => {
      observer.disconnect();
    };
  }, []);
  return { track, width };
};

/** Where an item went on: light lines between dots, bolder while it is followed. */
const Handovers = ({
  day,
  width,
  lit,
}: {
  day: LaneDay;
  width: number;
  lit: ReadonlySet<string>;
}) => {
  const rowOf = new Map(
    day.lanes.flatMap((lane, index) =>
      lane.runs.map((run) => [run.id, index] as const)
    )
  );
  const dimmed = lit.size > 0;
  return (
    <svg aria-hidden="true" {...stylex.props(styles.joins)}>
      {handovers(day).map(({ from, to }) => {
        const x1 = placeOf(from.at, day) * width;
        const y1 = (rowOf.get(from.id) ?? 0) * laneHeight + laneHeight / 2;
        const x2 = placeOf(to.at, day) * width;
        const y2 = (rowOf.get(to.id) ?? 0) * laneHeight + laneHeight / 2;
        const bend = (y2 - y1) / 2;
        const on = lit.has(from.id) && lit.has(to.id);
        return (
          <path
            {...stylex.props(
              styles.join,
              on && styles.joinLit,
              !on && dimmed && styles.joinDimmed
            )}
            d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
            fill="none"
            key={`${from.id}>${to.id}`}
            strokeDasharray="2 4"
            strokeLinecap="round"
            strokeWidth={1.25}
          />
        );
      })}
    </svg>
  );
};

/** The lanes in time, with the hours under them. */
const Lanes = ({
  day,
  lit,
  chosen,
  onChoose,
  processes,
}: {
  processes: LaneProcesses;
  day: LaneDay;
  lit: ReadonlySet<string>;
  chosen: string | null;
  onChoose: (id: string | null) => void;
}) => {
  const { t } = useLingui();
  const { track, width } = useWidth();
  const dimmed = lit.size > 0;
  return (
    <div {...stylex.props(styles.grid)}>
      <ul {...stylex.props(styles.names)}>
        {day.lanes.map((lane) => (
          <li key={lane.key} {...stylex.props(styles.name)}>
            <LaneMark lane={lane} processes={processes} />
            <LaneLink lane={lane} />
          </li>
        ))}
      </ul>
      <div ref={track} {...stylex.props(styles.track)}>
        {width > 0 ? <Handovers day={day} lit={lit} width={width} /> : null}
        {day.lanes.map((lane) => (
          <div key={lane.key} {...stylex.props(styles.lane)}>
            <span aria-hidden="true" {...stylex.props(styles.laneLine)} />
            {lane.runs.map((run) =>
              run.state === "waits" ? (
                <span
                  aria-hidden="true"
                  key={`${run.id} trail`}
                  {...stylex.props(
                    styles.trail,
                    styles.at(placeOf(run.waitsSince ?? run.at, day)),
                    dimmed && !lit.has(run.id) && styles.faded
                  )}
                />
              ) : null
            )}
            {lane.runs.map((run) => (
              <Dot
                chosen={chosen === run.id}
                day={day}
                dimmed={dimmed && !lit.has(run.id)}
                key={run.id}
                on={lit.has(run.id)}
                onChoose={onChoose}
                run={run}
              />
            ))}
            {lane.running ? (
              <span {...stylex.props(styles.working)}>
                <WorkingDots />
              </span>
            ) : null}
          </div>
        ))}
      </div>
      <span />
      <div {...stylex.props(styles.hours)}>
        {/* An hour as close to the end as "now" would sit on it: left out. */}
        {hoursOf(day)
          .filter((hour) => placeOf(hour, day) < nowRoom)
          .map((hour) => (
            <span
              key={hour}
              {...stylex.props(styles.hour, styles.at(placeOf(hour, day)))}
            >
              {formatTime(hour)}
            </span>
          ))}
        <span {...stylex.props(styles.now)}>
          {t({
            message: "now",
            context: "the end of a time line: this moment",
          })}
        </span>
      </div>
    </div>
  );
};

const ListDot = ({
  run,
  chosen,
  onChoose,
}: {
  run: LaneRun;
  chosen: boolean;
  onChoose: (id: string | null) => void;
}) => {
  const said = useRunText(run);
  const at = formatTime(run.at);
  return (
    <button
      aria-label={`${at} · ${said}`}
      aria-pressed={chosen}
      onClick={() => {
        onChoose(chosen ? null : run.id);
      }}
      type="button"
      {...stylex.props(styles.hit, focus.ring)}
    >
      <Mark large={chosen} run={run} />
    </button>
  );
};

/** A lane as one line on a narrow page: its name, its last runs, and what waits. */
const ListLane = ({
  lane,
  chosen,
  onChoose,
  processes,
}: {
  processes: LaneProcesses;
  lane: Lane;
  chosen: string | null;
  onChoose: (id: string | null) => void;
}) => (
  <li {...stylex.props(styles.narrowLane)}>
    <span {...stylex.props(styles.row)}>
      <LaneMark lane={lane} processes={processes} />
      <span {...stylex.props(styles.truncate)}>
        <LaneLink lane={lane} />
      </span>
      {lane.running ? <WorkingDots /> : null}
    </span>
    <span {...stylex.props(styles.runs)}>
      {listedRuns(lane, 12).map((run) => (
        <ListDot
          chosen={chosen === run.id}
          key={run.id}
          onChoose={onChoose}
          run={run}
        />
      ))}
    </span>
  </li>
);

/** Answers the decision `answering` confirmed, through its own confirmation. */
const answerWith =
  (answering: PendingConfirmation) =>
  async (session: Session): Promise<DecisionView> =>
    await confirmAndAnswer(
      session,
      answering,
      async (confirmation) =>
        await session.decisions.answer(
          answering.decision.id,
          answering.response,
          confirmation
        )
    );

/**
 * A wait on the reader: what it asks, on whom and since when, and Reject
 * or Approve. A confirmed answer waits five seconds with Undo, then goes
 * through the decision's own confirmation and answer.
 */
const WaitsOnYou = ({ run }: { run: LaneRun }) => {
  const { t } = useLingui();
  const router = useRouter();
  const core = useCore();
  const { busy, failure, run: act } = useCoreAction();
  const [pending, setPending] = useState<PendingConfirmation>();
  const { waits } = run.run;
  const { held, hold, undo } = useGrace<PendingConfirmation>({
    seconds: graceSeconds,
    go: (answering) => {
      void (async () => {
        const answered = await act(answerWith(answering));
        if (answered !== undefined) {
          await router.invalidate();
        }
      })();
    },
    // Gone before the seconds were over: the answer was confirmed, so it
    // is given, and Today says how the run stands when it is opened again.
    goOnLeave: (answering) => {
      void (async () => {
        try {
          await core.withSession(answerWith(answering));
        } catch {
          // Nobody is left on the card to tell; the decision still waits
          // in the inbox, where it can be answered again.
        }
      })();
    },
  });
  const since = waits === null ? "" : formatTime(waits.since);
  const waitsSince = useWaitsSinceText(waits?.on ?? { kind: "you" }, since);
  if (waits === null) {
    return null;
  }
  const review = async (response: DecisionAnswerInput): Promise<void> => {
    const reviewed = await act(
      async (session) =>
        await session.decisions.review(waits.decision, response)
    );
    if (reviewed?.state === "review") {
      setPending(reviewed);
    } else if (reviewed !== undefined) {
      await router.invalidate();
    }
  };
  if (held !== null) {
    const { left } = held;
    return (
      <span aria-live="polite" {...stylex.props(styles.held)}>
        <span {...stylex.props(styles.count)}>
          {held.value.response.approved
            ? t`Approved in ${left} s`
            : t`Rejected in ${left} s`}
        </span>
        <Button onClick={undo} size="sm" variant="quiet">
          <Trans context="take an answer back before it counts">Undo</Trans>
        </Button>
      </span>
    );
  }
  return (
    <div {...stylex.props(styles.asks)}>
      <Text element="span" size="sm" weight="medium">
        {waits.asks}
      </Text>
      <Text element="span" size="xs" tone="muted">
        {waitsSince}
      </Text>
      <ErrorText>{failure}</ErrorText>
      <span {...stylex.props(styles.answers)}>
        {/* An answer with a comment, which a decision may require: on the
            decision's own page, which has the field. */}
        <Text element="span" layout={styles.comment} size="xs" tone="muted">
          <TextLink
            render={
              <Link
                params={{ decision: waits.decision }}
                to="/decisions/$decision"
              />
            }
          >
            <Trans>Answer with a comment</Trans>
          </TextLink>
        </Text>
        <Button
          disabled={busy}
          onClick={() => {
            void review({ approved: false });
          }}
          size="sm"
          variant="quiet"
        >
          <Trans context="send a waiting item back to people">Reject</Trans>
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            void review({ approved: true });
          }}
          size="sm"
          variant="approve"
        >
          <Trans context="let a waiting item go ahead">Approve</Trans>
        </Button>
      </span>
      <DecisionConfirmDialog
        onCancel={() => {
          setPending(undefined);
        }}
        onConfirm={(answering) => {
          setPending(undefined);
          hold(answering);
        }}
        pending={pending}
        source="page"
      />
    </div>
  );
};

/** Where one item is: every run it had today, in order, across the lanes. */
const WhereItIs = ({
  journey,
  day,
  onClose,
}: {
  journey: LaneRun[];
  day: LaneDay;
  onClose: () => void;
}) => {
  const names = new Map(day.lanes.map(({ key, name }) => [key, name]));
  return (
    <div aria-live="polite" {...stylex.props(arrive.in)}>
      <Card>
        <div {...stylex.props(styles.card)}>
          <div {...stylex.props(styles.cardHead)}>
            <Heading level={3} size="ui-sm">
              <Trans context="the card that follows one item across workflows">
                Where is it
              </Trans>
            </Heading>
            <Button onClick={onClose} size="sm" variant="ghost">
              <Trans context="put away the card of one item">Close</Trans>
            </Button>
          </div>
          <ol {...stylex.props(styles.steps)}>
            {journey.map((step) => (
              <li key={step.id} {...stylex.props(styles.step)}>
                <span {...stylex.props(styles.row)}>
                  <Mark large={false} run={step} />
                  <span {...stylex.props(styles.stepName)}>
                    {names.get(step.lane)} · <RunText run={step} />
                  </span>
                  <span {...stylex.props(styles.time)}>
                    {formatTime(step.at)}
                  </span>
                </span>
                {step.state === "waits" ? <WaitsOnYou run={step} /> : null}
              </li>
            ))}
          </ol>
          {journey.length === 1 ? (
            <Text size="xs" tone="muted">
              <Trans>It went through no other workflow today.</Trans>
            </Text>
          ) : null}
        </div>
      </Card>
    </div>
  );
};

/** How often Today is read again while it shows, in milliseconds. */
const refreshMs = 30_000;

/**
 * The day as core serves it now: `loaded`, the page's read, then read
 * again every `refreshMs` while the page is in view, so new waits come
 * in, ended runs end and now moves on. Whichever read is the later wins.
 */
const useLatestToday = (loaded: WorkflowsToday): WorkflowsToday => {
  const core = useCore();
  const [read, setRead] = useState<WorkflowsToday>();
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const readAgain = async (): Promise<void> => {
      if (document.visibilityState === "visible") {
        try {
          const next = await core.withSession(
            async (session) => await session.workflows.today()
          );
          if (!stopped) {
            setRead(next);
          }
        } catch {
          // Shown as last read; the next read may reach core again.
        }
      }
      if (!stopped) {
        timer = setTimeout(() => {
          void readAgain();
        }, refreshMs);
      }
    };
    timer = setTimeout(() => {
      void readAgain();
    }, refreshMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [core]);
  return laterDay(loaded, read);
};

export const TodayLanes = ({
  today: loaded,
  processes = noProcesses,
}: {
  today: WorkflowsToday;
  /** The process each lane's workflow serves, for its mark. */
  processes?: LaneProcesses;
}) => {
  const today = useLatestToday(loaded);
  const { t } = useLingui();
  const [chosen, setChosen] = useState<string | null>(null);
  const day = laneDay(today);
  const all = day.lanes.flatMap((lane) => lane.runs);
  const run = all.find(({ id }) => id === chosen);
  const journey = run === undefined ? [] : journeyOf(day, run.key);
  const lit = new Set(journey.map(({ id }) => id));
  const { cutOff, unseen } = day;
  const headingId = useId();
  // Over the runs, as the prototype has it: nothing at all on a day no
  // workflow the reader can see has worked yet.
  if (day.lanes.length === 0 && cutOff === 0 && unseen === 0) {
    return null;
  }
  return (
    <section aria-labelledby={headingId} {...stylex.props(styles.section)}>
      <Heading id={headingId} level={2} size="ui">
        <Trans context="the workflows' runs of today, laid out in time">
          Today
        </Trans>
      </Heading>
      {day.lanes.length === 0 ? null : (
        <>
          <div {...stylex.props(styles.wide)}>
            <Lanes
              chosen={chosen}
              day={day}
              lit={lit}
              onChoose={setChosen}
              processes={processes}
            />
          </div>
          <ul {...stylex.props(styles.narrow)}>
            {day.lanes.map((lane) => (
              <ListLane
                chosen={chosen}
                key={lane.key}
                lane={lane}
                onChoose={setChosen}
                processes={processes}
              />
            ))}
          </ul>
        </>
      )}
      {cutOff > 0 ? (
        <Text size="xs" tone="muted">
          {t`${plural(cutOff, {
            one: "# earlier run today isn't shown: only the latest fit",
            other: "# earlier runs today aren't shown: only the latest fit",
          })}`}
        </Text>
      ) : null}
      {unseen > 0 ? (
        <Text size="xs" tone="muted">
          {t`${plural(unseen, {
            one: "# more run today, of a workflow you can't see",
            other: "# more runs today, of workflows you can't see",
          })}`}
        </Text>
      ) : null}
      {run === undefined ? null : (
        <WhereItIs
          day={day}
          journey={journey}
          onClose={() => {
            setChosen(null);
          }}
        />
      )}
    </section>
  );
};
