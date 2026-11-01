/**
 * What the company connected, and what its workflows still need
 * connected, ported from the prototype (grasplabs/prototype
 * `components/admin/org-integrations.tsx`, and `NeededPanel` in
 * `components/admin/source-panels.tsx`).
 *
 * Only what the company's core answered is shown. A company that hasn't
 * signed in has nothing connected, as the model has it. Once it has, core
 * sends its shared connections, its people's own counted by app, and what
 * its workflows and chats still need (`integrations`); a core on an older
 * release, or one whose connect didn't answer, sends none, and the panels
 * say so. What the company skipped in its own onboarding core doesn't
 * send yet.
 */
import { Badge } from "@grasp-os/ui/components/badge";
import { createFileRoute } from "@tanstack/react-router";

import {
  AskedOfGraspRows,
  ConnectedRows,
  StillToConnectRows,
} from "../../../admin/connections.tsx";
import { useOrganization } from "../../../admin/organization.tsx";
import { Section } from "../../../admin/section.tsx";
import { sourceNames } from "../../../admin/sections.ts";
/**
 * What the company connected: nothing before it has signed in, in its own
 * onboarding; after that, whatever core reports.
 */
const Connected = () => {
  const { view, admin } = useOrganization();
  const { integrations } = admin.snapshot;
  if (view.org.made || view.state.client === "none") {
    return (
      <Section
        description="The company starts with its sign-in, in its own onboarding. Everything else follows once it has named its team leads."
        title="Nothing connected yet"
      >
        <p className="text-muted-foreground border-t px-5 py-4">
          {view.org.made
            ? "An organization made here has nothing to connect."
            : "Grasp waits on the company’s own admin."}
        </p>
      </Section>
    );
  }
  return (
    <Section
      description="Where its people sign in, its HR platform, where its documents live, Pulse on its laptops, and the apps its work runs in."
      title="What the company connected"
    >
      {integrations === null ? (
        <p className="text-muted-foreground border-t px-5 py-4">
          The company’s own Grasp doesn’t report what it connected yet. Once it
          does, each connection is here with who connected it, when, and what
          Grasp may do there.
        </p>
      ) : (
        <ConnectedRows integrations={integrations} />
      )}
    </Section>
  );
};

/**
 * What the workflows need that the company hasn't connected, once core
 * reports it, and the apps it asked Grasp to add, each leading to its
 * build.
 */
const StillToConnect = () => {
  const { integrations, asked } = useOrganization().admin.snapshot;
  return (
    <Section
      action={<Badge variant="outline">{sourceNames.composio}</Badge>}
      description="What the workflows need that the company has not connected: worth reaching out about."
      title="Still to connect"
    >
      {integrations === null ? (
        <p className="text-muted-foreground border-t px-5 py-4">
          The company’s own Grasp doesn’t report what its workflows need yet.
          Once it does, this fills in by itself.
        </p>
      ) : (
        <StillToConnectRows integrations={integrations} />
      )}
      {asked.length > 0 ? <AskedOfGraspRows asked={asked} /> : null}
    </Section>
  );
};

const Integrations = () => (
  <>
    <Connected />
    <StillToConnect />
  </>
);

/** An organization's Integrations: what it connected, and what is still to connect. */
export const Route = createFileRoute("/organizations/$clientId/integrations")({
  component: Integrations,
});
