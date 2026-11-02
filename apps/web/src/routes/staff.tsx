import { Button } from "@grasp-os/ui/components/button";
import { PageHeaderTitle } from "@grasp-os/ui/components/page-header";
import { Trans } from "@lingui/react/macro";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";

import { shellStatus, signOut } from "../core-connection.ts";
import { OnboardingFrame } from "../frame/onboarding-frame.tsx";

// Where a Grasp staff sign-in lands: staff steer a company's Grasp from
// Grasp's admin dashboard, never from inside it, so there is nothing for
// them here. To act in this workspace, they are added to it as a user.

const StaffPage = () => {
  const { core } = Route.useRouteContext();
  const [busy, setBusy] = useState(false);
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
        <Trans>Grasp staff work from the admin dashboard</Trans>
      </PageHeaderTitle>
      <p className="text-muted-foreground">
        <Trans>
          To act in this workspace, ask its admin to add you as a user, and sign
          in as one.
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

export const Route = createFileRoute("/staff")({
  // Only for a staff sign-in: anyone else goes where they would anyway.
  beforeLoad: async ({ context: { core } }) => {
    const { identity } = await shellStatus(core);
    if (identity?.staff !== true) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/", replace: true });
    }
  },
  component: StaffPage,
});
