import { isAdmin } from "@grasp-os/shared/roles";
import { createFileRoute } from "@tanstack/react-router";

import type { Session } from "../core.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import {
  SettingsError,
  SettingsLoading,
  SettingsSection,
} from "../settings/settings-parts.tsx";
import { StephenSettings } from "../settings/stephen-settings.tsx";
import type { AskableWorkflow } from "../settings/stephen-settings.tsx";

// Settings › Stephen, for admins: who can reach the company's assistant in
// its chat apps and what he may do for whom (settings/stephen-settings.tsx),
// with how he is doing (`stephenRequests.week`) and the workflows people
// may start by asking him; each of those two read on its own, so the
// settings show when either can't be read.
// Grasp staff read it; only the company's own admins change it, as core
// checks on every call.

/** Most workflows whose asking is read: the list is short in practice. */
const workflowsRead = 50;

/** A read that may fail on its own without failing the page. */
const orNull = async <T,>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

/** The workflows people may start by asking Stephen, of those the admin can see. */
const askableWorkflows = async (
  session: Session
): Promise<AskableWorkflow[]> => {
  const listed = await session.workflowResources.list();
  const live = listed
    .filter(({ currentVersion }) => currentVersion !== null)
    .slice(0, workflowsRead);
  const open = await Promise.all(
    live.map(async ({ id }) => await session.workflowResources.askable(id))
  );
  return live
    .filter((_, index) => open[index] === true)
    .map(({ id, name }) => ({ id, name }));
};

const StephenPage = () => {
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  if (page.state !== "ready") {
    return (
      <SettingsSection title="Stephen">
        <NotLoadedState heading="h3" page={page} />
      </SettingsSection>
    );
  }
  return (
    <StephenSettings
      classes={page.data.classes}
      editable={isAdmin(identity.role) && !identity.staff}
      reach={page.data.reach}
      week={page.data.week}
      workflows={page.data.workflows}
    />
  );
};

export const Route = createFileRoute("/_shell/settings/stephen")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: StephenPage,
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session) => {
      const [reach, classes, week, workflows] = await Promise.all([
        session.connections.stephenReach(),
        session.connections.toolClasses(),
        orNull(async () => await session.stephenRequests.week()),
        orNull(async () => await askableWorkflows(session)),
      ]);
      return { reach, classes, week, workflows };
    }),
});
