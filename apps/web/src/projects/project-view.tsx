import type {
  Project,
  ProjectItem,
  ProjectRole,
} from "@grasp-os/shared/projects";
import { canBuild } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { LayoutGridIcon, WorkflowIcon } from "lucide-react";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { EmptyCard, Page, PageHeading, SectionTitle } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { roleLabel } from "../labels.ts";
import { useCoreAction } from "../use-core-action.ts";
import { FileItemDialog } from "./file-item-dialog.tsx";
import { NewItemDialog } from "./new-item-dialog.tsx";
import { ProjectCountsLine, ProjectHours } from "./project-counts.tsx";
import { ProjectDialog } from "./project-dialog.tsx";
import { ProjectIcon } from "./project-icon.tsx";
import { usePages } from "./project-pages.ts";
import { namesInProject } from "./project-people-names.ts";
import { ProjectPeople } from "./project-people.tsx";

// A project's page (GRA-1458): its icon, name and what it is for, its
// hours and counts, then the Apps and workflows in it that the person may
// open, each saying whether everyone in the project has it, and who is in
// the project. Its builders add and take out items and people, change it
// and delete it; each step that takes access away first names who loses
// it.

/** An item's link: to its App or workflow page. */
const ItemLink = ({ item }: { item: ProjectItem }) =>
  item.type === "app" ? (
    <Link
      className="truncate font-medium"
      params={{ app: item.id }}
      to="/apps/$app"
    >
      {item.name}
    </Link>
  ) : (
    <Link
      className="truncate font-medium"
      params={{ workflow: item.id }}
      to="/workflows/$workflow"
    >
      {item.name}
    </Link>
  );

/** Taking an item out, after naming who loses it. */
const RemoveItem = ({
  project,
  item,
}: {
  project: Project;
  item: ProjectItem;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const itemName = item.name;
  const projectName = project.name;
  const who = formatList(namesInProject(project));
  return (
    <>
      <AlertDialog>
        <AlertDialogTrigger
          disabled={busy}
          render={
            <Button
              aria-label={t`Take ${itemName} out of the project`}
              size="sm"
              variant="ghost"
            />
          }
        >
          <Trans context="take out of a project">Remove</Trans>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>
                Take {itemName} out of {projectName}?
              </Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {item.sharedAs === null ? (
                <Trans>
                  It isn’t shared with the project, so nobody loses access. It
                  isn’t deleted.
                </Trans>
              ) : (
                <Trans>
                  It stops being shared with everyone in the project: {who} lose
                  access, unless it is shared with them another way. It isn’t
                  deleted.
                </Trans>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void run(async (session) => {
                  await changeThenRefresh(
                    async () => {
                      await session.projects.unfile(project.id, {
                        type: item.type,
                        id: item.id,
                      });
                    },
                    async () => {
                      await router.invalidate({ sync: true });
                    }
                  );
                });
              }}
              variant="destructive"
            >
              <Trans>Take out</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ErrorText>{failure}</ErrorText>
    </>
  );
};

/** That everyone in the project has an item, and in which role. */
const SharedBadge = ({ role }: { role: ProjectRole }) => {
  const shownRole = roleLabel(role);
  return (
    <Badge variant="secondary">
      <Trans>Everyone in it · {shownRole}</Trans>
    </Badge>
  );
};

/**
 * What is in the project that the person may open, a page at a time, or a
 * line saying there is nothing.
 */
const Items = ({ project }: { project: Project }) => {
  const { t } = useLingui();
  const builds = project.role === "builder";
  const pages = usePages(
    project,
    project.items,
    project.moreItems,
    async (session, after) => {
      const page = await session.projects.items(project.id, after);
      return { list: page.items, more: page.more };
    }
  );
  const items = pages.all;
  if (items.length === 0) {
    return <EmptyCard>{t`Nothing in it that you can open.`}</EmptyCard>;
  }
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y rounded-md border">
        {items.map((item) => (
          <li
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
            key={`${item.type}:${item.id}`}
          >
            <span className="flex min-w-0 items-center gap-2">
              {item.type === "app" ? (
                <LayoutGridIcon
                  aria-hidden="true"
                  className="size-4 flex-none"
                />
              ) : (
                <WorkflowIcon aria-hidden="true" className="size-4 flex-none" />
              )}
              <ItemLink item={item} />
            </span>
            <span className="flex items-center gap-2">
              {item.sharedAs === null ? (
                <Badge variant="outline">
                  <Trans>Not shared with the project</Trans>
                </Badge>
              ) : (
                <SharedBadge role={item.sharedAs} />
              )}
              {builds ? <RemoveItem item={item} project={project} /> : null}
            </span>
          </li>
        ))}
      </ul>
      {pages.more ? (
        <Button
          disabled={pages.busy}
          onClick={() => {
            void pages.readMore();
          }}
          size="sm"
          variant="outline"
        >
          <Trans>Show more</Trans>
        </Button>
      ) : null}
      <ErrorText>{pages.failure}</ErrorText>
    </div>
  );
};

