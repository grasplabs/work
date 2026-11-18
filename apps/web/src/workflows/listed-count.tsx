import {
  workflowOwnListed,
  workflowRunsListed,
} from "@grasp-os/shared/workflow-resources";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

import { formatNumber } from "../format.ts";
import { Badge } from "../grasp/badge/index.ts";

// How many runs, or activity entries, a workflow has, beside the name of
// the tab or part that lists them. Core answers the newest only, up to a
// cap: at the cap there may be more, so it says "50+".

/** What is counted, and the most core answers of it. */
const caps = { runs: workflowRunsListed, activity: workflowOwnListed } as const;

export const ListedCount = ({
  of,
  count,
  more,
}: {
  of: keyof typeof caps;
  /** How many core answered; nothing shows before any. */
  count: number | undefined;
  /** Whether core said it had more, where it says so; else, at the cap. */
  more?: boolean;
}) => {
  const { t } = useLingui();
  if (count === undefined || count === 0) {
    return null;
  }
  const capped = more ?? count >= caps[of];
  const shown = formatNumber(count);
  const runs = capped
    ? t`${shown} runs or more`
    : t`${plural(count, { one: "# run", other: "# runs" })}`;
  const entries = capped
    ? t`${shown} entries or more`
    : t`${plural(count, { one: "# entry", other: "# entries" })}`;
  return (
    // A quiet count beside the tab's name, said in words to a screen reader.
    <Badge aria-label={of === "runs" ? runs : entries} size="sm">
      {capped ? `${shown}+` : shown}
    </Badge>
  );
};
