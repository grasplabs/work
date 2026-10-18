import { createFileRoute } from "@tanstack/react-router";

import { SectionToCome } from "../../../../admin/organization.tsx";

/** An organization's Hours: its title and where it comes from, until its content is ported. */
export const Route = createFileRoute("/admin/organizations/$clientId/hours")({
  component: SectionToCome,
});
