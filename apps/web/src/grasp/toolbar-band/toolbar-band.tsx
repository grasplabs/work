// Toolbar band, now PageHeader's toolbar (`PageHeaderToolbar`, given as a PageHeader's `toolbar`):
// a thin wrapper for one step, so nothing breaks. It draws the same row. The codemod moves each use:
//
//   <ToolbarBand aria-label="Outputs" start={chips} end={search} />
//   becomes <PageHeaderToolbar aria-label="Outputs" start={chips} end={search} />, from `page-header`,
//   best given as the page's PageHeader `toolbar`.
/* oxlint-disable typescript/no-deprecated -- the breaking release's step 3: Toolbar band stays a wrapper over PageHeader's toolbar until step 9 removes it (handover/audit/RELEASE.md §7). */
import type { ReactNode } from "react";

import { PageHeaderToolbar } from "../page-header";
import type { PageHeaderToolbarLayoutStyle } from "../page-header";

/** @deprecated Use `PageHeaderToolbarLayoutStyle`, from `@/components/grasp/page-header`. */
export type ToolbarBandLayoutStyle = PageHeaderToolbarLayoutStyle;

/** @deprecated Use `PageHeaderToolbarProps`, from `@/components/grasp/page-header`. */
export interface ToolbarBandProps {
  /** The way to browse: chips for the kinds of thing, at the start. They scroll sideways when they do not fit. */
  start?: ReactNode;
  /** What narrows the list, and the page's actions: a scope, a search, a button, at the end. */
  end?: ReactNode;
  /** Its name for a screen reader, when the page has more than one band of controls: "Outputs". */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /** @deprecated Use `layout`. */
  style?: ToolbarBandLayoutStyle;
  /** Layout only: where it sits, and padding at the sides to line up with the page's header. */
  layout?: ToolbarBandLayoutStyle;
}

/** @deprecated Use `PageHeaderToolbar`, from `@/components/grasp/page-header`, as a PageHeader's `toolbar`. */
export const ToolbarBand = ({
  start,
  end,
  label: labelDeprecated,
  "aria-label": label = labelDeprecated,
  style: styleProp,
  layout,
}: ToolbarBandProps) => (
  <PageHeaderToolbar
    start={start}
    end={end}
    aria-label={label}
    layout={layout ?? styleProp}
  />
);
