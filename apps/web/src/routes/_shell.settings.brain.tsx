import { createFileRoute, redirect } from "@tanstack/react-router";

// Settings › Brain is gone: the brain's regions are arranged by Grasp and
// changed by an admin right on the Brain's map (brain/region-edit.tsx). An
// old link to it goes there.

export const Route = createFileRoute("/_shell/settings/brain")({
  beforeLoad: () => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({ to: "/brain", replace: true });
  },
});
