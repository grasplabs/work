import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { PageNotLoaded, PageLoading } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { ProjectView } from "../projects/project-view.tsx";

// One project's page (projects/project-view.tsx). A project the person
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
  return <ProjectView identity={identity} project={page.data} />;
};

export const Route = createFileRoute("/_shell/projects/$projectId")({
  pendingComponent: PageLoading,
  component: ProjectPage,
  loader: async ({ context: { core }, params: { projectId } }) =>
    await loadFromCore(
      core,
      async (session) => await session.projects.get(projectId)
    ),
});
