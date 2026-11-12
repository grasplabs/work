import { firstAgentId } from "@grasp-os/shared/agents";
import { createFileRoute, redirect } from "@tanstack/react-router";

// Settings › Stephen moved to the first agent's own page, on its Access
// tab (agents/agent-page.tsx): who reaches the company's first agent in
// each chat app, what it may do in each app and the workflows people
// start by asking it. The old address still leads there, for links made
// before.

export const Route = createFileRoute("/_shell/settings/stephen")({
  beforeLoad: () => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({
      to: "/agents/$agent",
      params: { agent: firstAgentId },
      search: { tab: "access" },
      replace: true,
    });
  },
});
