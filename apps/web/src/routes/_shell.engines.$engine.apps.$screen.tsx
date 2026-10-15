import { createFileRoute, redirect } from "@tanstack/react-router";

// An engine's app is now a Domain's: an old link, from a chat message or
// mail, still leads to it.
export const Route = createFileRoute("/_shell/engines/$engine/apps/$screen")({
  beforeLoad: ({ params }) => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({
      to: "/domains/$engine/apps/$screen",
      params: { engine: params.engine, screen: params.screen },
      replace: true,
    });
  },
});
