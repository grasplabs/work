import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { PageNotLoaded } from "../frame/page-states.tsx";
import { Page } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { PageSkeletonRecord } from "../grasp/blocks/page-skeleton-record/page-skeleton-record.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { ProjectView } from "../projects/project-view.tsx";

// One project's page (projects/project-view.tsx), with the person's own
// chats in it and the connections its items use. A project the person
// isn't in is not there for them (`project.not_found`): the page says it
// wasn't found, as for one that never was.

const ProjectPage = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  if (page.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={[
          { label: t`Projects`, to: "/projects" },
          { label: t`Project` },
        ]}
        page={page}
      />
    );
  }
  const { project, chats, connections } = page.data;
  return (
    <ProjectView
      chats={chats}
      connections={connections}
      identity={identity}
      project={project}
    />
  );
};

/**
 * The project before it is read: the library's page-skeleton-record under
 * the page's bar, which leads back to Projects until the project's name
 * comes; its header with the goal's line, then a card of rows where its
 * Apps will stand. A project has no side panel, so the record's panel
 * stays out.
 */
const ProjectPending = () => {
  const { t } = useLingui();
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Projects`, to: "/projects" }]} />
      <Page>
        <PageSkeletonRecord actions={1} density="compact" rows={4} />
      </Page>
    </>
  );
};

export const Route = createFileRoute("/_shell/projects/$projectId")({
  pendingComponent: ProjectPending,
  component: ProjectPage,
  loader: async ({ context: { core }, params: { projectId } }) =>
    await loadFromCore(core, async (session) => {
      // The person's own chats in it come from their own Workspace; the
      // connections from what its items use.
      const [project, chats, connections] = await Promise.all([
        session.projects.get(projectId),
        session.chats.list({ project: projectId }),
        session.projects.connections(projectId),
      ]);
      return { project, chats, connections };
    }),
});
