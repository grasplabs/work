import type { ProjectSummary } from "@grasp-os/shared/projects";
import { canBuild } from "@grasp-os/shared/roles";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useState } from "react";

import { PageNotLoaded, PageLoading } from "../frame/page-states.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { Button } from "../grasp/button/index.ts";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import { Plus, Projects as ProjectsIcon } from "../grasp/icons/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { projectCountsWords } from "../projects/project-counts.tsx";
import { ProjectDialog } from "../projects/project-dialog.tsx";
import { projectIconShapes } from "../projects/project-icon.tsx";
import { useRouterLinks } from "../projects/use-router-links.ts";

// Projects (GRA-1458): the projects the person is in, one row each, its
// icon, name and goal, and what it holds that the person may open; the
// whole row is its link. Who builds makes one with New project. A project
// is a piece of work with a goal: the people doing it, across teams, and
// the Apps and workflows it uses (the write-up on feat/projects-rethink).

/** One project's row: its icon, name, goal, and what it holds. */
const ProjectRow = ({
  project,
  href,
}: {
  project: ProjectSummary;
  href: string;
}) => {
  const counts = projectCountsWords(project.counts);
  const hasGoal = project.description !== "";
  return (
    <Item href={href} size="sm">
      <ItemMedia icon={projectIconShapes[project.icon]} />
      <ItemContent>
        <ItemTitle>
          {project.name}
          {hasGoal && counts !== undefined ? (
            <ItemDetail>{counts}</ItemDetail>
          ) : null}
        </ItemTitle>
        {hasGoal || counts !== undefined ? (
          <ItemDescription>
            {hasGoal ? project.description : counts}
          </ItemDescription>
        ) : null}
      </ItemContent>
    </Item>
  );
};

const Projects = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const navigate = useNavigate();
  const router = useRouter();
  const links = useRouterLinks();
  const [making, setMaking] = useState(false);
  if (page.state !== "ready") {
    return <PageNotLoaded crumbs={[{ label: t`Projects` }]} page={page} />;
  }
  const builds = canBuild(identity.role);
  const make = (
    <Button
      icon={Plus}
      onClick={() => {
        setMaking(true);
      }}
    >
      {t`New project`}
    </Button>
  );
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Projects` }]} />
      <Page>
        <PageHeading
          action={builds && page.data.length > 0 ? make : undefined}
          title={<Trans>Projects</Trans>}
        />
        {page.data.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia icon={ProjectsIcon} />
              <EmptyTitle>{t`No projects yet`}</EmptyTitle>
              <EmptyDescription>
                <Trans>
                  Group the apps and workflows of a process, a team or a goal in
                  a project. You see the projects you are in.
                </Trans>
              </EmptyDescription>
            </EmptyHeader>
            {builds ? <EmptyContent>{make}</EmptyContent> : null}
          </Empty>
        ) : (
          <div ref={links}>
            <ItemGroup aria-label={t`Projects`} separated>
              {page.data.map((project) => (
                <ProjectRow
                  href={
                    router.buildLocation({
                      to: "/projects/$projectId",
                      params: { projectId: project.id },
                    }).href
                  }
                  key={project.id}
                  project={project}
                />
              ))}
            </ItemGroup>
          </div>
        )}
      </Page>
      <ProjectDialog
        onDone={(projectId) => {
          void navigate({ to: "/projects/$projectId", params: { projectId } });
        }}
        onOpenChange={setMaking}
        open={making}
      />
    </>
  );
};

export const Route = createFileRoute("/_shell/projects/")({
  pendingComponent: PageLoading,
  component: Projects,
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session) => await session.projects.list()),
});
