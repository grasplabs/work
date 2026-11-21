/* oxlint-disable typescript/no-deprecated -- the breaking release's step 3: Severity stays a wrapper over Badge's dot until step 9 removes it (handover/audit/RELEASE.md §7). */
import type { ReactNode } from "react";

import { Badge } from "../badge";
import type { BadgeLayoutStyle, BadgeTone } from "../badge";

/** @deprecated Use `Badge` with `variant="dot"` and its `tone` (error → danger, warning → attention, info → info). */
export type SeverityLevel = "error" | "warning" | "info";

/** @deprecated Use `BadgeLayoutStyle`. */
export type SeverityLayoutStyle = BadgeLayoutStyle;

/** @deprecated Use `BadgeProps`, with `variant="dot"`. */
export interface SeverityProps {
  /** How serious: `error` stops something, `warning` needs a look, `info` is only to know. */
  level: SeverityLevel;
  /** The words beside the dot: what happened, or how many ("3 errors"). Leave them out for the dot alone. */
  children?: ReactNode;
  /**
   * The dot's name when it stands alone, in the page's language. With words it is not said.
   * @default "Error", "Warning" or "Info"
   */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /** @deprecated Use `layout`. */
  style?: SeverityLayoutStyle;
  /** Layout only: where it sits. */
  layout?: SeverityLayoutStyle;
}

const tones: Record<SeverityLevel, BadgeTone> = {
  error: "danger",
  warning: "attention",
  info: "info",
};

/** @deprecated Use `Badge` with `variant="dot"`: `<Badge variant="dot" tone="danger">3 errors</Badge>`. */
export const Severity = ({
  level,
  children,
  label,
  "aria-label": named = label,
  style,
  layout = style,
}: SeverityProps) => (
  <Badge variant="dot" tone={tones[level]} aria-label={named} layout={layout}>
    {children}
  </Badge>
);
