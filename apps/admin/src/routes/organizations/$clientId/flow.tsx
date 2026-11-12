import { createFileRoute, redirect } from "@tanstack/react-router";

/** An organization's Flow is a tab of its Steps: its old address goes there. */
export const Route = createFileRoute("/organizations/$clientId/flow")({
  beforeLoad: ({ params }) => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router's redirect is thrown, as it documents
    throw redirect({
      to: "/organizations/$clientId/steps",
      params,
      search: { tab: "flow" },
    });
  },
});
