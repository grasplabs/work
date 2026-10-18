import { createFileRoute } from "@tanstack/react-router";

import { AdminPage } from "../../admin/page.tsx";

/** The integrations Grasp builds into the platform itself. Only its title until it is ported. */
export const Route = createFileRoute("/admin/integrations")({
  component: () => <AdminPage title="Integrations to build" />,
});
