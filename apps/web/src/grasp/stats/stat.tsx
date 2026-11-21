/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: the new names stand on the old parts until step 9 moves them here (handover/audit/RELEASE.md §7). */
import { Highlight, HighlightsGrid } from "../highlights";
import type {
  HighlightProps,
  HighlightTone,
  HighlightsGridProps,
} from "../highlights";

/** Every prop a Stat takes: Highlight's (its table is on the Highlights page, as Stat). */
export type StatProps = HighlightProps;
export type StatTone = HighlightTone;
/** Every prop a StatsGrid takes: HighlightsGrid's. */
export type StatsGridProps = HighlightsGridProps;

/** One key figure: its name, the figure, and how much it changed. */
export const Stat = (props: StatProps) => <Highlight {...props} />;

/** A row of key figures, at most four, that wraps on a narrow screen. */
export const StatsGrid = (props: StatsGridProps) => (
  <HighlightsGrid {...props} />
);
