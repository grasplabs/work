import type {
  ModelMonthSpend,
  WorkflowMonthSpend,
} from "@grasp-os/shared/models";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";

import { dollars } from "../settings/money.ts";
import { costPerRun, spendShown } from "./spend.ts";
import { useFull, WidgetBlock } from "./widget-block.tsx";

// The AI spend widget of the dashboard's board, for admins: what the
// models cost this month, budget or not, and the workflows that spent
// most, each with what one run of it cost. Settings → AI spend has the
// rest: budgets, each binding and the reservations held for review.

/** A workflow that spent this month: its name, which opens it, its engine, and what a run cost. */
const SpendLine = ({ workflow }: { workflow: WorkflowMonthSpend }) => {
  const { t } = useLingui();
  const name = workflow.workflowId;
  const domain = workflow.appName ?? workflow.appId;
  const perRun = costPerRun(workflow);
  const amount = dollars(workflow.amount);
  const each = perRun === null ? null : dollars(perRun);
  return (
    <li className="flex items-baseline gap-3 border-t py-2">
      <span className="flex min-w-0 flex-1 flex-col">
        {workflow.appName === null ? (
          <span className="truncate">{name}</span>
        ) : (
          <Link
            className="truncate hover:underline"
            params={{ app: workflow.appId, workflow: name }}
            to="/workflows/$app/$workflow"
          >
            {name}
          </Link>
        )}
        <span className="text-muted-foreground truncate text-xs">{domain}</span>
      </span>
      <span className="flex flex-none flex-col items-end">
        <span className="tabular-nums">
          {each === null ? amount : t`${each} a run`}
        </span>
        {each === null ? null : (
          <span className="text-muted-foreground text-xs tabular-nums">
            <Trans>{amount} in all</Trans>
          </span>
        )}
      </span>
    </li>
  );
};

/** The month's total, then the workflows that spent most: a few in the block, all core sent in full. */
const SpendView = ({ spend }: { spend: ModelMonthSpend }) => {
  const { t } = useLingui();
  const full = useFull();
  const total = dollars(spend.total);
  const shown = full ? spend.workflows : spend.workflows.slice(0, spendShown);
  return (
    <>
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-2xl font-medium tabular-nums">{total}</span>
        <span className="text-muted-foreground text-xs">
          <Trans>for every model call this month</Trans>
        </span>
      </p>
      {shown.length === 0 ? (
        <p className="text-muted-foreground">
          <Trans>No workflow has called a model this month.</Trans>
        </p>
      ) : (
        <ul aria-label={t`Workflows that spent most`}>
          {shown.map((workflow) => (
            <SpendLine
              key={JSON.stringify([workflow.appId, workflow.workflowId])}
              workflow={workflow}
            />
          ))}
        </ul>
      )}
      <Link
        className="text-muted-foreground hover:text-foreground mt-auto flex items-center gap-1"
        to="/settings/spend"
      >
        <Trans>AI spend in Settings</Trans>
        <ChevronRightIcon aria-hidden="true" className="size-4" />
      </Link>
    </>
  );
};

/** The AI spend widget, titled `title`: in full, every workflow core listed. */
export const SpendWidget = ({
  spend,
  title,
}: {
  spend: ModelMonthSpend;
  title: string;
}) => (
  <WidgetBlock
    full={
      spend.workflows.length > spendShown ? (
        <SpendView spend={spend} />
      ) : undefined
    }
    title={title}
  >
    <SpendView spend={spend} />
  </WidgetBlock>
);
