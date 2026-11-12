import { createFileRoute, redirect } from "@tanstack/react-router";

/** An organization's Members is a tab of its Details: the old address leads there. */
export const Route = createFileRoute("/organizations/$clientId/members")({
  beforeLoad: ({ params }) => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router's redirect is thrown, as it documents
    throw redirect({
      to: "/organizations/$clientId/details",
      params,
      search: { tab: "members" },
      replace: true,
    });
  },
});
