import { runActivityDefaultDays } from "@grasp-os/shared/workflows";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { formatNumber, formatPercent } from "../format.ts";
import { StatsGrid } from "../grasp/stats/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { RunFigures } from "./run-figures.ts";

// The figures over the runs, as the library's Stats: what each is over its
// figure. Those waiting are marked as needing someone while any do. A dash
// where there is nothing to divide. Core counts no AI cost of runs yet, so
// that figure of the prototype is left out.

/** Which runs the figures count: every workflow's, or one's. */
type Scope = "all" | "workflow";

const styles = stylex.create({
  figures: { display: "grid", gap: grasp.space2 },
});

export const RunFiguresView = ({
  figures,
  scope,
}: {
  figures: RunFigures;
  scope: Scope;
}) => {
  const { t } = useLingui();
  const days = runActivityDefaultDays;
  const { runs, alone, waiting } = figures;
  return (
    <div {...stylex.props(styles.figures)}>
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
            title:
              scope === "all"
                ? t`without a person`
                : t`completed without a person`,
            value: alone === null ? "–" : formatPercent(alone),
          },
          {
            title:
              scope === "all"
                ? t`of them wait for a decision`
                : t`wait for a decision now`,
            value: formatNumber(waiting),
            ...(waiting > 0
              ? { change: t`Needs someone`, tone: "attention" as const }
              : {}),
          },
        ]}
      />
      {/* What core counts: the Apps' workflows, never independent ones. */}
      {scope === "all" ? (
        <Text size="sm" tone="muted">
          {t`Counted over the workflows of the Apps you can open; independent workflows aren't counted here.`}
        </Text>
      ) : null}
    </div>
  );
};
