import { Button } from "@grasp-os/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRightIcon, CircleDashedIcon } from "lucide-react";

import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { InterviewsProgress } from "../onboarding/interviews-progress.tsx";
import { listeningOf } from "../onboarding/setup.ts";
import {
  SettingsBody,
  SettingsError,
  SettingsLoading,
  SettingsSection,
} from "../settings/settings-parts.tsx";

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
      <SettingsSection title={title}>
        <NotLoadedState heading="h3" page={page} />
      </SettingsSection>
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
    <SettingsSection
      action={
        <Button
          nativeButton={false}
          render={<Link search={step} to="/setup" />}
          size="sm"
          variant="outline"
        >
          {t`Open your onboarding`}
          <ArrowRightIcon data-icon="inline-end" />
        </Button>
      }
      description={t`While Stephen talks to your team: how far the interviews are, team by team, and everyone’s own link to send.`}
      title={title}
    >
      <SettingsBody>
        {linksToDo ? (
          <Item variant="outline">
            <ItemMedia variant="icon">
              <CircleDashedIcon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t`To do: let your team know, and send the interview links`}</ItemTitle>
              <ItemDescription>{t`Stephen talks to nobody until you pick the day the interviews start.`}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                nativeButton={false}
                render={<Link search={{ step: "team" }} to="/setup" />}
                size="sm"
              >
                {t`Do it now`}
              </Button>
            </ItemActions>
          </Item>
        ) : null}
        {view.plan === null && !linksToDo ? (
          <p className="text-muted-foreground">{t`The interviews aren’t planned yet. You plan them at the end of your onboarding.`}</p>
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
      </SettingsBody>
    </SettingsSection>
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
