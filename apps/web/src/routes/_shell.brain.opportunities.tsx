import { isMemberAdmin } from "@grasp-os/shared/roles";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { OpportunitiesPage } from "../brain/opportunities-page.tsx";

// Brain › Opportunities: what Grasp could automate or improve, from how the
// company's teams describe their work, for admins (GRA-1750).

export const Route = createFileRoute("/_shell/brain/opportunities")({
  // Only the organization's admins: anyone else who follows a link here
  // goes to the Brain. Core refuses them all the same; this only spares
  // them a refusal.
  beforeLoad: ({ context: { identity } }) => {
    if (!isMemberAdmin(identity)) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/brain", replace: true });
    }
  },
  component: OpportunitiesPage,
});
