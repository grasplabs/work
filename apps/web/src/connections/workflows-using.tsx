import type { ConnectionWorkflow } from "@grasp-os/shared/workflows";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, WorkflowIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";

// Which workflows use an app, as the prototype shows them: "Used by N
// workflows" on its row in Integrations, opening the list of them
// (`components/integration-row.tsx`), and its page's Workflows tab
// (`routes/integrations/$integrationId.tsx`). Each opens the workflow's
// page: an App's under its App, an independent one by its ID.

/** A workflow's name, opening its page; `className` for where it sits. */
const WorkflowLink = ({
  workflow,
  className,
  children,
}: {
  workflow: ConnectionWorkflow;
  className: string;
  children: ReactNode;
}) =>
  workflow.kind === "app" ? (
    <Link
      className={className}
      params={{ app: workflow.app, workflow: workflow.workflow }}
      to="/workflows/$app/$workflow"
    >
      {children}
    </Link>
  ) : (
    <Link
      className={className}
      params={{ workflow: workflow.id }}
      to="/workflows/$workflow"
    >
      {children}
    </Link>
  );

/** What a workflow is called: an App's by its name in the App's code. */
const nameOf = (workflow: ConnectionWorkflow): string =>
  workflow.kind === "app" ? workflow.workflow : workflow.name;

/** "Used by 2 workflows", as the row's count and its list say it. */
const useUsedByLabel = (count: number): string => {
  const { t } = useLingui();
  return t`${plural(count, { one: "Used by # workflow", other: "Used by # workflows" })}`;
};

/**
 * How many workflows use the app, on its row: a count that opens the list
 * of them, each opening its workflow. Nothing while none does.
 */
export const UsedBy = ({
  workflows,
}: {
  workflows: readonly ConnectionWorkflow[];
}) => {
  const label = useUsedByLabel(workflows.length);
  if (workflows.length === 0) {
    return null;
  }
  return (
    <>
      <span aria-hidden="true">·</span>
      <Popover>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <button
                    aria-label={label}
                    className="hover:text-foreground focus-visible:ring-ring/50 inline-flex flex-none items-center gap-1 rounded-sm tabular-nums outline-none focus-visible:ring-3"
                    type="button"
                  />
                }
              />
            }
          >
            <WorkflowIcon aria-hidden="true" className="size-3.5" />
            {workflows.length}
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
        <PopoverContent align="start" variant="flush">
          <div className="flex flex-col gap-1 p-2">
            <p className="text-muted-foreground px-2 py-1">{label}</p>
            <ul className="flex flex-col">
              {workflows.map((workflow) => (
                <li key={JSON.stringify(workflow)}>
                  <WorkflowLink
                    className="hover:bg-accent focus-visible:bg-accent flex flex-col gap-0.5 rounded-md px-2 py-1.5 outline-none"
                    workflow={workflow}
                  >
                    <span className="truncate">{nameOf(workflow)}</span>
                    {workflow.kind === "app" ? (
                      <span className="text-muted-foreground truncate text-xs">
                        {workflow.appName}
                      </span>
                    ) : null}
                  </WorkflowLink>
                </li>
              ))}
            </ul>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
};

/**
 * The workflows that use the app, on its page's Workflows tab: each opens
 * its workflow, with its App beside it where it has one; or that none does
 * yet, or why that can't be read.
 */
export const WorkflowsUsing = ({
  uses,
  workflows,
  app,
}: {
  uses: Loaded<unknown>;
  workflows: readonly ConnectionWorkflow[];
  app: string;
}) => {
  const { i18n } = useLingui();
  if (uses.state !== "ready") {
    return <ErrorText>{notLoadedText(uses, i18n)}</ErrorText>;
  }
  if (workflows.length === 0) {
    return (
      <p className="text-muted-foreground">
        <Trans>No workflow uses {app} yet.</Trans>
      </p>
    );
  }
  return (
    <ul className="bg-card flex flex-col overflow-hidden rounded-xl border">
      {workflows.map((workflow) => (
        <li
          className="hover:bg-accent relative flex items-center gap-4 border-b px-4 py-3 last:border-b-0"
          key={JSON.stringify(workflow)}
        >
          <WorkflowLink
            className="min-w-0 flex-1 truncate outline-none after:absolute after:inset-0 focus-visible:underline"
            workflow={workflow}
          >
            {nameOf(workflow)}
          </WorkflowLink>
          {workflow.kind === "app" ? (
            <span className="text-muted-foreground truncate">
              {workflow.appName}
            </span>
          ) : null}
          <ChevronRightIcon
            aria-hidden="true"
            className="text-muted-foreground size-4 flex-none"
          />
        </li>
      ))}
    </ul>
  );
};
