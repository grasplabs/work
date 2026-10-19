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
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { formatEuro, formatPercent } from "../format.ts";
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
  TeamLevel,
  TeamProgress,
  Way,
  WorkflowReturn,
} from "./returns.ts";
import { useFull } from "./widget-block.tsx";

// The prototype's standard widgets that the dashboard starts with, besides
// the workflows (`components/dashboard/widget-parts.tsx`: `ReturnChartView`,
// `GoalListView`, `TeamListView`), as they show on the board and in full.
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

/** A workflow's name, opening it. */
const WorkflowLink = ({
  workflow,
  className,
}: {
  workflow: ReturnWorkflow;
  className: string;
}) => (
  <Link
    className={className}
    params={{ app: workflow.app, workflow: workflow.name }}
    to="/workflows/$app/$workflow"
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
            <span
              className={
                full
                  ? "text-2xl font-medium tabular-nums"
                  : "font-medium tabular-nums @sm:text-2xl"
              }
            >
              {whole}
            </span>
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
                  <span
                    className={
                      full
                        ? "text-2xl font-medium tabular-nums"
                        : "font-medium tabular-nums @sm:text-2xl"
                    }
                  >
                    {t`${live} of ${count}`}
                  </span>
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

/** What each team level says, as its name and what it means. */
const useLevelText = (): Record<
  TeamLevel,
  { name: string; meaning: string }
> => {
  const { t } = useLingui();
  return {
    notStarted: {
      name: t({ message: "Not started", context: "how far a team is with AI" }),
      meaning: t`None of this team's work is mapped yet.`,
    },
    mapped: {
      name: t({ message: "Work mapped", context: "how far a team is with AI" }),
      meaning: t`Its work is mapped; nothing is redesigned with AI yet.`,
    },
    redesign: {
      name: t({ message: "Redesigning", context: "how far a team is with AI" }),
      meaning: t`A workflow is redesigned with AI and waits for its test.`,
    },
    testing: {
      name: t({ message: "Testing", context: "how far a team is with AI" }),
      meaning: t`A workflow with AI is in its test run.`,
    },
    live: {
      name: t({ message: "Live", context: "how far a team is with AI" }),
      meaning: t`A workflow with AI runs on real work.`,
    },
    scaling: {
      name: t({ message: "Scaling", context: "how far a team is with AI" }),
      meaning: t`Several workflows run with AI, across most of its work by hand.`,
    },
  };
};

/** A team's mark: orange when it needs help, green once something of its work runs, light green while it redesigns or tests, grey before that. */
const toneOfTeam = (team: TeamProgress): Tone => {
  if (team.needsHelp) {
    return "attention";
  }
  if (team.level === "live" || team.level === "scaling") {
    return "live";
  }
  return team.level === "redesign" || team.level === "testing"
    ? "coming"
    : "rest";
};

/**
 * What matters for a workflow now, saying what kind of number it is: once
 * it is designed, its expected return a month; before that, its current
 * cost.
 */
const WorkflowValue = ({ row }: { row: WorkflowReturn }) => {
  const { t } = useLingui();
  if (row.before === null) {
    return t`not counted yet`;
  }
  const before = formatEuro(row.before);
  if (row.back === null) {
    return t`${before} a month current cost`;
  }
  const back = formatEuro(row.back);
  return t`${back} a month expected return`;
};

/** Why a team needs help, if it does. */
const useNeedsHelp = (team: TeamProgress): string => {
  const { t } = useLingui();
  const cost = formatEuro(team.cost);
  if (!team.needsHelp) {
    return "";
  }
  return team.share !== null && team.share > 0
    ? t`Needs help: less redesigned than the company, and nothing tested yet`
    : t`Needs help: ${cost} a month current cost, nothing redesigned yet`;
};

/** What a team's work is, pointed at: what its level means; why it needs help, if it does; its workflows by step, their return, and what its live work handled. */
const TeamDetails = ({
  team,
  meaning,
}: {
  team: TeamProgress;
  meaning: string;
}) => {
  const { t } = useLingui();
  const help = useNeedsHelp(team);
  const measured = formatEuro(team.measured);
  const expected = formatEuro(team.expected);
  const { workflows, live, testing, redesign, mapped, handled, alone } = team;
  const steps = [
    live ? t`${live} live` : "",
    testing ? t`${testing} testing` : "",
    redesign ? t`${redesign} redesigning` : "",
    mapped ? t`${mapped} mapped` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return [
    meaning,
    help,
    workflows
      ? t`${plural(workflows, { one: "# workflow", other: "# workflows" })}: ${steps}`
      : t`No workflows yet`,
    team.measured ? t`${measured} a month measured return` : "",
    team.expected ? t`${expected} a month expected return` : "",
    handled ? t`${alone} of ${handled} items without a person` : "",
  ]
    .filter(Boolean)
    .join(" · ");
};

/** The steps a team takes with AI, as the teams widget's columns: each with the stages of the workflows that stand there. */
const useSteps = (): { key: string; name: string; stages: Stage[] }[] => {
  const { t } = useLingui();
  const levels = useLevelText();
  return [
    {
      key: "mapped",
      name: t({
        message: "Mapped",
        context:
          "short name of the first step a team takes with AI, over a narrow column",
      }),
      stages: ["check", "agreed"],
    },
    { key: "redesign", name: levels.redesign.name, stages: ["redesign"] },
    { key: "testing", name: levels.testing.name, stages: ["testing"] },
    { key: "live", name: levels.live.name, stages: ["live"] },
  ];
};

/** One workflow in a team's row: it says which when it is pointed at, and a press opens it. */
const TeamWorkflowDot = ({ row }: { row: WorkflowReturn }) => {
  const { i18n } = useLingui();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            aria-label={row.workflow.name}
            className="focus-visible:ring-ring flex size-4 items-center justify-center rounded-full outline-none focus-visible:ring-2"
            params={{ app: row.workflow.app, workflow: row.workflow.name }}
            to="/workflows/$app/$workflow"
          />
        }
      >
        <span
          className={cn("size-3 rounded-full", fills[toneOfStage(row.stage)])}
        />
      </TooltipTrigger>
      <TooltipContent side="top" variant="quiet">
        <span className="flex flex-col text-left">
          <span className="text-foreground font-medium">
            {row.workflow.name}
          </span>
          <span>{i18n._(stageLabel[row.stage])}</span>
          <span>
            <WorkflowValue row={row} />
          </span>
        </span>
      </TooltipContent>
    </Tooltip>
  );
};

