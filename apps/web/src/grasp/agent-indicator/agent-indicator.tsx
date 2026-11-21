/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: the new names stand on the old parts until step 9 moves them here (handover/audit/RELEASE.md §7). */
import { WorkingMark, workingMarkVariant } from "../working-mark";
import type {
  WorkingMarkLayoutStyle,
  WorkingMarkPath,
  WorkingMarkProps,
  WorkingMarkVariant,
} from "../working-mark";

/** Every prop an AgentIndicator takes: Working mark's (its table is on the Working mark page, as AgentIndicator). */
export type AgentIndicatorProps = WorkingMarkProps;
export type AgentIndicatorVariant = WorkingMarkVariant;
export type AgentIndicatorPath = WorkingMarkPath;
export type AgentIndicatorLayoutStyle = WorkingMarkLayoutStyle;

/** The variant an agent's work is shown in by default. */
export const agentIndicatorVariant: AgentIndicatorVariant = workingMarkVariant;

/** The mark that an agent is working: never a person's or the page's own loading. */
export const AgentIndicator = (props: AgentIndicatorProps) => (
  <WorkingMark {...props} />
);
