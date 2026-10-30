import { runActivityDefaultDays } from "@grasp-os/shared/workflows";
import { Plural, Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";

import { formatNumber, formatPercent } from "../format.ts";
import type { RunFigures } from "./run-figures.ts";

// The figures over the runs, as the prototype draws them
// (`components/workflow-runs.tsx`): a large number over the words that say
// what it is; the share without a person in the colour of what passed,
// those waiting in the colour of what needs someone, while any do. A
// dash where there is nothing to divide. Core counts no AI cost of runs
// yet, so that figure of the prototype is left out.

/** Which runs the figures count: every workflow's, or one's. */
type Scope = "all" | "workflow";

/** A large number over what it is. */
const Figure = ({
  value,
  label,
  tone,
}: {
  value: string | null;
  label: ReactNode;
  tone: string;
}) => (
  <div className="flex min-w-0 flex-col-reverse gap-0.5">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className={value === null ? "type-figure" : `type-figure ${tone}`}>
      {value ?? "–"}
    </dd>
  </div>
);

export const RunFiguresView = ({
  figures,
  scope,
}: {
  figures: RunFigures;
  scope: Scope;
}) => {
  const days = runActivityDefaultDays;
  const { runs, alone, waiting } = figures;
  return (
    <div className="flex flex-col gap-2">
      <dl className="@container grid grid-cols-1 gap-x-8 gap-y-4 @xl:grid-cols-3">
        <Figure
          label={
            <Plural
              one="runs started today"
              other="runs started in the last # days"
              value={days}
            />
          }
          tone=""
          value={formatNumber(runs)}
        />
        <Figure
          label={
            scope === "all" ? (
              <Trans>without a person</Trans>
            ) : (
              <Trans>completed without a person</Trans>
            )
          }
          tone="text-status-agreed"
          value={alone === null ? null : formatPercent(alone)}
        />
        <Figure
          label={
            scope === "all" ? (
              <Trans>of them wait for a decision</Trans>
            ) : (
              <Trans>wait for a decision now</Trans>
            )
          }
          tone={waiting > 0 ? "text-status-attention" : ""}
          value={formatNumber(waiting)}
        />
      </dl>
      {/* What core counts: the domains' workflows, never independent ones. */}
      {scope === "all" ? (
        <p className="text-muted-foreground">
          <Trans>
            Counted over the workflows of the domains you can open; independent
            workflows aren&apos;t counted here.
          </Trans>
        </p>
      ) : null}
    </div>
  );
};