/**
 * Every team's work with AI, the furthest first. Where a team stands is
 * where its workflows stand, each of them: a team with one of ten live is
 * not where a team with one of two is. So every workflow is a dot in the
 * column of its step, and the row ends with how many of them run. In full
 * the picture has all the room it wants, with how much of each team's work
 * by hand is redesigned. The prototype's way to help a team that is behind
 * asks Grasp in the chat, which comes with the teams' numbers.
 */
export const TeamListView = ({
  teams,
  rows: all,
}: {
  teams: readonly TeamProgress[];
  rows: readonly WorkflowReturn[];
}) => {
  const { t } = useLingui();
  const full = useFull();
  const levels = useLevelText();
  const steps = useSteps();
  if (teams.length === 0) {
    return (
      <Nothing>
        <Trans>No teams yet.</Trans>
      </Nothing>
    );
  }
  // In full its least width fits the dialog on a laptop; on a narrower screen it moves sideways under the team's name, which stays where it is.
  const fixed = full
    ? "bg-popover sticky left-0 z-10 flex h-full min-w-0 items-center gap-2.5"
    : "flex items-center gap-2.5 pr-3 whitespace-nowrap";
  // One grid for the whole picture: every row takes its columns from it, so a dot always stands under its step, whatever the names are.
  const track = full
    ? "team-columns-full grid gap-x-4"
    : "team-columns @md:team-columns-steps grid h-full auto-rows-fr gap-x-3";
  const columns = "col-span-full grid grid-cols-subgrid items-center";
  return (
    <div className={full ? "overflow-x-auto" : "min-h-0 flex-1"}>
      <div className={track}>
        <div
          className={cn(
            columns,
            "text-muted-foreground",
            full ? "pb-3" : "pb-2 text-xs"
          )}
        >
          <span className={full ? "bg-popover sticky left-0 z-10" : undefined}>
            <Trans>Team</Trans>
          </span>
          {steps.map((step) => (
            <span
              className={
                full
                  ? "text-center"
                  : "hidden text-center whitespace-nowrap @md:block"
              }
              key={step.key}
            >
              {step.name}
            </span>
          ))}
          {/* The last column says what it is in its own words on every row. */}
          <span />
          {full ? (
            <>
              <span className="text-right">
                <Trans context="column: the share of a team's work by hand that is redesigned">
                  Redesigned
                </Trans>
              </span>
              <span />
            </>
          ) : null}
        </div>
        {teams.map((team) => {
          const own = all.filter((row) => row.workflow.teamId === team.id);
          const { live } = team;
          const count = team.workflows;
          return (
            <div
              className={cn(columns, "border-t", full ? "h-14" : "min-h-0")}
              key={team.id}
            >
              <Tooltip>
                <TooltipTrigger delay={250} render={<span className={fixed} />}>
                  <Mark tone={toneOfTeam(team)} />
                  {team.name}
                </TooltipTrigger>
                <TooltipContent align="start" side="bottom" variant="quiet">
                  <span className="text-left">
                    <TeamDetails
                      meaning={levels[team.level].meaning}
                      team={team}
                    />
                  </span>
                </TooltipContent>
              </Tooltip>
              {steps.map((step) => (
                <span
                  className={
                    full
                      ? "flex flex-wrap items-center justify-center gap-1"
                      : "hidden flex-wrap items-center justify-center gap-1 @md:flex"
                  }
                  key={step.key}
                >
                  {own
                    .filter((row) => step.stages.includes(row.stage))
                    .map((row) => (
                      <TeamWorkflowDot key={returnKey(row)} row={row} />
                    ))}
                </span>
              ))}
              {/* How many of its workflows run, of how many: what "where it stands" comes to in one number. */}
              <span
                className={cn(
                  "text-right whitespace-nowrap tabular-nums",
                  live === 0 && "text-muted-foreground"
                )}
              >
                {t`${live} of ${count} live`}
              </span>
              {full ? (
                <>
                  <span className="text-right tabular-nums">
                    {team.share === null ? dash : formatPercent(team.share)}
                  </span>
                  <span />
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};
