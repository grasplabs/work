/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: the new names stand on the old parts until step 9 moves them here (handover/audit/RELEASE.md §7). */
import { TextShimmer } from "../text-shimmer";
import type {
  TextShimmerLayoutStyle,
  TextShimmerProps,
  TextShimmerStrength,
} from "../text-shimmer";

/** Every prop a Shimmer takes: Text shimmer's (its table is on the Text shimmer page, as Shimmer). */
export type ShimmerProps = TextShimmerProps;
export type ShimmerStrength = TextShimmerStrength;
export type ShimmerLayoutStyle = TextShimmerLayoutStyle;

/** A line of words a band of light crosses while something works on it. */
export const Shimmer = (props: ShimmerProps) => <TextShimmer {...props} />;
