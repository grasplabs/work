import { Button } from "@grasp-os/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Text } from "@grasp-os/ui/components/text";
import { ArrowRightIcon, CircleIcon, Icon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, Link } from "@tanstack/react-router";

import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { InterviewsProgress } from "../onboarding/interviews-progress.tsx";
import { listeningOf } from "../onboarding/setup.ts";
import {
  SettingsError,
  SettingsGroup,
  SettingsPending,
} from "../settings/section.tsx";

// Settings, Onboarding, for admins: while Stephen talks to the team, where
// the interviews stand and the links to send, as the onboarding's own step
// shows them (onboarding/interviews-progress.tsx), here without his voice.
// Before the interviews are planned, the way to the onboarding; once who
// works where is in, planning them and sending the links is an open to-do,
// as when the admin left it for later on the onboarding's last step.

const today = (): string => new Date().toISOString().slice(0, 10);

const styles = stylex.create({
  body: { display: "grid", gap: space[4] },
});

const OnboardingPage = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const title = t`Onboarding`;
  if (page.state !== "ready") {
    return (
      <SettingsGroup flush={false} title={title}>
        <NotLoadedState heading="h3" page={page} />
      </SettingsGroup>
    );
  }
  const { view, links } = page.data;
  const now = today();
  // Who works where is in, but nobody is asked yet: the links wait for the admin.
  const linksToDo = view.plan === null && view.roster !== null;
  let step: { step?: "team" | "listening" } = {};
  if (linksToDo) {
    step = { step: "team" };
  } else if (view.plan !== null) {
    step = { step: "listening" };
  }
  return (
    <SettingsGroup
      actions={
        <Button asChild size="xs" variant="secondary">
          <Link search={step} to="/setup">
            {t`Open your onboarding`}
            <Icon icon={ArrowRightIcon} />
          </Link>
        </Button>
      }
      description={t`While Stephen talks to your team: how far the interviews are, team by team, and everyone’s own link to send.`}
      flush={false}
      title={title}
    >
      <div {...stylex.props(styles.body)}>
        {linksToDo ? (
          <Item variant="outline">
            <ItemMedia variant="icon">
              <Icon icon={CircleIcon} />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t`To do: let your team know, and send the interview links`}</ItemTitle>
              <ItemDescription>{t`Stephen talks to nobody until you pick the day the interviews start.`}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button asChild size="sm">
                <Link search={{ step: "team" }} to="/setup">
                  {t`Do it now`}
                </Link>
              </Button>
            </ItemActions>
          </Item>
        ) : null}
        {view.plan === null && !linksToDo ? (
          <Text
            color="muted"
            size="sm"
          >{t`The interviews aren’t planned yet. You plan them at the end of your onboarding.`}</Text>
        ) : null}
        {view.plan === null ? null : (
          <InterviewsProgress
            links={links}
            listening={listeningOf(view, now)}
            spoken={false}
            today={now}
            view={view}
          />
        )}
      </div>
    </SettingsGroup>
  );
};

export const Route = createFileRoute("/_shell/settings/onboarding")({
  pendingComponent: () => <SettingsPending groups={[4]} />,
  errorComponent: SettingsError,
  component: OnboardingPage,
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session) => {
      const [view, links] = await Promise.all([
        session.onboarding.view(),
        session.onboarding.links(),
      ]);
      return { view, links };
    }),
});
