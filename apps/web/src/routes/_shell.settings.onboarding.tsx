import { createFileRoute, redirect } from "@tanstack/react-router";

import { interviewsRunning } from "../inbox/items.ts";
import { loadFromCore } from "../load-from-core.tsx";

// Settings, Onboarding, as it was: the onboarding's interviews now stand
// in the inbox, as its pinned Interviews item, while they run. An old
// link here leads to that item, or to the inbox once they are over (or
// for anyone they aren't for). The onboarding itself is `/setup`.

export const Route = createFileRoute("/_shell/settings/onboarding")({
  loader: async ({ context: { core } }) => {
    const read = await loadFromCore(core, async (session) => {
      const [view, programme] = await Promise.all([
        session.onboarding.view(),
        session.onboarding.programme(),
      ]);
      return { view, stage: programme?.stage ?? null };
    });
    const running = read.state === "ready" && interviewsRunning(read.data);
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({
      to: "/inbox",
      search: running ? { item: "interviews" } : {},
      replace: true,
    });
  },
});
