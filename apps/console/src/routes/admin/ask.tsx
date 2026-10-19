import { createFileRoute } from "@tanstack/react-router";

import { AdminPage } from "../../admin/page.tsx";

/** The chat over every organization. Only its title until it is ported. */
export const Route = createFileRoute("/admin/ask")({
  component: () => <AdminPage title="Ask Grasp" />,
});
