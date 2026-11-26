import { createFileRoute, redirect } from "@tanstack/react-router";

import { loadFromCore } from "../load-from-core.tsx";

// Settings, Onboarding, as it was: Settings no longer lists the
// onboarding's interviews. While they run, from the moment who works where
// is in until Grasp opens the gate, an old link here leads to the
// onboarding's own screen for where they stand (`/setup`): telling the
// team while no plan is in, and after that the page the admin watches the
// interviews on (onboarding/campaign/campaign-page.tsx). Once they are
// over, or for anyone they aren't for, to the inbox. The reference sends
// to the inbox's Interviews item, which the inbox here doesn't have.

export const Route = createFileRoute("/_shell/settings/onboarding")({
  loader: async ({ context: { core } }) => {
    const read = await loadFromCore(core, async (session) => {
      const [view, programme] = await Promise.all([
        session.onboarding.view(),
        session.onboarding.programme(),
      ]);
      return { view, stage: programme?.stage ?? null };
    });
    const running =
      read.state === "ready" &&
      read.data.stage !== "open" &&
      (read.data.view.plan !== null || read.data.view.roster !== null);
    if (running) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({
        to: "/setup",
        search: { step: read.data.view.plan === null ? "team" : "listening" },
        replace: true,
      });
    }
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({ to: "/inbox", replace: true });
  },
});
