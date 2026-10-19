import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Trans, useLingui } from "@lingui/react/macro";
import { NetworkIcon } from "lucide-react";

import { Section } from "./section.tsx";

// An app's Connections tab, as the prototype has it
// (`components/landscape/connections/connections-tab.tsx`): every access
// path the app is part of, from an AI platform through an MCP or connector
// to a high-value system, drawn as flows and sorted by decision. Grasp
// observes no such paths between apps yet, so the tab is the prototype's
// empty state.

/** The Connections tab of an app. */
export const ConnectionsTab = () => {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-6">
      <Section title={t`Access connections`}>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <NetworkIcon />
            </EmptyMedia>
            <EmptyTitle>
              <Trans>No connection paths recorded</Trans>
            </EmptyTitle>
            <EmptyDescription>
              <Trans>
                Grasp will show a path here once it observes an MCP, native
                connector or OAuth grant for this app.
              </Trans>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </Section>
    </div>
  );
};
