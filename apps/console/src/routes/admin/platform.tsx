import { createFileRoute } from "@tanstack/react-router";

import { AdminPage } from "../../admin/page.tsx";

/** Every company's own deployment, and the rollout. Only its title until it is ported. */
export const Route = createFileRoute("/admin/platform")({
  component: () => <AdminPage title="Platform" />,
});
