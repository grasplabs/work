import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { LockIcon } from "lucide-react";

import { NotLoadedState } from "../frame/page-states.tsx";
import { AuditTrail } from "../landscape/audit-trail.tsx";
import { Section } from "../landscape/section.tsx";
import { useAppPage } from "../landscape/use-app-page.ts";

// An app's audit trail: the events core's audit log holds on its
// connections. Only admins read the log; anyone else is told so.

const Audit = () => {
  const { t } = useLingui();
  const { app, audit } = useAppPage();
  if (app === null) {
    return null;
  }
  if (audit.state === "ready") {
    return <AuditTrail appName={app.name} events={audit.data} />;
  }
  return (
    <Section
      description={t`Every recorded access and permission event, most recent first.`}
      title={t`Event timeline`}
    >
      {audit.state === "adminsOnly" ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockIcon />
            </EmptyMedia>
            <EmptyTitle>
              <Trans>Only admins can read the audit trail</Trans>
            </EmptyTitle>
            <EmptyDescription>
              <Trans>Ask an admin if you need to see what happened here.</Trans>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <NotLoadedState heading="h3" page={audit} />
      )}
    </Section>
  );
};

export const Route = createFileRoute("/_shell/landscape/$appId/audit")({
  component: Audit,
});
