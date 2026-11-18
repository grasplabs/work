import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { formatEuro } from "../format.ts";
import { RouterLink } from "../frame/router-link.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../grasp/table/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
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
//
// The rings are drawn here, not with Grasp UI's ChartRing: that one paints
// its parts by their order, and these by what each stands for (a goal has a
// part for each of its workflows, in its stage's colour). A part names
// itself when pointed at with the drawing's own title, as Grasp UI's
// tooltip opens only on its own Button.

/** What a mark or a part of a picture stands for. */
export type Tone = "live" | "coming" | "rest" | "attention";

const toneOfWay: Record<Way, Tone> = {
  live: "live",
  onTheWay: "coming",
  mapped: "rest",
};

/** A workflow's mark by its stage: green once it is live, light green while it is redesigned or tested, grey before that. */
const toneOfStage = (stage: Stage): Tone => toneOfWay[wayOf(stage)];

/** The board's container widths at which a widget has room to lay out beside itself (Tailwind's `@sm` and `@md`). */
const WIDE = "@container (min-width: 24rem)";
const WIDER = "@container (min-width: 28rem)";

/** Each tone's colour, as a mark's fill. */
const toneFills = stylex.create({
  live: { backgroundColor: grasp.success },
  coming: { backgroundColor: grasp.mint },
  rest: { backgroundColor: grasp.chartQuietFill },
  attention: { backgroundColor: grasp.attention },
});

/** Each tone's colour, as a part of a ring. */
const toneStrokes = stylex.create({
  live: { stroke: grasp.success },
  coming: { stroke: grasp.mint },
  rest: { stroke: grasp.chartQuietFill },
  attention: { stroke: grasp.attention },
});

const styles = stylex.create({
  mark: {
    flexShrink: 0,
    width: grasp.space2,
    height: grasp.space2,
    borderRadius: grasp.cornerCircle,
  },
  // The room a widget lays itself out in: its own width decides, not the window's.
  room: {
    containerType: "inline-size",
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  },
  roomBoard: { flexGrow: 1, minHeight: 0 },
  roomFull: { rowGap: grasp.space8 },
  ringBox: {
    position: "relative",
    display: "block",
    width: "100%",
    height: "100%",
  },
  ringDrawing: {
    display: "block",
    width: "100%",
    height: "100%",
    transform: "rotate(-90deg)",
  },
  ringMiddle: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    pointerEvents: "none",
  },
  figure: {
    color: grasp.ink,
    fontFamily: grasp.fontSans,
    fontWeight: grasp.weightMedium,
    fontVariantNumeric: "tabular-nums",
  },
  figureFull: { fontSize: grasp.titleMd, lineHeight: grasp.titleMdLine },
  figureBoard: { fontSize: grasp.textLg, lineHeight: grasp.textLgLine },
  // Under the figure on the board only once there is room for it.
  wideOnly: { display: { default: "none", [WIDE]: "inline" } },
  // The return: its ring beside what it comes to.
  returnFull: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: grasp.space10,
    rowGap: grasp.space5,
  },
  returnBoard: {
    display: "flex",
    flexDirection: { default: "column", [WIDE]: "row" },
    flexGrow: 1,
    minHeight: 0,
    alignItems: "center",
    justifyContent: "center",
    columnGap: grasp.space8,
    rowGap: grasp.space3,
  },
  returnRingFull: { flexShrink: 0, width: "12rem", height: "12rem" },
  returnRingBoard: {
    flexShrink: 0,
    aspectRatio: "1",
    height: { default: "7rem", [WIDE]: "100%" },
    maxHeight: { default: null, [WIDE]: "13rem" },
  },
  pieces: { display: "flex", flexDirection: "column", minWidth: 0, margin: 0 },
  piecesFull: { flexGrow: 1, flexBasis: "14rem" },
  piecesBoard: {
    width: { default: "100%", [WIDE]: "auto" },
    flexGrow: { default: 0, [WIDE]: 1 },
  },
  piece: {
    display: "flex",
    alignItems: "center",
    columnGap: grasp.space3,
    paddingBlock: grasp.space3,
    borderTopWidth: { default: grasp.hairline, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: grasp.line,
  },
  pieceBoard: {
    paddingBlock: { default: grasp.space2, [WIDE]: grasp.space4 },
  },
  pieceName: { flexGrow: 1, minWidth: 0, margin: 0 },
  pieceNameFull: {
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
  pieceNameBoard: { textWrap: "pretty" },
  pieceSays: {
    flexShrink: 0,
    margin: 0,
    fontWeight: grasp.weightMedium,
    fontVariantNumeric: "tabular-nums",
  },
  measured: { color: grasp.success },
  figures: { fontVariantNumeric: "tabular-nums" },
  quietFigures: { color: grasp.muted, fontVariantNumeric: "tabular-nums" },
  strongFigures: {
    fontWeight: grasp.weightMedium,
    fontVariantNumeric: "tabular-nums",
  },
  workflowCell: {
    display: "flex",
    alignItems: "center",
    columnGap: grasp.space3,
    minWidth: 0,
  },
  // The goals: a ring for each, three abreast.
  goalsFull: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [WIDER]: "repeat(3, minmax(0, 1fr))",
    },
    columnGap: grasp.space6,
    rowGap: grasp.space8,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  goalsBoard: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    alignContent: "center",
    flexGrow: 1,
    minHeight: 0,
    columnGap: grasp.space4,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  goal: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    rowGap: grasp.space3,
    minWidth: 0,
    textAlign: "center",
  },
  goalRingFull: { flexShrink: 0, width: "9rem", height: "9rem" },
  goalRingBoard: {
    flexShrink: 0,
    aspectRatio: "1",
    width: "100%",
    maxWidth: "9rem",
  },
  goalTitle: { textWrap: "balance" },
  goalTitleBoard: {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: { default: 6, [WIDE]: 3 },
    overflow: "hidden",
  },
  goalWorkflows: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    margin: 0,
    padding: 0,
    paddingBlockStart: grasp.space3,
    listStyle: "none",
    textAlign: "start",
    borderTopWidth: grasp.hairline,
    borderTopStyle: "solid",
    borderTopColor: grasp.line,
  },
  goalWorkflow: {
    display: "flex",
    alignItems: "baseline",
    columnGap: grasp.space3,
    paddingBlock: grasp.space1,
  },
  goalWorkflowWords: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
  },
  legend: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    columnGap: grasp.space5,
    rowGap: grasp.space1,
    color: grasp.muted,
  },
  legendItem: {
    display: "flex",
    alignItems: "center",
    columnGap: grasp.space2,
  },
});

