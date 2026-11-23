import { runActivityDefaultDays } from "@grasp-os/shared/workflows";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

import { formatNumber, formatPercent } from "../format.ts";
import { StatsGrid } from "../grasp/stats/index.ts";
import type { RunFigures } from "./run-figures.ts";

// The figures over every workflow's runs, as the library's Stats: what
// each is over its figure. Those waiting are marked as needing someone
// while any do. A dash where there is nothing to divide. A run that asked
// no one for a decision ran without asking anyone, whoever started it.
// Core counts no AI cost of runs yet, so that figure of the prototype is
// left out.

export const RunFiguresView = ({ figures }: { figures: RunFigures }) => {
  const { t } = useLingui();
  const days = runActivityDefaultDays;
  const { runs, alone, waiting } = figures;
  return (
    <StatsGrid
      aria-label={t`The runs, in figures`}
      columns={3}
      items={[
        {
          title: t`${plural(days, {
            one: "runs started today",
            other: "runs started in the last # days",
          })}`,
          value: formatNumber(runs),
        },
        {
          title: t`ran without asking anyone`,
          value: alone === null ? "–" : formatPercent(alone),
        },
        {
          title: t`of them wait for a decision`,
          value: formatNumber(waiting),
          ...(waiting > 0
            ? { change: t`Needs someone`, tone: "attention" as const }
            : {}),
        },
      ]}
    />
  );
};
