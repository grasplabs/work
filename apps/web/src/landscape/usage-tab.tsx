import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Trans, useLingui } from "@lingui/react/macro";
import { UsersIcon } from "lucide-react";

import { Section } from "./section.tsx";

// An app's Usage tab, as the prototype has it
// (`components/landscape/usage/usage-tab.tsx`): who has access to the app,
// who used it in the last 30 days, and everyone connected, to search,
// filter and revoke. Grasp sees no sign-ins to apps and runs no desktop
// agent yet, so it knows nobody who uses an app: the tab is the
// prototype's empty state.

/** The Usage tab of an app. */
export const UsageTab = ({ appName }: { appName: string }) => {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-6">
      <Section
        description={t`No usage recorded for this app yet.`}
        title={t`Usage`}
      >
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UsersIcon />
            </EmptyMedia>
            <EmptyTitle>
              <Trans>No connected users</Trans>
            </EmptyTitle>
            <EmptyDescription>
              <Trans>
                Grasp doesn&apos;t track who uses {appName} yet. Usage shows
                here once it does.
              </Trans>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </Section>
    </div>
  );
};
