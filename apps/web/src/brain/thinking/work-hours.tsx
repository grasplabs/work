import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { grasp } from "../../grasp/tokens/tokens.stylex.ts";
import { roundHours } from "./hours.ts";

// A workflow's hours a week, as the dive (dive.tsx) and an answer's card
// (chat/thinking-card.tsx) say them under its name: its own module, so the
// card never loads the dive for it. The words alone, for SVG text, which
// paints no HTML element inside it, and in a span for the dive's HTML.

const styles = stylex.create({
  // Quieter than the name over it, in its size; the figures line up from one name to the next.
  hours: {
    color: grasp.muted,
    fontWeight: grasp.weightRegular,
    fontVariantNumeric: "tabular-nums",
  },
});

/** A workflow's hours a week, as the brain counts them; or that they are not known yet. */
export const useWorkHoursText = (hours: number | null): string => {
  const { t } = useLingui();
  const each = hours === null ? 0 : roundHours(hours);
  return hours === null
    ? t`Hours not known yet`
    : t`${plural(each, { one: "# hour a week", other: "# hours a week" })}`;
};

/** A workflow's hours a week under its name, in HTML. */
export const WorkHours = ({ hours }: { hours: number | null }) => (
  <span {...stylex.props(styles.hours)}>{useWorkHoursText(hours)}</span>
);
