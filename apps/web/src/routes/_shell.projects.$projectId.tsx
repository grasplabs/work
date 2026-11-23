import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { PageNotLoaded } from "../frame/page-states.tsx";
import { Page } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { PageSkeletonRecord } from "../grasp/blocks/page-skeleton-record/page-skeleton-record.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { ProjectView, projectTabOf } from "../projects/project-view.tsx";
import type { ProjectTab } from "../projects/project-view.tsx";
import { readOverview } from "../workflows/overview.ts";

// One project's page (projects/project-view.tsx), on the tab the address
// names (`?tab=`), with the person's own chats in it, the connections its
// items use and how each of its workflows stands. A project the person
// isn't in is not there for them (`project.not_found`): the page says it
// wasn't found, as for one that never was.

const ProjectPage = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { tab } = Route.useSearch();
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
  const { project, chats, connections, workflows } = page.data;
  return (
    <ProjectView
      chats={chats}
      connections={connections}
      identity={identity}
      project={project}
      tab={tab ?? "overview"}
      workflows={workflows}
    />
  );
};

/**
 * The project before it is read: the library's page-skeleton-record under
 * the page's bar, which leads back to Projects until the project's name
 * comes; its header, then a card of rows where its parts will stand. A
 * project has no side panel, so the record's panel stays out.
 */
const ProjectPending = () => {
  const { t } = useLingui();
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Projects`, to: "/projects" }]} />
      <Page>
        <PageSkeletonRecord
          actions={1}
          density="compact"
          rows={4}
          size="sm"
          variant="items"
        />
      </Page>
    </>
  );
};

export const Route = createFileRoute("/_shell/projects/$projectId")({
  pendingComponent: ProjectPending,
  component: ProjectPage,
  validateSearch: (
    search: Record<string, unknown>
  ): { tab?: ProjectTab | undefined } => {
    const tab = projectTabOf(search.tab);
    return tab === undefined ? {} : { tab };
  },
  loader: async ({ context: { core }, params: { projectId } }) => {
    // How its workflows stand comes from the Workflows page's own read; a
    // project shows its workflows without it when that read fails.
    const [loaded, workflows] = await Promise.all([
      loadFromCore(core, async (session) => {
        // The person's own chats in it come from their own Workspace; the
        // connections from what its items use.
        const [project, chats, connections] = await Promise.all([
          session.projects.get(projectId),
          session.chats.list({ project: projectId }),
          session.projects.connections(projectId),
        ]);
        return { project, chats, connections };
      }),
      readOverview(core),
    ]);
    if (loaded.state !== "ready") {
      return loaded;
    }
    return {
      state: "ready" as const,
      data: {
        ...loaded.data,
        workflows: workflows.state === "ready" ? workflows.data : [],
      },
    };
  },
});
