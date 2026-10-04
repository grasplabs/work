import { createFileRoute, redirect } from "@tanstack/react-router";

import { logSearchOf } from "../activity/audit-log.tsx";

// Activity moved into Settings: its log is the audit trail, and its
// pending approvals a section of their own. An old link still leads there.
export const Route = createFileRoute("/_shell/activity")({
  beforeLoad: ({ search }) => {
    // SAFETY: the route validates no search of its own, so the router hands
    // over the address's search as parsed, a plain record.
    const { tab, ...filters } = search as Record<string, unknown>;
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw tab === "pending"
      ? redirect({ to: "/settings/approvals", replace: true })
      : redirect({
          to: "/settings/audit",
          search: logSearchOf(filters),
          replace: true,
        });
  },
});
