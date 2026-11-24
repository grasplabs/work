import { useLingui } from "@lingui/react/macro";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { AgentFigure } from "../agents/figure/agent-figure.tsx";
import { stephensLook } from "../agents/figure/look.ts";
import { shellStatus } from "../core-connection.ts";
import { heldWhileOnboarding, onboardingIsBehind } from "../landing.ts";
import { CalmFrame, CalmStep } from "../onboarding/calm-frame.tsx";

// Where a member waits while their company's admins set Grasp up
// (landing.ts), in the setup's calm frame: nothing of the platform opens
// until the onboarding is behind the company, and nothing here is theirs
// to do. The page looks again by itself, and takes them in once it is
// ready; the frame's way out signs them out.

/** How often the page asks whether the onboarding is behind the company. */
const lookAgainMs = 30_000;

const WaitingPage = () => {
  const { t } = useLingui();
  const router = useRouter();
  useEffect(() => {
    // The route's own check runs again, and sends them on once it may.
    const id = window.setInterval(() => {
      void router.invalidate();
    }, lookAgainMs);
    return () => {
      window.clearInterval(id);
    };
  }, [router]);
  return (
    <CalmFrame centred>
      <CalmStep
        figure={<AgentFigure look={stephensLook} size="xl" state="asleep" />}
        body={t`Your admins are setting up Grasp. This page opens it for you once they’re done.`}
        title={t`I’m almost ready for you`}
      />
    </CalmFrame>
  );
};

export const Route = createFileRoute("/waiting")({
  // Only for someone held here: anyone else goes where they would anyway.
  beforeLoad: async ({ context: { core } }) => {
    const { identity } = await shellStatus(core);
    const held =
      identity === undefined || identity.staff || identity.guest === true
        ? null
        : heldWhileOnboarding({
            path: "/waiting",
            identity,
            behind: await onboardingIsBehind(core),
          });
    if (held !== "/waiting") {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: held ?? "/", replace: true });
    }
  },
  component: WaitingPage,
});
