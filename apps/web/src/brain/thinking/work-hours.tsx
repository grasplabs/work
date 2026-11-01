import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

import { roundHours } from "./hours.ts";

// A workflow's hours a week, as the dive (dive.tsx) and an answer's card
// (chat/thinking-card.tsx) say them under its name: its own module, so the
// card never loads the dive for it. The words alone, for SVG text, which
// paints no HTML element inside it, and in a span for the dive's HTML.

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
  <span className="text-muted-foreground font-normal tabular-nums">
    {useWorkHoursText(hours)}
  </span>
);
