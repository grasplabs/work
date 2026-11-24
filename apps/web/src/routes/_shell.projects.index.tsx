import type { ProjectSummary } from "@grasp-os/shared/projects";
import { canBuild } from "@grasp-os/shared/roles";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import { Icon, FolderKanbanIcon, PlusIcon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { PageNotLoaded } from "../frame/page-states.tsx";
import { pageText } from "../frame/page-text.ts";
import { Page } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { projectCountsWords } from "../projects/project-counts.tsx";
import { ProjectDialog } from "../projects/project-dialog.tsx";
import { projectIconShapes } from "../projects/project-icon.tsx";
import { ProjectsSkeleton } from "../projects/skeletons.tsx";
import { SeparatedItems } from "../workflows/separated-items.tsx";

// Projects (GRA-1458): the projects the person is in, one row each, its
// icon, name and goal, and what it holds that the person may open; the
// whole row is its link. Who builds makes one with New project. A project
// is a folder towards a goal: its Apps and workflows, each person's own
// chats in it, the connections its items use, and the people in it.

/** One project's row: its icon, name, goal, and what it holds. */
const ProjectRow = ({ project }: { project: ProjectSummary }) => {
  const counts = projectCountsWords(project.counts);
  const hasGoal = project.description !== "";
  return (
    <Item asChild size="sm">
      <Link params={{ projectId: project.id }} to="/projects/$projectId">
        <ItemMedia variant="icon">
          <Icon icon={projectIconShapes[project.icon]} />
        </ItemMedia>
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
      </Link>
    </Item>
  );
};

const Projects = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const navigate = useNavigate();
  const [making, setMaking] = useState(false);
  if (page.state !== "ready") {
    return <PageNotLoaded crumbs={[{ label: t`Projects` }]} page={page} />;
  }
  const builds = canBuild(identity.role);
  const make = (
    <Button
      variant="outline"
      onClick={() => {
        setMaking(true);
      }}
    >
      <Icon icon={PlusIcon} />
      {t`New project`}
    </Button>
  );
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Projects` }]} />
      <Page>
        <div {...stylex.props(pageText.text)}>
          <PageHeader
            {...(builds && page.data.length > 0 ? { actions: make } : {})}
            title={t`Projects`}
          />
          {page.data.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia icon={FolderKanbanIcon} />
                {/* What a project is, New project's dialog says as one is made. */}
                <EmptyTitle>{t`No projects yet`}</EmptyTitle>
              </EmptyHeader>
              {builds ? <EmptyContent>{make}</EmptyContent> : null}
            </Empty>
          ) : (
            <SeparatedItems
              aria-label={t`Projects`}
              rows={page.data.map((project) => ({
                key: project.id,
                row: <ProjectRow key={project.id} project={project} />,
              }))}
            />
          )}
        </div>
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

/**
 * The projects before they are read: the library's list skeleton under
 * the page's own bar, its header without a description, as the page's is,
 * and as many rows as fill the first screen, two lines high with the
 * project's icon, as the page's Items are.
 */
const ProjectsPending = () => {
  const { t } = useLingui();
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Projects` }]} />
      <Page>
        <ProjectsSkeleton rows={8} />
      </Page>
    </>
  );
};

export const Route = createFileRoute("/_shell/projects/")({
  pendingComponent: ProjectsPending,
  component: Projects,
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session) => await session.projects.list()),
});
