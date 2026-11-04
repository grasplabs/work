import type { ProjectSummary } from "@grasp-os/shared/projects";
import { canBuild } from "@grasp-os/shared/roles";
import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent, CardHeader } from "@grasp-os/ui/components/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { FolderIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { PageNotLoaded, PageLoading } from "../frame/page-states.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { ProjectCountsLine } from "../projects/project-counts.tsx";
import { ProjectDialog } from "../projects/project-dialog.tsx";
import { ProjectIcon } from "../projects/project-icon.tsx";

// Projects (GRA-1458), as the prototype's domains (`routes/domains/
// index.tsx`): the projects the person is in, each a card with its icon,
// name and what it is for, its hours a week and what it holds that the
// person may open. Who builds makes one with New project, as an App: its
// builders decide whom what is shared with it reaches.

/** One project's card; the whole card is its link. */
const ProjectCard = ({ project }: { project: ProjectSummary }) => (
  <li className="relative">
    <Card className="h-full" size="sm">
      <CardHeader>
        <div className="flex items-start gap-3">
          <ProjectIcon icon={project.icon} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <Link
              className="font-medium outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:underline"
              params={{ projectId: project.id }}
              to="/projects/$projectId"
            >
              {project.name}
            </Link>
            {project.description === "" ? null : (
              <p className="text-muted-foreground line-clamp-2">
                {project.description}
              </p>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ProjectCountsLine counts={project.counts} />
      </CardContent>
    </Card>
  </li>
);

/** No project yet: making one is a click away. */
const NoProjects = ({ onMake }: { onMake?: () => void }) => (
  <Card size="sm">
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderIcon />
        </EmptyMedia>
        <EmptyTitle>
          <Trans>No projects yet</Trans>
        </EmptyTitle>
        <EmptyDescription>
          <Trans>
            Group the apps and workflows of a process, a team or a goal in a
            project. You see the projects you are in.
          </Trans>
        </EmptyDescription>
      </EmptyHeader>
      {onMake === undefined ? null : (
        <EmptyContent>
          <Button onClick={onMake} size="sm">
            <PlusIcon data-icon="inline-start" />
            <Trans>New project</Trans>
          </Button>
        </EmptyContent>
      )}
    </Empty>
  </Card>
);

const Projects = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const navigate = useNavigate();
  const [making, setMaking] = useState(false);
  if (page.state !== "ready") {
    return <PageNotLoaded crumbs={[{ label: t`Projects` }]} page={page} />;
  }
  const make = canBuild(identity.role)
    ? () => {
        setMaking(true);
      }
    : undefined;
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Projects` }]} />
      <Page wide>
        <PageHeading
          action={
            make === undefined ? undefined : (
              <Button onClick={make}>
                <PlusIcon data-icon="inline-start" />
                <Trans>New project</Trans>
              </Button>
            )
          }
          description={
            <Trans>
              Apps and workflows grouped by process, team or goal. Putting
              something in a project shares it with nobody.
            </Trans>
          }
          title={<Trans>Projects</Trans>}
        />
        {page.data.length === 0 ? (
          <NoProjects onMake={make} />
        ) : (
          <ul
            aria-label={t`Projects`}
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          >
            {page.data.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </ul>
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
