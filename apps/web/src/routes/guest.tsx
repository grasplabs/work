import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";

import { shellStatus, signOut } from "../core-connection.ts";
import { OnboardingFrame } from "../frame/onboarding-frame.tsx";
import { NotLoadedState } from "../frame/page-states.tsx";
import { Button } from "../grasp/button/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../grasp/item/index.ts";
import { Text } from "../grasp/text/index.ts";
import { loadFromCore } from "../load-from-core.tsx";

// Where a guest lands (GRA-2235): someone from outside the company, who
// reaches only the Apps shared with them (core's guest-access.ts). A plain
// list of those Apps, each opened full page (apps.$app.full.tsx), and a
// way to sign out: nothing of the platform is shown or reachable from
// here, and core refuses a guest everything else anyway.

const styles = stylex.create({
  // The list as wide as the column, its rows' words from the start.
  list: { width: "100%", textAlign: "start" },
});

const GuestHome = () => {
  const { t } = useLingui();
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
      <Heading level={1}>
        <Trans>Apps shared with you</Trans>
      </Heading>
      {apps.state !== "ready" && <NotLoadedState heading="h2" page={apps} />}
      {apps.state === "ready" && apps.data.length === 0 && (
        <Text tone="muted">
          <Trans>Nothing is shared with you yet.</Trans>
        </Text>
      )}
      {apps.state === "ready" && apps.data.length > 0 && (
        <div {...stylex.props(styles.list)}>
          <ItemGroup aria-label={t`Apps shared with you`} separated>
            {apps.data.map(({ app, name, description }) => (
              // Full page, outside the shell, as "Open full page" links it.
              <Item href={`/apps/${app}/full`} key={app}>
                <ItemContent>
                  <ItemTitle>{name}</ItemTitle>
                  {description === "" ? null : (
                    <ItemDescription>{description}</ItemDescription>
                  )}
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </div>
      )}
      <Button
        disabled={busy}
        onClick={() => {
          void leave();
        }}
        variant="quiet"
      >
        {t`Sign out`}
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