export const Mark = ({ tone }: { tone: Tone }) => (
  <span aria-hidden="true" {...stylex.props(styles.mark, toneFills[tone])} />
);

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

/** What a part says when it is pointed at, one line under the other. */
const pieceSays = (piece: Piece): string =>
  [
    piece.name ?? piece.label,
    piece.name === undefined ? undefined : piece.label,
    piece.says === undefined
      ? undefined
      : [piece.says, piece.per].filter(Boolean).join(" "),
  ]
    .filter((line) => line !== undefined)
    .join("\n");

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
    <span {...stylex.props(styles.ringBox)}>
      <svg
        aria-hidden="true"
        viewBox="0 0 100 100"
        {...stylex.props(styles.ringDrawing)}
      >
        {shown.map((piece, index) => (
          <circle
            cx="50"
            cy="50"
            fill="none"
            key={index}
            r={ring.radius}
            strokeDasharray={`${Math.max((longs[index] ?? 0) - gap, 0.5)} ${round}`}
            strokeDashoffset={-(starts[index] ?? 0)}
            strokeWidth={ring.width}
            {...stylex.props(toneStrokes[piece.tone])}
          >
            <title>{pieceSays(piece)}</title>
          </circle>
        ))}
      </svg>
      {children === undefined ? null : (
        <span {...stylex.props(styles.ringMiddle)}>{children}</span>
      )}
    </span>
  );
};

/** The figure in a ring's middle, as large as the view it stands in. */
const RingFigure = ({
  full,
  children,
}: {
  full: boolean;
  children: ReactNode;
}) => (
  <span
    {...stylex.props(
      styles.figure,
      full ? styles.figureFull : styles.figureBoard
    )}
  >
    {children}
  </span>
);

/** What a widget says when it has nothing to show. */
export const Nothing = ({ children }: { children: ReactNode }) => (
  <Text tone="muted">{children}</Text>
);

const dash = (
  <Text element="span" tone="muted">
    —
  </Text>
);

