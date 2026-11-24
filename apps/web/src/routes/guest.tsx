import { Button } from "@grasp-os/app-kit/components/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/app-kit/components/item";
import { PageHeaderTitle } from "@grasp-os/app-kit/components/page-header";
import { Trans } from "@lingui/react/macro";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";

import { shellStatus, signOut } from "../core-connection.ts";
import { OnboardingFrame } from "../frame/onboarding-frame.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";

// Where a guest lands (GRA-2235): someone from outside the company, who
// reaches only the Apps shared with them (core's guest-access.ts). A plain
// list of those Apps, each opened full page (apps.$app.full.tsx), and a
// way to sign out: nothing of the platform is shown or reachable from
// here, and core refuses a guest everything else anyway.

const GuestHome = () => {
  const { core } = Route.useRouteContext();
  const apps = Route.useLoaderData();
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
        <Trans>Apps shared with you</Trans>
      </PageHeaderTitle>
      {apps.state !== "ready" && <NotLoaded page={apps} />}
      {apps.state === "ready" && apps.data.length === 0 && (
        <p className="text-muted-foreground">
          <Trans>Nothing is shared with you yet.</Trans>
        </p>
      )}
      {apps.state === "ready" && apps.data.length > 0 && (
        <ItemGroup render={<ul />}>
          {apps.data.map(({ app, name, description }) => (
            <li key={app}>
              {/* Full page, outside the shell, as "Open full page" links it. */}
              <Item render={<a aria-label={name} href={`/apps/${app}/full`} />}>
                <ItemContent>
                  <ItemTitle>{name}</ItemTitle>
                  {description === "" ? null : (
                    <ItemDescription>{description}</ItemDescription>
                  )}
                </ItemContent>
              </Item>
            </li>
          ))}
        </ItemGroup>
      )}
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

export const Route = createFileRoute("/guest")({
  // Only for a guest: anyone else goes where they would anyway.
  beforeLoad: async ({ context: { core } }) => {
    const { identity } = await shellStatus(core);
    if (identity?.guest !== true) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/", replace: true });
    }
  },
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await session.pages.opensApps()
    ),
  component: GuestHome,
});
