import { createFileRoute } from "@tanstack/react-router";

import { SectionToCome } from "../../../../admin/organization.tsx";

/** An organization's Data: its title and where it comes from, until its content is ported. */
export const Route = createFileRoute("/admin/organizations/$clientId/data")({
  component: SectionToCome,
});