/** A workflow's name, as the way to its page. */
const WorkflowLink = ({ workflow }: { workflow: ReturnWorkflow }) => (
  <RouterLink
    params={{ workflow: workflow.id }}
    to="/workflows/$workflow"
    variant="standalone"
  >
    {workflow.name}
  </RouterLink>
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

/** Whether a workflow's return is measured: then it is said in green. */
const isMeasured = (row: WorkflowReturn): boolean =>
  row.stage === "live" && row.back !== null;

/** In full, every counted workflow, in columns that say what they are, so no number has to be guessed at. */
const ReturnTable = ({ rows }: { rows: readonly WorkflowReturn[] }) => (
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>
          <Trans>Workflow</Trans>
        </TableHead>
        <TableHead align="end">
          <Trans>By hand now</Trans>
        </TableHead>
        <TableHead align="end">
          <Trans>With AI</Trans>
        </TableHead>
        <TableHead align="end">
          <Trans context="column: the value of the hours that come free a month">
            Return
          </Trans>
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {rows.map((row) => (
        <TableRow key={returnKey(row)}>
          <TableCell lead>
            <span {...stylex.props(styles.workflowCell)}>
              <Mark tone={toneOfReturn(row)} />
              <WorkflowLink workflow={row.workflow} />
            </span>
          </TableCell>
          <TableCell align="end">
            <span {...stylex.props(styles.figures)}>
              {row.before === null ? dash : formatEuro(row.before)}
            </span>
          </TableCell>
          <TableCell align="end">
            <span {...stylex.props(styles.quietFigures)}>
              {row.after === null ? dash : formatEuro(row.after)}
            </span>
          </TableCell>
          <TableCell align="end">
            <span
              {...stylex.props(
                styles.strongFigures,
                isMeasured(row) && styles.measured
              )}
            >
              {row.back === null ? dash : formatEuro(row.back)}
            </span>
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
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
    <div
      {...stylex.props(styles.room, full ? styles.roomFull : styles.roomBoard)}
    >
      {/* The whole is what the counted work costs by hand; the ring says how much of it comes back. */}
      <div {...stylex.props(full ? styles.returnFull : styles.returnBoard)}>
        <span
          {...stylex.props(
            full ? styles.returnRingFull : styles.returnRingBoard
          )}
        >
          <Ring pieces={pieces}>
            <RingFigure full={full}>{whole}</RingFigure>
            <Text
              element="span"
              layout={full ? undefined : styles.wideOnly}
              tone="muted"
            >
              <Trans>by hand, a month</Trans>
            </Text>
          </Ring>
        </span>
        <dl
          {...stylex.props(
            styles.pieces,
            full ? styles.piecesFull : styles.piecesBoard
          )}
        >
          {pieces.map((piece) => (
            <div
              key={piece.tone}
              {...stylex.props(styles.piece, !full && styles.pieceBoard)}
            >
              <Mark tone={piece.tone} />
              <dt
                {...stylex.props(
                  styles.pieceName,
                  full ? styles.pieceNameFull : styles.pieceNameBoard
                )}
              >
                {piece.label}
              </dt>
              <dd
                {...stylex.props(
                  styles.pieceSays,
                  piece.tone === "live" && styles.measured
                )}
              >
                {piece.says}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {full ? <ReturnTable rows={rows} /> : null}
    </div>
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

/** In full, which workflows a goal's count is of: each with its stage, and the way to it. */
const GoalWorkflows = ({ rows }: { rows: readonly WorkflowReturn[] }) => {
  const { i18n } = useLingui();
  return (
    <ul {...stylex.props(styles.goalWorkflows)}>
      {rows.map((row) => (
        <li key={returnKey(row)} {...stylex.props(styles.goalWorkflow)}>
          <Mark tone={toneOfStage(row.stage)} />
          <span {...stylex.props(styles.goalWorkflowWords)}>
            <WorkflowLink workflow={row.workflow} />
            <Text element="span" tone="muted">
              {i18n._(stageLabel[row.stage])}
            </Text>
          </span>
        </li>
      ))}
    </ul>
  );
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
    <div
      {...stylex.props(styles.room, full ? styles.roomFull : styles.roomBoard)}
    >
      <ul {...stylex.props(full ? styles.goalsFull : styles.goalsBoard)}>
        {goals.map((goal) => {
          const { live } = goal;
          const count = goal.rows.length;
          const rows = furthestFirst(goal.rows);
          return (
            <li key={goal.id} {...stylex.props(styles.goal)}>
              <span
                {...stylex.props(
                  full ? styles.goalRingFull : styles.goalRingBoard
                )}
              >
                <Ring
                  pieces={rows.map((row) => ({
                    tone: toneOfStage(row.stage),
                    share: 1,
                    name: row.workflow.name,
                    label: i18n._(stageLabel[row.stage]),
                  }))}
                >
                  <RingFigure full={full}>{t`${live} of ${count}`}</RingFigure>
                  <Text
                    element="span"
                    layout={full ? undefined : styles.wideOnly}
                    tone="muted"
                  >
                    <Trans context="how many of a goal's workflows are live, under the count">
                      live
                    </Trans>
                  </Text>
                </Ring>
              </span>
              <span
                {...stylex.props(
                  styles.goalTitle,
                  !full && styles.goalTitleBoard
                )}
              >
                {goal.title}
              </span>
              {full ? (
                <>
                  <span {...stylex.props(styles.quietFigures)}>
                    <GoalReturn goal={goal} />
                  </span>
                  <GoalWorkflows rows={rows} />
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
      {full ? (
        <span {...stylex.props(styles.legend)}>
          {(["live", "onTheWay", "mapped"] as const).map((way) => (
            <span key={way} {...stylex.props(styles.legendItem)}>
              <Mark tone={toneOfWay[way]} />
              {label[way]}
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
};
