import { createFileRoute } from "@tanstack/react-router";

import { Hours } from "../../../../admin/hours.tsx";

/** An organization's hours: the hours in the work that is known, and what is freed of them. */
export const Route = createFileRoute("/admin/organizations/$clientId/hours")({
  component: Hours,
});
