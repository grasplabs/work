import { createFileRoute, redirect } from "@tanstack/react-router";

// Settings › Unknown outcomes, as it was: everyone's open calls of unknown
// outcome now stand in the inbox, as their own group, for the
// organization's own admins (inbox/everyones-outcomes.ts). An old link
// here leads to that group; for anyone else the inbox has none.

export const Route = createFileRoute("/_shell/settings/outcomes")({
  beforeLoad: () => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({
      to: "/inbox",
      search: { group: "outcomes" },
      replace: true,
    });
  },
});
