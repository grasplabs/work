import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";

import { Button } from "../grasp/button/index.ts";
import { ArrowRight, Checklist } from "../grasp/icons/index.ts";
import {
  Item,
  ItemMedia,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Text } from "../grasp/text/index.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { InterviewsProgress } from "../onboarding/interviews-progress.tsx";
import { listeningOf } from "../onboarding/setup.ts";
import {
  SectionNotLoaded,
  SettingsError,
  SettingsLoading,
  SettingsStack,
} from "../settings/section.tsx";

// Settings, Onboarding, for admins: while Stephen talks to the team, where
// the interviews stand and the links to send, as the onboarding's own step
// shows them (onboarding/interviews-progress.tsx), here without his voice.
// Before the interviews are planned, the way to the onboarding; once who
// works where is in, planning them and sending the links is an open to-do,
// as when the admin left it for later on the onboarding's last step.

const today = (): string => new Date().toISOString().slice(0, 10);

const OnboardingPage = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const title = t`Onboarding`;
  if (page.state !== "ready") {
    return (
      <SectionCard title={title}>
        <SectionNotLoaded page={page} />
      </SectionCard>
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
    <SectionCard
      actions={
        <Button
          iconEnd={ArrowRight}
          render={<Link search={step} to="/setup" />}
          size="sm"
        >
          {t`Open your onboarding`}
        </Button>
      }
      description={t`While Stephen talks to your team: how far the interviews are, team by team, and everyone’s own link to send.`}
      title={title}
    >
      <SettingsStack>
        {linksToDo ? (
          <Item variant="outline">
            <ItemMedia icon={Checklist} />
            <ItemContent>
              <ItemTitle>{t`To do: let your team know, and send the interview links`}</ItemTitle>
              <ItemDescription>{t`Stephen talks to nobody until you pick the day the interviews start.`}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                render={<Link search={{ step: "team" }} to="/setup" />}
                size="sm"
                variant="ink"
              >
                {t`Do it now`}
              </Button>
            </ItemActions>
          </Item>
        ) : null}
        {view.plan === null && !linksToDo ? (
          <Text tone="muted">{t`The interviews aren’t planned yet. You plan them at the end of your onboarding.`}</Text>
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
      </SettingsStack>
    </SectionCard>
  );
};

export const Route = createFileRoute("/_shell/settings/onboarding")({
  pendingComponent: SettingsLoading,
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
