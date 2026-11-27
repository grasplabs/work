import { createFileRoute } from "@tanstack/react-router";

import { Connectors } from "../../../admin/connectors.tsx";

/**
 * An organization's Connectors: how its connections stand, what the
 * company connected, its people's own counted by app, and what is still
 * to connect (src/admin/connectors.tsx).
 */
export const Route = createFileRoute("/organizations/$clientId/connectors")({
  component: Connectors,
});
