import { Stat } from "@grasp-os/ui/components/stat";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { cn } from "@grasp-os/ui/lib/utils";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { formatEuro } from "../format.ts";
import {
  returnKey,
  returnTotals,
  stageLabel,
  stageOrder,
  wayOf,
} from "./returns.ts";
import type {
  GoalProgress,
  ReturnWorkflow,
  Stage,
  Way,
  WorkflowReturn,
} from "./returns.ts";
import { useFull } from "./widget-block.tsx";

// The prototype's standard widgets that the dashboard starts with, besides
// the workflows (`components/dashboard/widget-parts.tsx`: `ReturnChartView`
// and `GoalListView`), as they show on the board and in full.
// A widget is read in one look: one picture that says where things stand,
// and in full every line, and what the colours mean. One set of colours
// runs through all of them: green for what is live or measured, a light
// green for what is on its way or expected, grey for what is still by
// hand, orange for what needs someone. The prototype's ways to turn a
// widget (fewer lines, another value, another order) are for widgets Grasp
// writes, and come with them.

/** What a mark or a part of a picture stands for. */
export type Tone = "live" | "coming" | "rest" | "attention";

const toneOfWay: Record<Way, Tone> = {
  live: "live",
  onTheWay: "coming",
  mapped: "rest",
};

/** A workflow's mark by its stage: green once it is live, light green while it is redesigned or tested, grey before that. */
const toneOfStage = (stage: Stage): Tone => toneOfWay[wayOf(stage)];

const marks: Record<Tone, string> = {
  live: "size-2 flex-none rounded-full bg-status-agreed",
  coming:
    "size-2 flex-none rounded-full border border-status-agreed bg-return-expected",
  rest: "size-2 flex-none rounded-full bg-input",
  attention: "size-2 flex-none rounded-full bg-status-attention",
};

export const Mark = ({ tone }: { tone: Tone }) => (
  <span aria-hidden="true" className={marks[tone]} />
);

/** What a dot or a part of a bar is painted in, by what it stands for. */
export const fills: Record<Tone, string> = {
  live: "bg-status-agreed",
  coming: "border border-status-agreed bg-return-expected",
  rest: "bg-bar-manual",
  attention: "bg-status-attention",
};

/** What a part of a ring is drawn in, by what it stands for. */
const strokes: Record<Tone, string> = {
  live: "stroke-status-agreed",
  coming: "stroke-return-expected",
  rest: "stroke-bar-manual",
  attention: "stroke-status-attention",
};

/**
 * One part of a picture: what it stands for and how much of it it takes.
 * `label` is what its colour means and `says` what it comes to, in words;
 * a picture that counts things has a part for each, with the thing's
 * `name`. All three are what the part says when it is pointed at.
 */
interface Piece {
  tone: Tone;
  share: number;
  label?: string;
  says?: string;
  /** What `says` is counted over, such as "a month": said small beside it. */
  per?: string;
  name?: string;
}

/** A ring's radius and its line's width, in the units it is drawn in (a box of 100). */
const ring = { radius: 45, width: 8, gap: 1.6 };

/** What a part says when it is pointed at. */
const PieceSays = ({ piece }: { piece: Piece }) => (
  <span className="flex flex-col text-left">
    <span className="text-foreground font-medium">
      {piece.name ?? piece.label}
    </span>
    {piece.name !== undefined && piece.label !== undefined ? (
      <span>{piece.label}</span>
    ) : null}
    {piece.says === undefined ? null : (
      <span className="tabular-nums">
        {[piece.says, piece.per].filter(Boolean).join(" ")}
      </span>
    )}
  </span>
);

/**
 * A ring: a whole in parts, each as long as its share, with room in its
 * middle for what the whole comes to. Every part says what it is when it
 * is pointed at. Its size is its box's.
 */
const Ring = ({
  pieces,
  children,
}: {
  pieces: Piece[];
  children?: ReactNode;
}) => {
  const shown = pieces.filter((piece) => piece.share > 0);
  const whole = shown.reduce((total, piece) => total + piece.share, 0);
  const round = 2 * Math.PI * ring.radius;
  const gap = shown.length > 1 ? ring.gap : 0;
  // Where each part begins along the ring: where the ones before it end.
  const longs = shown.map((piece) => (piece.share / whole) * round);
  const starts = longs.map((_, index) =>
    longs.slice(0, index).reduce((total, each) => total + each, 0)
  );
  return (
    <span className="relative block size-full">
      <svg
        aria-hidden="true"
        className="size-full -rotate-90"
        viewBox="0 0 100 100"
      >
        {shown.map((piece, index) => (
          <Tooltip key={index}>
            <TooltipTrigger
              render={
                <circle
                  className={strokes[piece.tone]}
                  cx="50"
                  cy="50"
                  fill="none"
                  r={ring.radius}
                  strokeDasharray={`${Math.max((longs[index] ?? 0) - gap, 0.5)} ${round}`}
                  strokeDashoffset={-(starts[index] ?? 0)}
                  strokeWidth={ring.width}
                />
              }
            />
            <TooltipContent side="top" variant="quiet">
              <PieceSays piece={piece} />
            </TooltipContent>
          </Tooltip>
        ))}
      </svg>
      {children === undefined ? null : (
        <span className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          {children}
        </span>
      )}
    </span>
  );
};

