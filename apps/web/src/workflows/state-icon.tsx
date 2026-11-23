import * as stylex from "@stylexjs/stylex";

import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { WorkflowState } from "./overview.ts";
import type { AnyRunStatus } from "./run-status.ts";

// How a workflow stands, as one small round mark (Ruben, 21 November, after
// Linear's states): each state its own shape, so the mark reads without its
// colour, and the circle fills as the workflow comes to life: half while it
// is built, whole with a tick once a version runs. It stands at the start
// of a workflow's row and of a group's heading. Work's own until the
// library has the part (asked on grasplabs/work#2503; logged in
// .context/library-changes.md).
//
// A run takes the same marks, at the size of the head it stands in (the
// run panel's): done ticked, failed, waiting for a decision, going on as
// the half circle; and two of its own, held by its engine (a clock, as a
// fact) and stopped (a square in the ring).

const styles = stylex.create({
  mark: {
    display: "block",
    flexShrink: 0,
    width: grasp.iconSm,
    height: grasp.iconSm,
  },
  head: { width: grasp.inspectorTileIcon, height: grasp.inspectorTileIcon },
  failing: { color: grasp.danger },
  waiting: { color: grasp.attention },
  paused: { color: grasp.muted },
  blocked: { color: grasp.attention },
  live: { color: grasp.success },
  building: { color: grasp.info },
  held: { color: grasp.muted },
  stopped: { color: grasp.muted },
  // The tick is cut out of the filled circle: the ground shows through it.
  cut: { stroke: grasp.paper },
});

/** The ring every mark but the filled one stands in. */
const Ring = () => (
  <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" />
);

/** Every mark: a workflow's states, and a run's own. */
type Mark = WorkflowState | "held" | "stopped";

const shapes: Readonly<Record<Mark, () => React.JSX.Element>> = {
  // A circled exclamation: something went wrong.
  failing: () => (
    <>
      <Ring />
      <path d="M8 4.75v3.75" fill="none" stroke="currentColor" />
      <circle cx="8" cy="10.9" r="0.8" fill="currentColor" />
    </>
  ),
  // A circle holding three dots: a run waits for an answer.
  waiting: () => (
    <>
      <Ring />
      <circle cx="5.25" cy="8" r="0.8" fill="currentColor" />
      <circle cx="8" cy="8" r="0.8" fill="currentColor" />
      <circle cx="10.75" cy="8" r="0.8" fill="currentColor" />
    </>
  ),
  // Asleep: two z's, a large and a small.
  paused: () => (
    <>
      <path d="M2.5 6.75h4.5l-4.5 5.5h4.5" fill="none" stroke="currentColor" />
      <path d="M9.5 3h3.5l-3.5 4h3.5" fill="none" stroke="currentColor" />
    </>
  ),
  // A clock: live, but nothing starts it until someone allows its trigger.
  blocked: () => (
    <>
      <Ring />
      <path d="M8 5v3.25l2 1.25" fill="none" stroke="currentColor" />
    </>
  ),
  // The whole circle, ticked: a version of it runs.
  live: () => (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path d="M5 8.25l2 2 4-4.25" fill="none" {...stylex.props(styles.cut)} />
    </>
  ),
  // Half the circle: being built.
  building: () => (
    <>
      <Ring />
      <path d="M8 3.75a4.25 4.25 0 0 1 0 8.5z" fill="currentColor" />
    </>
  ),
  // A clock: a run its engine holds, until its time or its event comes.
  held: () => (
    <>
      <Ring />
      <path d="M8 5v3.25l2 1.25" fill="none" stroke="currentColor" />
    </>
  ),
  // A square in the ring: a run someone stopped.
  stopped: () => (
    <>
      <Ring />
      <rect
        x="5.75"
        y="5.75"
        width="4.5"
        height="4.5"
        rx="0.75"
        fill="currentColor"
      />
    </>
  ),
};

/** The mark of each way a run stands. */
const runMarks: Readonly<Record<AnyRunStatus, Mark>> = {
  queued: "building",
  starting: "building",
  running: "building",
  waiting: "waiting",
  paused: "held",
  completed: "live",
  failed: "failing",
  cancelled: "stopped",
};

const MarkIcon = ({ mark, head }: { mark: Mark; head: boolean }) => {
  const Shape = shapes[mark];
  return (
    <svg
      aria-hidden="true"
      data-state={mark}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
      {...stylex.props(styles.mark, head && styles.head, styles[mark])}
    >
      <Shape />
    </svg>
  );
};

/**
 * The mark of `state`. Its words stand beside it wherever it is shown (a
 * group's heading, a row's line), so the mark itself is not read out.
 */
export const WorkflowStateIcon = ({ state }: { state: WorkflowState }) => (
  <MarkIcon head={false} mark={state} />
);

/**
 * The mark of a run that stands as `status`, at the size of the run
 * panel's head. Its title says how it stands, so the mark is not read out.
 */
export const RunStateIcon = ({ status }: { status: AnyRunStatus }) => (
  <MarkIcon head mark={runMarks[status]} />
);
