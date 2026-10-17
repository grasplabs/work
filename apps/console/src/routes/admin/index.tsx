import { createFileRoute } from "@tanstack/react-router";

import { AdminPage } from "../../admin/page.tsx";

/** The admin's overview: every organization together. Only its title until the overview is ported. */
export const Route = createFileRoute("/admin/")({
  component: () => <AdminPage overview title="Overview" />,
});
