import { createFileRoute, redirect } from "@tanstack/react-router";

/** An organization's Data is a tab of its Brain now: its old address leads there. */
export const Route = createFileRoute("/organizations/$clientId/data")({
  beforeLoad: ({ params }) => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({
      to: "/organizations/$clientId/brain",
      params,
      search: { tab: "data" },
      replace: true,
    });
  },
});
