import type { Project } from "@grasp-os/shared/projects";
import { AppShellPage } from "@grasp-os/ui/blocks/app-shell-01/app-shell-01";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import type { Session } from "../core.ts";
import { PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { ProjectView, projectTabOf } from "../projects/project-view.tsx";
import type { ProjectTab } from "../projects/project-view.tsx";
import { ProjectSkeleton } from "../projects/skeletons.tsx";
import { readOverview } from "../workflows/overview.ts";
import { noneIfRefused } from "../workflows/reads.ts";

// One project's page (projects/project-view.tsx), on the tab the address
// names (`?tab=`), with the person's own chats in it, the connections its
// items use and how each of its workflows stands. A project the person
// isn't in is not there for them (`project.not_found`): the page says it
// wasn't found, as for one that never was.

/** How many of each part the overview shows. */
const shown = 3;

/**
 * The project with as many of its items as the overview needs: core pages
 * Apps and workflows together, so a first page may hold none of one kind
 * while the project has some. Pages are read on, after the last, until
 * each kind has its three, none are left, or `pages` more were read: a
 * project of hundreds of Apps before its first workflow shows fewer, and
 * its tab has them all.
 */
const withOverviewItems = async (
  session: Session,
  project: Project,
  pages = 2
): Promise<Project> => {
  const short = (kind: "app" | "workflow"): boolean =>
    project.items.filter(({ type }) => type === kind).length <
    Math.min(
      shown,
      kind === "app" ? project.counts.apps : project.counts.workflows
    );
  const last = project.items.at(-1);
  if (
    pages === 0 ||
    !project.moreItems ||
    last === undefined ||
    (!short("app") && !short("workflow"))
  ) {
    return project;
  }
  const page = await session.projects.items(project.id, {
    at: last.addedAt,
    type: last.type,
    id: last.id,
  });
  return await withOverviewItems(
    session,
    {
      ...project,
      items: [...project.items, ...page.items],
      moreItems: page.more,
    },
    pages - 1
  );
};

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
  const { project, chats, connections, workflows, apps } = page.data;
  return (
    <ProjectView
      apps={apps}
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
 * The project before it is read: the library's record skeleton under
 * the page's bar, which leads back to Projects until the project's name
 * comes; its header, then a card of rows where its parts will stand. A
 * project has no side panel, so the record's panel stays out.
 */
const ProjectPending = () => {
  const { t } = useLingui();
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Projects`, to: "/projects" }]} />
      <AppShellPage>
        <ProjectSkeleton rows={4} />
      </AppShellPage>
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
        const [project, chats, connections, apps] = await Promise.all([
          session.projects
            .get(projectId)
            .then(async (read) => await withOverviewItems(session, read)),
          session.chats.list({ project: projectId }),
          // Read from Connect: where it can't be reached, the project
          // still opens, with no connections to show.
          session.projects
            .connections(projectId)
            .catch(() => ({ connections: [], unseen: 0 })),
          // Its Apps stand as the Apps page shows them, on that page's read.
          noneIfRefused(session.apps.overview()),
        ]);
        return { project, chats, connections, apps };
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
