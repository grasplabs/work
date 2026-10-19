import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeftIcon, UserXIcon } from "lucide-react";

import { useAppPage } from "../landscape/use-app-page.ts";

// One person's use of an app, as the prototype has it
// (`components/landscape/usage/user-page.tsx`). Grasp knows nobody who
// uses an app yet (see the Usage tab), so every link here finds no one:
// the prototype's own state for a user who isn't connected.

const UserPage = () => {
  const { t } = useLingui();
  const { app } = useAppPage();
  const { appId } = Route.useParams();
  if (app === null) {
    return null;
  }
  const appName = app.name;
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <UserXIcon />
        </EmptyMedia>
        <EmptyTitle>{t`User not found`}</EmptyTitle>
        <EmptyDescription>
          {t`Nobody with this link is connected to ${appName}.`}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          nativeButton={false}
          render={<Link params={{ appId }} to="/landscape/$appId/usage" />}
          variant="outline"
        >
          <ArrowLeftIcon data-icon="inline-start" />
          <Trans>Back to users</Trans>
        </Button>
      </EmptyContent>
    </Empty>
  );
};

export const Route = createFileRoute("/_shell/landscape/$appId/usage/$userId")({
  component: UserPage,
});
