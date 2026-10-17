import { createFileRoute } from "@tanstack/react-router";

import { SectionToCome } from "../../../../admin/organization.tsx";

/** An organization's AI use: its title and where it comes from, until its content is ported. */
export const Route = createFileRoute("/admin/organizations/$clientId/ai-use")({
  component: SectionToCome,
});
