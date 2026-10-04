import { createFileRoute } from "@tanstack/react-router";

import { NotFound } from "../frame/page-states.tsx";

// Any address no page has, for someone signed in: not found, in the frame,
// with the sidebar beside it to go on from.
export const Route = createFileRoute("/_shell/$")({
  component: () => <NotFound />,
});
