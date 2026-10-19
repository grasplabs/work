import { createFileRoute, redirect } from "@tanstack/react-router";

// An app's page opens on its Overview, as in the prototype.
export const Route = createFileRoute("/_shell/landscape/$appId/")({
  beforeLoad: ({ params }) => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({
      to: "/landscape/$appId/overview",
      params,
      replace: true,
    });
  },
});
