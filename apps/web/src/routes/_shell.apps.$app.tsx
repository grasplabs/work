import { createFileRoute, redirect } from "@tanstack/react-router";

// An App is now an engine: an old link, from a chat message or mail, still
// leads to it.
export const Route = createFileRoute("/_shell/apps/$app")({
  beforeLoad: ({ params }) => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({
      to: "/engines/$engine",
      params: { engine: params.app },
      replace: true,
    });
  },
});
