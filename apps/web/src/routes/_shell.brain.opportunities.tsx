import { createFileRoute } from "@tanstack/react-router";

import { OpportunitiesPage } from "../brain/opportunities-page.tsx";

// Brain › Opportunities: what Grasp could automate or improve, from how the
// company's teams describe their work, for admins (GRA-1750).

export const Route = createFileRoute("/_shell/brain/opportunities")({
  component: OpportunitiesPage,
});