/** What a widget says when it has nothing to show. */
export const Nothing = ({ children }: { children: ReactNode }) => (
  <p className="text-muted-foreground">{children}</p>
);

const dash = <span className="text-muted-foreground">—</span>;

/** A workflow's name, as the way to its page. */
const WorkflowLink = ({
  workflow,
  className,
}: {
  workflow: ReturnWorkflow;
  className: string;
}) => (
  <Link
    className={className}
    params={{ workflow: workflow.id }}
    to="/workflows/$workflow"
  >
    {workflow.name}
  </Link>
);

/** A workflow's mark by its return: green where it is measured, light green where it is expected, grey before. */
const toneOfReturn = (row: WorkflowReturn): Tone => {
  if (row.back === null) {
    return "rest";
  }
  return row.stage === "live" ? "live" : "coming";
};

/** Where a workflow comes in a list by return: what is measured first, then what is expected, then what nobody redesigned yet. */
const returnRank = (row: WorkflowReturn): number => {
  if (row.back === null) {
    return 2;
  }
  return row.stage === "live" ? 0 : 1;
};

/** The counted workflows by return: the measured ones before the expected ones, each by how much, then the ones nobody redesigned yet. */
const byReturn = (rows: readonly WorkflowReturn[]): WorkflowReturn[] =>
  rows
    .filter((row) => row.before !== null)
    .toSorted(
      (a, b) =>
        returnRank(a) - returnRank(b) ||
        (b.back ?? b.before ?? 0) - (a.back ?? a.before ?? 0)
    );

/**
 * The return in one look: what all the counted work costs by hand a
 * month as a ring, how much of it comes back (measured where something is
 * live, expected from the designs) and what stays by hand. In full, every
 * workflow, in columns that say what they are.
 */
