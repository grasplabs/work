/**
 * What the company connected, and what its workflows still need
 * connected, ported from the prototype (grasplabs/prototype
 * `components/admin/org-integrations.tsx`, and `NeededPanel` in
 * `components/admin/source-panels.tsx`).
 *
 * Only what the company's core answered is shown. A company that hasn't
 * signed in has nothing connected, as the model has it. Once it has, core
 * doesn't report its connections yet (its snapshot's `integrations` is
 * null), so the prototype's list of them, with who connected each, what
 * Grasp may do there and which needs signing in again, waits for core to
 * send them; so does what the company skipped in its own onboarding,
 * which core doesn't send either. What the workflows still need connected
 * comes from Composio, which the console doesn't read yet.
 */
import { Badge } from "@grasp-os/ui/components/badge";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useOrganization } from "../../../../admin/organization.tsx";
import { sourceNames } from "../../../../admin/sections.ts";

/** One part of the section: its title, what it is, perhaps a mark beside them, and its lines. */
const Panel = ({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) => (
  <section className="bg-card overflow-hidden rounded-xl border">
    <div className="flex items-start justify-between gap-4 px-5 py-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="font-medium">{title}</h2>
        <p className="text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
    {children}
  </section>
);

/**
 * What the company connected: nothing before it has signed in, in its own
 * onboarding; after that, whatever core reports, which it doesn't yet.
 */
const Connected = () => {
  const { view } = useOrganization();
  if (view.org.made || view.state.client === "none") {
    return (
      <Panel
        description="The company starts with its sign-in, in its own onboarding. Everything else follows once it has named its team leads."
        title="Nothing connected yet"
      >
        <p className="text-muted-foreground border-t px-5 py-4">
          {view.org.made
            ? "An organization made here has nothing to connect."
            : "Grasp waits on the company’s own admin."}
        </p>
      </Panel>
    );
  }
  return (
    <Panel
      description="Where its people sign in, its HR platform, where its documents live, Pulse on its laptops, and the apps its work runs in."
      title="What the company connected"
    >
      <p className="text-muted-foreground border-t px-5 py-4">
        The company’s own Grasp doesn’t report what it connected yet. Once it
        does, each connection is here with who connected it, when, and what
        Grasp may do there.
      </p>
    </Panel>
  );
};

/** What the workflows need that the company hasn't connected, from Composio once it is read. */
const StillToConnect = () => (
  <Panel
    action={<Badge variant="outline">{sourceNames.composio}</Badge>}
    description="What the workflows need that the company has not connected: worth reaching out about."
    title="Still to connect"
  >
    <p className="text-muted-foreground border-t px-5 py-4">
      {`Once ${sourceNames.composio} is connected, this fills in by itself.`}
    </p>
  </Panel>
);

const Integrations = () => (
  <>
    <Connected />
    <StillToConnect />
  </>
);

/** An organization's Integrations: what it connected, and what is still to connect. */
export const Route = createFileRoute(
  "/admin/organizations/$clientId/integrations"
)({
  component: Integrations,
});
