import { createFileRoute } from "@tanstack/react-router";

import { WaitingOnConnectionsRows } from "../../../../admin/connections.tsx";
import { useOrganization } from "../../../../admin/organization.tsx";
import { Panel } from "../../../../admin/panel.tsx";
import { OrgWorkflows } from "../../../../admin/workflows.tsx";

/**
 * An organization's Workflows: how far each piece of work is known, and
 * what it still lacks; then, once core reports it, the workflows the
 * company built that wait on a connection.
 */
const Workflows = () => {
  const { view, admin } = useOrganization();
  const { integrations } = admin.snapshot;
  return (
    <>
      <OrgWorkflows view={view} />
      {integrations === null ? null : (
        <Panel
          description="Workflows that can’t run as they are: an app they work in isn’t connected, stopped, or has no connection approved for it yet."
          title="Waiting on a connection"
        >
          <WaitingOnConnectionsRows integrations={integrations} />
        </Panel>
      )}
    </>
  );
};

export const Route = createFileRoute(
  "/admin/organizations/$clientId/workflows"
)({
  component: Workflows,
});
