import type {
  DecisionAnswerInput,
  DecisionView,
} from "@grasp-os/shared/decisions";
import type { TodayWaitsOn, WorkflowsToday } from "@grasp-os/shared/workflows";
import { Button } from "@grasp-os/ui/components/button";
import { cn } from "@grasp-os/ui/lib/utils";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import type { Session } from "../core.ts";
import { cssVars } from "../css-vars.ts";
import {
  confirmAndAnswer,
  DecisionConfirmDialog,
} from "../decision-confirmation.tsx";
import type { PendingConfirmation } from "../decision-confirmation.tsx";
import { ErrorText } from "../error-text.tsx";
import { formatTime } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { useGrace } from "../use-grace.ts";
import { handovers, hoursOf, journeyOf, laneDay, placeOf } from "./lanes.ts";
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

/** How tall a lane is, in pixels (`h-11`): its line runs through the middle. */
const laneHeight = 44;

/** How long an answer can be taken back before it is given, in seconds. */
const graceSeconds = 5;

/** Sets the `--x` a dot, a trail or an hour is placed by: its share of the day. */
const placedAt = (share: number) => cssVars({ "--x": `${share * 100}%` });

/** Grasp at work now: three ink dots. */
const WorkingDots = () => {
  const { t } = useLingui();
  return (
    <span className="bg-background flex items-center gap-0.5 rounded-full px-1">
      <span className="sr-only">{t`Running now`}</span>
      <span
        aria-hidden="true"
        className="bg-foreground size-1 rounded-full motion-safe:animate-pulse"
      />
      <span
        aria-hidden="true"
        className="bg-foreground size-1 rounded-full delay-150 motion-safe:animate-pulse"
      />
      <span
        aria-hidden="true"
        className="bg-foreground size-1 rounded-full delay-300 motion-safe:animate-pulse"
      />
    </span>
  );
};

/** The mark of a run: filled, hollow, or orange. */
const Mark = ({ run, large }: { run: LaneRun; large: boolean }) => {
  const size = cn(
    "size-2 rounded-full transition-transform duration-200",
    large && "scale-125"
  );
  if (run.state === "waits") {
    return <span className={cn(size, "bg-status-attention")} />;
  }
  if (run.state === "toPerson" || run.state === "waitsElsewhere") {
    return (
      <span className={cn(size, "border-foreground/70 bg-background border")} />
    );
  }
  return <span className={cn(size, "bg-foreground")} />;
};

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
      className={cn(
        "focus-visible:ring-ring/50 absolute top-1/2 left-(--x) flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full transition-opacity duration-200 outline-none focus-visible:ring-3",
        dimmed && "opacity-25",
        (run.state === "waits" || chosen) && "z-10"
      )}
      onClick={() => {
        onChoose(chosen ? null : run.id);
      }}
      ref={placedAt(placeOf(run.at, day))}
      title={`${at} · ${said}`}
      type="button"
    >
      <Mark large={on} run={run} />
    </button>
  );
};

