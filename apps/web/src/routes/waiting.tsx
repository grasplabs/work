import { Button } from "@grasp-os/ui/components/button";
import { PageHeaderTitle } from "@grasp-os/ui/components/page-header";
import { Trans } from "@lingui/react/macro";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { shellStatus, signOut } from "../core-connection.ts";
import { OnboardingFrame } from "../frame/onboarding-frame.tsx";
import { heldWhileOnboarding, onboardingIsBehind } from "../landing.ts";

// Where a member waits while their company's admins set Grasp up
// (landing.ts): nothing of the platform opens until the onboarding is
// behind the company, and nothing here is theirs to do. The page looks
// again by itself, and takes them in once it is ready.

/** How often the page asks whether the onboarding is behind the company. */
const lookAgainMs = 30_000;

const WaitingPage = () => {
  const { core } = Route.useRouteContext();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // The route's own check runs again, and sends them on once it may.
    const id = window.setInterval(() => {
      void router.invalidate();
    }, lookAgainMs);
    return () => {
      window.clearInterval(id);
    };
  }, [router]);
  const leave = async (): Promise<void> => {
    setBusy(true);
    try {
      // Signed out, the page loads again (`onSessionEnded`).
      await signOut(core);
    } catch {
      // Still signed in: the button can be pressed again.
      setBusy(false);
    }
  };
  return (
    <OnboardingFrame>
      <PageHeaderTitle>
        <Trans>Grasp is almost ready for you</Trans>
      </PageHeaderTitle>
      <p className="text-muted-foreground text-balance">
        <Trans>
          Your company’s admins are still setting Grasp up. There is nothing you
          need to do: this page opens Grasp for you as soon as they have
          finished.
        </Trans>
      </p>
      <Button
        disabled={busy}
        onClick={() => {
          void leave();
        }}
        variant="outline"
      >
        <Trans>Sign out</Trans>
      </Button>
    </OnboardingFrame>
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
