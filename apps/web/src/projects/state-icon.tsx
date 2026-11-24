import { colors, size } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

import type { WorkflowState } from "../workflows/overview.ts";

// How a workflow stands, as one small round mark (Ruben, 21 November, after
// Linear's states): each state its own shape, so the mark reads without its
// colour, and the circle fills as the workflow comes to life: half while it
// is built, whole with a tick once a version runs. It stands at the start
// of a workflow's row on a project's page. #2503's workflows/state-icon.tsx,
// the product's own (Damsko has no state mark); the project page is its one
// user now that the workflows' overview is a table.

const styles = stylex.create({
  mark: {
    display: "block",
    flexShrink: 0,
    width: size.iconSm,
    height: size.iconSm,
  },
  failing: { color: colors.destructive },
  waiting: { color: colors.warning },
  paused: { color: colors.mutedForeground },
  blocked: { color: colors.warning },
  live: { color: colors.success },
  building: { color: colors.info },
  // The tick is cut out of the filled circle: the ground shows through it.
  cut: { stroke: colors.background },
});

/** The ring every mark but the filled one stands in. */
const Ring = () => (
  <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" />
);

/** Every mark: a workflow's states, and a run's own. */
type Mark = WorkflowState;

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
};

/** The mark of each way a run stands. */

const MarkIcon = ({ mark }: { mark: Mark }) => {
  const Shape = shapes[mark];
  return (
    <svg
      aria-hidden="true"
      data-state={mark}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
      {...stylex.props(styles.mark, styles[mark])}
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
  <MarkIcon mark={state} />
);
