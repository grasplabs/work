import { createFileRoute, redirect } from "@tanstack/react-router";

// Connections became Integrations. An old link still leads there, and so
// does core's callback after a flow that failed, with its
// `connectionError` (core sends that to `/connections`).
export const Route = createFileRoute("/_shell/connections")({
  beforeLoad: ({ search }) => {
    // SAFETY: the route validates no search of its own, so the router hands
    // over the address's search as parsed, a plain record.
    const { connectionError } = search as Record<string, unknown>;
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({
      to: "/integrations",
      search: typeof connectionError === "string" ? { connectionError } : {},
      replace: true,
    });
  },
});
