import { workflowLabel } from "@grasp-os/shared/workflow-resources";
import type {
  ConnectionWorkflow,
  ConnectionWorkflows,
} from "@grasp-os/shared/workflows";
import { Button } from "@grasp-os/ui/components/button";
import {
  Item,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import { Icon, WorkflowIcon } from "@grasp-os/ui/lib/icons";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Await, Link } from "@tanstack/react-router";

import { formatNumber } from "../format.ts";
import type { Loaded } from "../load-from-core.tsx";
import type { Integration } from "./integrations.ts";
import { workflowsOf } from "./integrations.ts";

// Which workflows use an app, as the prototype shows them: "Used by N
// workflows" on its row (`components/integration-row.tsx`), opening the
// list of them, each opening the workflow's page. They come from a read
// of their own, which the rest of the page never waits on.

/** Which workflows use each connection, as the page reads it. */
export type ConnectionUses = Promise<Loaded<ConnectionWorkflows[]>>;

/** The workflows that use `integration`, of what was read: none if nothing was. */
const usingOf = (
  integration: Integration,
  loaded: Loaded<ConnectionWorkflows[]>
): ConnectionWorkflow[] =>
  workflowsOf(integration, loaded.state === "ready" ? loaded.data : []);

/** A workflow as a row that opens its page. */
const WorkflowItem = ({ workflow }: { workflow: ConnectionWorkflow }) => (
  <Item asChild size="xs">
    <Link params={{ workflow: workflow.id }} to="/workflows/$workflow">
      <ItemMedia>
        <Icon icon={WorkflowIcon} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{workflowLabel(workflow)}</ItemTitle>
      </ItemContent>
    </Link>
  </Item>
);

/** "Used by 2 workflows", as the row's count and its list say it. */
const useUsedByLabel = (count: number): string => {
  const { t } = useLingui();
  return t`${plural(count, { one: "Used by # workflow", other: "Used by # workflows" })}`;
};

/**
 * How many workflows use the app, on its row: a count that opens the list
 * of them, each opening its workflow. Nothing while none does.
 */
const UsedByCount = ({
  workflows,
}: {
  workflows: readonly ConnectionWorkflow[];
}) => {
  const label = useUsedByLabel(workflows.length);
  if (workflows.length === 0) {
    return null;
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button aria-label={label} size="xs" variant="ghost">
          <Icon icon={WorkflowIcon} />
          {formatNumber(workflows.length)}
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <PopoverTitle>{label}</PopoverTitle>
        <ItemGroup aria-label={label}>
          {workflows.map((workflow) => (
            <WorkflowItem key={workflow.id} workflow={workflow} />
          ))}
        </ItemGroup>
      </PopoverContent>
    </Popover>
  );
};

/** `UsedByCount` once the workflows are read: nothing before, or if they can't be. */
export const UsedBy = ({
  integration,
  uses,
}: {
  integration: Integration;
  uses: ConnectionUses;
}) => (
  <Await fallback={null} promise={uses}>
    {(loaded) => <UsedByCount workflows={usingOf(integration, loaded)} />}
  </Await>
);