export const ReturnChartView = ({
  rows: all,
}: {
  rows: readonly WorkflowReturn[];
}) => {
  const { t } = useLingui();
  const full = useFull();
  const month = t({
    message: "a month",
    context: "under an amount on a dashboard chart",
  });
  const totals = returnTotals(all);
  const rows = byReturn(all);
  if (rows.length === 0) {
    return (
      <Nothing>
        <Trans>No workflow with counted hours here yet.</Trans>
      </Nothing>
    );
  }
  const rest = Math.max(totals.byHand - totals.back - totals.coming, 0);
  const whole = formatEuro(totals.byHand);
  const pieces: Piece[] = [
    {
      tone: "live",
      share: totals.back,
      label: t`Measured return`,
      says: formatEuro(totals.back),
      per: month,
    },
    {
      tone: "coming",
      share: totals.coming,
      label: t`Expected return`,
      says: formatEuro(totals.coming),
      per: month,
    },
    {
      tone: "rest",
      share: rest,
      label: t`Stays by hand`,
      says: formatEuro(rest),
      per: month,
    },
  ];
  return (
    <>
      {/* The whole is what the counted work costs by hand; the ring says how much of it comes back. */}
      <div
        className={
          full
            ? "flex flex-wrap items-center gap-x-10 gap-y-5"
            : "flex min-h-0 flex-1 flex-col items-center justify-center gap-x-8 gap-y-3 @sm:flex-row"
        }
      >
        <span
          className={
            full
              ? "size-48 flex-none"
              : "aspect-square h-28 flex-none @sm:h-full @sm:max-h-52"
          }
        >
          <Ring pieces={pieces}>
            <Stat size={full ? "default" : "compact"}>{whole}</Stat>
            <span
              className={
                full
                  ? "text-muted-foreground"
                  : "text-muted-foreground hidden @sm:inline"
              }
            >
              <Trans>by hand, a month</Trans>
            </span>
          </Ring>
        </span>
        <dl
          className={
            full
              ? "flex min-w-0 flex-1 basis-56 flex-col"
              : "flex w-full min-w-0 flex-col @sm:flex-1"
          }
        >
          {pieces.map((piece) => (
            <div
              className={
                full
                  ? "flex items-center gap-2.5 border-t py-2.5 first:border-t-0"
                  : "flex items-center gap-2.5 border-t py-2 first:border-t-0 @sm:py-4"
              }
              key={piece.tone}
            >
              <Mark tone={piece.tone} />
              <dt
                className={
                  full
                    ? "min-w-0 flex-1 truncate"
                    : "min-w-0 flex-1 text-pretty"
                }
              >
                {piece.label}
              </dt>
              <dd
                className={cn(
                  "flex-none font-medium tabular-nums",
                  piece.tone === "live" && "text-status-agreed"
                )}
              >
                {piece.says}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {/* In full, every workflow, in columns that say what they are, so no number has to be guessed at. */}
      {full ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Trans>Workflow</Trans>
              </TableHead>
              <TableHead className="text-right">
                <Trans>By hand now</Trans>
              </TableHead>
              <TableHead className="text-right">
                <Trans>With AI</Trans>
              </TableHead>
              <TableHead className="text-right">
                <Trans context="column: the value of the hours that come free a month">
                  Return
                </Trans>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={returnKey(row)}>
                <TableCell>
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Mark tone={toneOfReturn(row)} />
                    <WorkflowLink
                      className="min-w-0 truncate hover:underline"
                      workflow={row.workflow}
                    />
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <span className="tabular-nums">
                    {row.before === null ? dash : formatEuro(row.before)}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <span className="text-muted-foreground tabular-nums">
                    {row.after === null ? dash : formatEuro(row.after)}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <span
                    className={cn(
                      "font-medium tabular-nums",
                      row.stage === "live" &&
                        row.back !== null &&
                        "text-status-agreed"
                    )}
                  >
                    {row.back === null ? dash : formatEuro(row.back)}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </>
  );
};

/** The workflows that serve a goal, the furthest first. */
const furthestFirst = (rows: readonly WorkflowReturn[]): WorkflowReturn[] =>
  rows.toSorted((a, b) => stageOrder[a.stage] - stageOrder[b.stage]);

/** What a goal comes to in full: its measured return, else its expected one. */
const GoalReturn = ({ goal }: { goal: GoalProgress }) => {
  const { t } = useLingui();
  const back = formatEuro(goal.back);
  const coming = formatEuro(goal.coming);
  if (goal.back > 0) {
    return t`${back} measured return`;
  }
  if (goal.coming > 0) {
    return t`${coming} expected return`;
  }
  return dash;
};

/**
 * The board's goals: a ring for every goal, a part for each workflow that
 * serves it in its stage's colour, and how many of them are live in its
 * middle. In full, a goal with its workflows and their stage.
 */
export const GoalListView = ({ goals }: { goals: readonly GoalProgress[] }) => {
  const { t, i18n } = useLingui();
  const full = useFull();
  if (goals.length === 0) {
    return (
      <Nothing>
        <Trans>No goals yet.</Trans>
      </Nothing>
    );
  }
  const label: Record<Way, string> = {
    live: t({
      message: "Live",
      context: "a workflow that runs, in the goals legend",
    }),
    onTheWay: t`Redesigned or testing`,
    mapped: t`Only mapped`,
  };
  return (
    <>
      <ul
        className={
          full
            ? "grid grid-cols-1 gap-x-6 gap-y-8 @md:grid-cols-3"
            : "grid min-h-0 flex-1 grid-cols-3 content-center gap-x-4"
        }
      >
        {goals.map((goal) => {
          const { live } = goal;
          const count = goal.rows.length;
          const rows = furthestFirst(goal.rows);
          return (
            <li
              className="flex min-w-0 flex-col items-center gap-3 text-center"
              key={goal.id}
            >
              <span
                className={
                  full
                    ? "size-36 flex-none"
                    : "aspect-square w-full max-w-36 flex-none"
                }
              >
                <Ring
                  pieces={rows.map((row) => ({
                    tone: toneOfStage(row.stage),
                    share: 1,
                    name: row.workflow.name,
                    label: i18n._(stageLabel[row.stage]),
                  }))}
                >
                  <Stat size={full ? "default" : "compact"}>
                    {t`${live} of ${count}`}
                  </Stat>
                  <span
                    className={
                      full
                        ? "text-muted-foreground"
                        : "text-muted-foreground hidden @sm:inline"
                    }
                  >
                    <Trans context="how many of a goal's workflows are live, under the count">
                      live
                    </Trans>
                  </span>
                </Ring>
              </span>
              <span
                className={
                  full
                    ? "text-balance"
                    : "line-clamp-6 text-balance @sm:line-clamp-3"
                }
              >
                {goal.title}
              </span>
              {full ? (
                <>
                  <span className="text-muted-foreground tabular-nums">
                    <GoalReturn goal={goal} />
                  </span>
                  {/* Which workflows the count is of: each with its stage, and the way to it. */}
                  <ul className="flex w-full flex-col border-t pt-3 text-left">
                    {rows.map((row) => (
                      <li
                        className="flex items-baseline gap-2.5 py-1"
                        key={returnKey(row)}
                      >
                        <Mark tone={toneOfStage(row.stage)} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <WorkflowLink
                            className="text-pretty hover:underline"
                            workflow={row.workflow}
                          />
                          <span className="text-muted-foreground">
                            {i18n._(stageLabel[row.stage])}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
      {full ? (
        <span className="text-muted-foreground flex flex-wrap items-center justify-center gap-x-5 gap-y-1">
          {(["live", "onTheWay", "mapped"] as const).map((way) => (
            <span className="flex items-center gap-2" key={way}>
              <Mark tone={toneOfWay[way]} />
              {label[way]}
            </span>
          ))}
        </span>
      ) : null}
    </>
  );
};