/** Deleting the project, after naming who loses what is shared with it. */
const DeleteProject = ({ project }: { project: Project }) => {
  const navigate = useNavigate();
  const { busy, failure, run } = useCoreAction();
  const projectName = project.name;
  const who = formatList(namesInProject(project));
  return (
    <>
      <AlertDialog>
        <AlertDialogTrigger
          disabled={busy}
          render={<Button variant="outline" />}
        >
          <Trans>Delete</Trans>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Delete {projectName}?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {project.shared === 0 ? (
                <Trans>
                  Its apps and workflows aren’t deleted, and nothing in it is
                  shared with the project, so nobody loses access.
                </Trans>
              ) : (
                <Trans>
                  Its apps and workflows aren’t deleted, but they stop being
                  shared with everyone in it: {who} lose access to them, unless
                  they are shared with them another way.
                </Trans>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void run(async (session) => {
                  await session.projects.remove(project.id);
                  await navigate({ to: "/projects" });
                });
              }}
              variant="destructive"
            >
              <Trans>Delete project</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ErrorText>{failure}</ErrorText>
    </>
  );
};

/** A project's page, for someone in it. */
export const ProjectView = ({
  project,
  identity,
}: {
  project: Project;
  identity: Pick<Identity, "role">;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const builds = project.role === "builder";
  return (
    <>
      <SiteHeader
        crumbs={[
          { label: t`Projects`, to: "/projects" },
          { label: project.name },
        ]}
      />
      <Page wide>
        <PageHeading
          action={
            builds ? (
              <div className="flex flex-wrap gap-2">
                {canBuild(identity.role) ? (
                  <NewItemDialog project={project} />
                ) : null}
                <FileItemDialog project={project} />
                <Button
                  onClick={() => {
                    setEditing(true);
                  }}
                  variant="outline"
                >
                  <Trans>Change</Trans>
                </Button>
                <DeleteProject project={project} />
              </div>
            ) : undefined
          }
          clamp
          description={
            project.description === "" ? undefined : project.description
          }
          meta={
            <div className="flex flex-col gap-1">
              <ProjectHours />
              <ProjectCountsLine counts={project.counts} />
            </div>
          }
          title={
            <span className="inline-flex items-center gap-3">
              <ProjectIcon icon={project.icon} />
              {project.name}
            </span>
          }
        />
        <section className="flex flex-col gap-2">
          <SectionTitle>
            <Trans>Apps and workflows</Trans>
          </SectionTitle>
          <Items project={project} />
        </section>
        <section className="flex flex-col gap-2">
          <SectionTitle>
            <Trans>People</Trans>
          </SectionTitle>
          <p className="text-muted-foreground">
            <Trans>
              Being in the project reaches only what is shared with everyone in
              it.
            </Trans>
          </p>
          <ProjectPeople project={project} />
        </section>
      </Page>
      <ProjectDialog
        editing={project}
        onDone={() => {
          void router.invalidate();
        }}
        onOpenChange={setEditing}
        open={editing}
      />
    </>
  );
};
