import { createFileRoute } from "@tanstack/react-router";

import { AdminPage } from "../../admin/page.tsx";

/** The systems the admin's numbers come from. Only its title until it is ported. */
export const Route = createFileRoute("/admin/sources")({
  component: () => <AdminPage title="Sources" />,
});
