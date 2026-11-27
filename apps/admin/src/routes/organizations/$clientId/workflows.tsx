import {
  Section as Part,
  SectionHeader,
} from "@grasp-os/ui/components/section-header";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute } from "@tanstack/react-router";

import { WaitingOnConnectionsRows } from "../../../admin/connections.tsx";
import { useOrganization } from "../../../admin/organization.tsx";
import { OrgWorkflows } from "../../../admin/workflows.tsx";

const styles = stylex.create({
  // The page's parts, a step further apart than the lines within each.
  parts: { display: "flex", flexDirection: "column", gap: space["10"] },
});

/**
 * An organization's Workflows: how far each piece of work is known, and
 * what it still lacks; then, once core reports it, the workflows the
 * company built that wait on a connection.
 */
const Workflows = () => {
  const { view, admin } = useOrganization();
  const { integrations } = admin.snapshot;
  return (
    <div {...stylex.props(styles.parts)}>
      <OrgWorkflows clientId={admin.client.id} view={view} />
      {integrations === null ? null : (
        <Part aria-labelledby="waiting">
          <SectionHeader
            description="Workflows that can’t run as they are: an app they work in isn’t connected, stopped, or has no connection approved for it yet."
            id="waiting"
            title="Waiting on a connection"
            variant="group"
          />
          <WaitingOnConnectionsRows integrations={integrations} />
        </Part>
      )}
    </div>
  );
};

export const Route = createFileRoute("/organizations/$clientId/workflows")({
  component: Workflows,
});
