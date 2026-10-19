import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Trans, useLingui } from "@lingui/react/macro";
import { Await, createFileRoute } from "@tanstack/react-router";
import { LockIcon } from "lucide-react";
import { useState } from "react";

import { LoadingLines, NotLoadedState } from "../frame/page-states.tsx";
import type { AppAudit } from "../landscape/app-page.ts";
import { AuditTrail } from "../landscape/audit-trail.tsx";
import {
  hasOlder,
  readOlderAppAudit,
  readWholeAppAudit,
  trailEvents,
} from "../landscape/landscape-audit.ts";
import type { AppAuditTrail } from "../landscape/landscape-audit.ts";
import { Section } from "../landscape/section.tsx";
import { useAppPage } from "../landscape/use-app-page.ts";
import { useCoreAction } from "../use-core-action.ts";

// An app's audit trail: the events core's audit log holds on its
// connections, the latest stretch first and older ones as asked for. Only
// admins read the log; anyone else is told so.

/** The trail as read so far, reading on as asked: older events, or all of them to export. */
const ReadTrail = ({
  appName,
  first,
}: {
  appName: string;
  first: AppAuditTrail;
}) => {
  const [trail, setTrail] = useState(first);
  const { busy, failure, run } = useCoreAction();
  const showOlder = async () => {
    const read = await run(
      async (session) => await readOlderAppAudit(session, trail)
    );
    if (read !== undefined) {
      setTrail(read);
    }
  };
  const readWhole = async () => {
    const read = await run(
      async (session) => await readWholeAppAudit(session, trail)
    );
    if (read !== undefined) {
      setTrail(read);
    }
    return read === undefined ? read : trailEvents(read);
  };
  return (
    <AuditTrail
      appName={appName}
      busy={busy}
      events={trailEvents(trail)}
      failure={failure}
      older={hasOlder(trail.read)}
      onShowOlder={() => {
        void showOlder();
      }}
      readWhole={readWhole}
    />
  );
};

/** Why there's no trail: only admins read it, or it didn't load. */
const NoTrail = ({
  audit,
}: {
  audit: Exclude<AppAudit, { state: "ready" }>;
}) => {
  const { t } = useLingui();
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

const Audit = () => {
  const { t } = useLingui();
  const { app, audit } = useAppPage();
  if (app === null) {
    return null;
  }
  return (
    <Await
      fallback={
        <Section
          description={t`Every recorded access and permission event, most recent first.`}
          title={t`Event timeline`}
        >
          <LoadingLines />
        </Section>
      }
      promise={audit}
    >
      {(loaded) =>
        loaded.state === "ready" ? (
          <ReadTrail appName={app.name} first={loaded.data} />
        ) : (
          <NoTrail audit={loaded} />
        )
      }
    </Await>
  );
};

export const Route = createFileRoute("/_shell/landscape/$appId/audit")({
  component: Audit,
});
