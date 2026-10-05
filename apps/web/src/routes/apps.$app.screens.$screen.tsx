import { createFileRoute, redirect } from "@tanstack/react-router";

// An App's screen is now an engine's app, shown in the Grasp frame: an old
// link, from a chat message or mail, still leads to it. Someone signed out
// signs in on the way.
export const Route = createFileRoute("/apps/$app/screens/$screen")({
  beforeLoad: ({ params }) => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({
      to: "/engines/$engine/apps/$screen",
      params: { engine: params.app, screen: params.screen },
      replace: true,
    });
  },
});
