import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

import { roundHours } from "./hours.ts";

// A workflow's hours a week, as the dive (dive.tsx) and an answer's card
// (chat/thinking-card.tsx) say them under its name: its own module, so the
// card never loads the dive for it.

/** A workflow's hours a week under its name, as the brain counts them; or that they are not known yet. */
export const WorkHours = ({ hours }: { hours: number | null }) => {
  const { t } = useLingui();
  const each = hours === null ? 0 : roundHours(hours);
  return (
    <span className="text-muted-foreground font-normal tabular-nums">
      {hours === null
        ? t`Hours not known yet`
        : t`${plural(each, { one: "# hour a week", other: "# hours a week" })}`}
    </span>
  );
};
