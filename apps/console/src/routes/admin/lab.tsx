import { createFileRoute } from "@tanstack/react-router";

import { AdminPage } from "../../admin/page.tsx";

/** Grasp's own tool for measuring Stephen. Only its title until it is ported. */
export const Route = createFileRoute("/admin/lab")({
  component: () => <AdminPage title="Stephen Lab" />,
});
