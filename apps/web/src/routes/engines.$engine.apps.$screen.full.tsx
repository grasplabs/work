import { createFileRoute, redirect } from "@tanstack/react-router";

// An engine's app on a page of its own is now a Domain's: an old link
// still leads to it.
export const Route = createFileRoute("/engines/$engine/apps/$screen/full")({
  beforeLoad: ({ params }) => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({
      to: "/domains/$engine/apps/$screen/full",
      params: { engine: params.engine, screen: params.screen },
      replace: true,
    });
  },
});