/** A lane's name, opening its workflow. */
const LaneLink = ({ lane, className }: { lane: Lane; className: string }) =>
  lane.of.kind === "app" ? (
    <Link
      className={className}
      params={{ app: lane.of.app, workflow: lane.of.workflow }}
      to="/workflows/$app/$workflow"
    >
      {lane.name}
    </Link>
  ) : (
    <Link
      className={className}
      params={{ workflow: lane.of.id }}
      to="/workflows/$workflow"
    >
      {lane.name}
    </Link>
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
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 size-full overflow-visible"
    >
      {handovers(day).map(({ from, to }) => {
        const x1 = placeOf(from.at, day) * width;
        const y1 = (rowOf.get(from.id) ?? 0) * laneHeight + laneHeight / 2;
        const x2 = placeOf(to.at, day) * width;
        const y2 = (rowOf.get(to.id) ?? 0) * laneHeight + laneHeight / 2;
        const bend = (y2 - y1) / 2;
        const on = lit.has(from.id) && lit.has(to.id);
        let opacity = "opacity-25";
        if (on) {
          opacity = "opacity-70";
        } else if (dimmed) {
          opacity = "opacity-10";
        }
        return (
          <path
            className={cn(
              "stroke-foreground transition-opacity duration-200",
              opacity
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
}: {
  day: LaneDay;
  lit: ReadonlySet<string>;
  chosen: string | null;
  onChoose: (id: string | null) => void;
}) => {
  const { t } = useLingui();
  const { track, width } = useWidth();
  const dimmed = lit.size > 0;
  return (
    <div className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] gap-x-6">
      <ul className="flex flex-col">
        {day.lanes.map((lane) => (
          <li className="flex h-11 items-center" key={lane.key}>
            <LaneLink
              className="min-w-0 leading-tight text-pretty hover:underline"
              lane={lane}
            />
          </li>
        ))}
      </ul>
      <div className="relative" ref={track}>
        {width > 0 ? <Handovers day={day} lit={lit} width={width} /> : null}
        {day.lanes.map((lane) => (
          <div className="relative h-11" key={lane.key}>
            <span
              aria-hidden="true"
              className="absolute inset-x-0 top-1/2 border-t"
            />
            {lane.runs.map((run) =>
              run.state === "waits" ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "border-status-attention/60 absolute top-1/2 right-0 left-(--x) h-0 -translate-y-px border-t-2 border-dotted transition-opacity duration-200",
                    dimmed && !lit.has(run.id) && "opacity-25"
                  )}
                  key={`${run.id} trail`}
                  ref={placedAt(placeOf(run.at, day))}
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
              <span className="absolute top-1/2 right-0 translate-x-1/2 -translate-y-1/2">
                <WorkingDots />
              </span>
            ) : null}
          </div>
        ))}
      </div>
      <span />
      <div className="text-muted-foreground relative h-5 text-xs tabular-nums">
        {hoursOf(day).map((hour) => (
          <span
            className="absolute left-(--x) -translate-x-1/2"
            key={hour}
            ref={placedAt(placeOf(hour, day))}
          >
            {formatTime(hour)}
          </span>
        ))}
        <span className="text-foreground absolute right-0 translate-x-1/2">
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
      className="focus-visible:ring-ring/50 flex size-5 items-center justify-center rounded-full outline-none focus-visible:ring-3"
      onClick={() => {
        onChoose(chosen ? null : run.id);
      }}
      type="button"
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
}: {
  lane: Lane;
  chosen: string | null;
  onChoose: (id: string | null) => void;
}) => (
  <li className="flex flex-col gap-1.5 py-3">
    <span className="flex items-center gap-2">
      <LaneLink
        className="min-w-0 flex-1 truncate font-medium hover:underline"
        lane={lane}
      />
      {lane.running ? <WorkingDots /> : null}
    </span>
    <span className="flex flex-wrap items-center gap-1">
      {lane.runs.slice(-12).map((run) => (
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
      <span aria-live="polite" className="ml-4 flex items-center gap-3">
        <span className="text-muted-foreground tabular-nums">
          {held.value.response.approved
            ? t`Approved in ${left} s`
            : t`Rejected in ${left} s`}
        </span>
        <Button onClick={undo} size="sm" variant="outline">
          <Trans context="take an answer back before it counts">Undo</Trans>
        </Button>
      </span>
    );
  }
  return (
    <div className="ml-4 flex flex-col gap-2 rounded-lg border p-3">
      <span className="font-medium">{waits.asks}</span>
      <span className="text-muted-foreground text-xs">{waitsSince}</span>
      <ErrorText>{failure}</ErrorText>
      <span className="flex justify-end gap-2">
        <Button
          disabled={busy}
          onClick={() => {
            void review({ approved: false });
          }}
          size="sm"
          variant="outline"
        >
          <Trans context="send a waiting item back to people">Reject</Trans>
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            void review({ approved: true });
          }}
          size="sm"
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
    <div
      aria-live="polite"
      className="bg-card animate-in fade-in flex flex-col gap-3 rounded-xl border p-4 duration-200"
    >
      <div className="flex items-start justify-between gap-4">
        <h3 className="font-medium">
          <Trans context="the card that follows one item across workflows">
            Where is it
          </Trans>
        </h3>
        <Button onClick={onClose} size="sm" variant="ghost">
          <Trans context="put away the card of one item">Close</Trans>
        </Button>
      </div>
      <ol className="flex flex-col gap-2">
        {journey.map((step) => (
          <li className="flex flex-col gap-1" key={step.id}>
            <span className="flex items-center gap-2">
              <Mark large={false} run={step} />
              <span className="min-w-0 flex-1">
                {names.get(step.lane)} · <RunText run={step} />
              </span>
              <span className="text-muted-foreground text-xs tabular-nums">
                {formatTime(step.at)}
              </span>
            </span>
            {step.state === "waits" ? <WaitsOnYou run={step} /> : null}
          </li>
        ))}
      </ol>
      {journey.length === 1 ? (
        <p className="text-muted-foreground text-xs">
          <Trans>It went through no other workflow today.</Trans>
        </p>
      ) : null}
    </div>
  );
};

export const TodayLanes = ({ today }: { today: WorkflowsToday }) => {
  const { t } = useLingui();
  const [chosen, setChosen] = useState<string | null>(null);
  const day = laneDay(today);
  const all = day.lanes.flatMap((lane) => lane.runs);
  const run = all.find(({ id }) => id === chosen);
  const journey = run === undefined ? [] : journeyOf(day, run.key);
  const lit = new Set(journey.map(({ id }) => id));
  const { cutOff, unseen } = day;
  return (
    <section
      aria-label={t({
        message: "Today",
        context: "the workflows' runs of today, laid out in time",
      })}
      className="@container flex flex-col gap-3"
    >
      {day.lanes.length === 0 ? (
        <p className="bg-card text-muted-foreground rounded-xl border px-4 py-6 text-center">
          <Trans>No workflow you can see has worked today yet.</Trans>
        </p>
      ) : (
        <>
          <div className="hidden @2xl:block">
            <Lanes chosen={chosen} day={day} lit={lit} onChoose={setChosen} />
          </div>
          <ul className="flex flex-col divide-y @2xl:hidden">
            {day.lanes.map((lane) => (
              <ListLane
                chosen={chosen}
                key={lane.key}
                lane={lane}
                onChoose={setChosen}
              />
            ))}
          </ul>
        </>
      )}
      {cutOff > 0 ? (
        <p className="text-muted-foreground text-xs">
          {t`${plural(cutOff, {
            one: "# earlier run today isn't shown: only the latest fit",
            other: "# earlier runs today aren't shown: only the latest fit",
          })}`}
        </p>
      ) : null}
      {unseen > 0 ? (
        <p className="text-muted-foreground text-xs">
          {t`${plural(unseen, {
            one: "# more run today, of a workflow you can't see",
            other: "# more runs today, of workflows you can't see",
          })}`}
        </p>
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
