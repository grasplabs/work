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
import { Button as KitButton } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { Page, PageHeading } from "../frame/page.tsx";
import { RouterLink } from "../frame/router-link.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { Button } from "../grasp/button/index.ts";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuPanel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import { Empty } from "../grasp/empty/index.ts";
import {
  AppPanels,
  Edit,
  More,
  Plus,
  Trash,
  Workflow,
} from "../grasp/icons/index.ts";
import { Item, ItemGroup } from "../grasp/item/index.ts";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../grasp/tabs/index.ts";
import { Text } from "../grasp/text/index.ts";
import { roleLabel } from "../labels.ts";
import { useCoreAction } from "../use-core-action.ts";
import { FileItemDialog } from "./file-item-dialog.tsx";
import { ProjectDialog } from "./project-dialog.tsx";
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
    <RouterLink params={{ app: item.id }} to="/apps/$app">
      {item.name}
    </RouterLink>
  ) : (
    <RouterLink params={{ workflow: item.id }} to="/workflows/$workflow">
      {item.name}
    </RouterLink>
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
            <KitButton
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

/** Whether everyone in the project has an item, and in which role. */
const SharedWords = ({ role }: { role: ProjectRole | null }) => {
  if (role === null) {
    return <Trans>Not shared with the project</Trans>;
  }
  const shownRole = roleLabel(role);
  return <Trans>Everyone in it · {shownRole}</Trans>;
};

/** The project's items, read a page at a time, shared by its tabs. */
const useItemPages = (project: Project) =>
  usePages(
    project,
    project.items,
    project.moreItems,
    async (session, after) => {
      const page = await session.projects.items(project.id, after);
      return { list: page.items, more: page.more };
    }
  );
type ItemPages = ReturnType<typeof useItemPages>;

/**
 * What of one kind is in the project that the person may open, a page at
 * a time, or a line saying there is nothing. Core pages Apps and
 * workflows together: each tab shows its own kind of what is read so far,
 * and Show more reads on.
 */
const Items = ({
  project,
  kind,
  pages,
}: {
  project: Project;
  kind: ProjectItem["type"];
  pages: ItemPages;
}) => {
  const { t } = useLingui();
  const builds = project.role === "builder";
  const items = pages.all.filter(({ type }) => type === kind);
  if (items.length === 0 && !pages.more) {
    return <Empty size="inline">{t`Nothing in it that you can open.`}</Empty>;
  }
  return (
    <>
      <ItemGroup separated>
        {items.map((item) => (
          <Item
            actions={
              builds ? <RemoveItem item={item} project={project} /> : undefined
            }
            description={<SharedWords role={item.sharedAs} />}
            icon={item.type === "app" ? AppPanels : Workflow}
            key={`${item.type}:${item.id}`}
            size="sm"
            title={<ItemLink item={item} />}
          />
        ))}
      </ItemGroup>
      {pages.more ? (
        <Button
          disabled={pages.busy}
          onClick={() => {
            void pages.readMore();
          }}
          size="sm"
          variant="quiet"
        >
          {t`Show more`}
        </Button>
      ) : null}
      <ErrorText>{pages.failure}</ErrorText>
    </>
  );
};

/**
 * Deleting the project, after naming who loses what is shared with it;
 * opened from the page's menu.
 */
const DeleteProject = ({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const navigate = useNavigate();
  const { failure, run } = useCoreAction();
  const projectName = project.name;
  const who = formatList(namesInProject(project));
  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
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
        <ErrorText>{failure}</ErrorText>
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
  );
};

/** A tab's name, and how many it holds, quieter beside it. */
const KindTab = ({ children, count }: { children: string; count: number }) => (
  <>
    {children}{" "}
    <Text element="span" size="xs" tone="muted">
      {count}
    </Text>
  </>
);

/** The page's menu, for the project's builders: change it, or delete it. */
const ProjectMenu = ({
  project,
  onChange,
  onDelete,
}: {
  project: Project;
  onChange: () => void;
  onDelete: () => void;
}) => {
  const { t } = useLingui();
  const title = project.name;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger icon={More} label={t`More for ${title}`} />
      <DropdownMenuPanel align="end">
        <DropdownMenuItem icon={Edit} onSelect={onChange}>
          {t`Change`}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem danger icon={Trash} onSelect={onDelete}>
          {t`Delete`}
        </DropdownMenuItem>
      </DropdownMenuPanel>
    </DropdownMenu>
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
  const [deleting, setDeleting] = useState(false);
  const builds = project.role === "builder";
  const makes = builds && canBuild(identity.role);
  const { apps, workflows } = project.counts;
  const pages = useItemPages(project);
  // Opens on what it has: its Apps, else its workflows.
  const firstTab = apps === 0 && workflows > 0 ? "workflows" : "apps";
  return (
    <>
      <SiteHeader
        crumbs={[
          { label: t`Projects`, to: "/projects" },
          { label: project.name },
        ]}
      />
      <Page>
        <PageHeading
          action={
            builds ? (
              <>
                <ProjectMenu
                  onChange={() => {
                    setEditing(true);
                  }}
                  onDelete={() => {
                    setDeleting(true);
                  }}
                  project={project}
                />
                <FileItemDialog project={project} />
                {makes ? (
                  <Button
                    icon={Plus}
                    render={
                      <Link
                        search={{ make: "app", project: project.id }}
                        to="/"
                      />
                    }
                  >
                    {t`Make something`}
                  </Button>
                ) : null}
              </>
            ) : undefined
          }
          clamp
          description={
            project.description === "" ? undefined : project.description
          }
          title={project.name}
        />
        <Tabs defaultValue={firstTab}>
          <TabsList aria-label={project.name}>
            <TabsTab value="apps">
              <KindTab count={apps}>{t`Apps`}</KindTab>
            </TabsTab>
            <TabsTab value="workflows">
              <KindTab count={workflows}>{t`Workflows`}</KindTab>
            </TabsTab>
            <TabsTab value="people">
              <KindTab count={project.people}>{t`People`}</KindTab>
            </TabsTab>
          </TabsList>
          <TabsPanel value="apps">
            <Items kind="app" pages={pages} project={project} />
          </TabsPanel>
          <TabsPanel value="workflows">
            <Items kind="workflow" pages={pages} project={project} />
          </TabsPanel>
          <TabsPanel value="people">
            <ProjectPeople project={project} />
          </TabsPanel>
        </Tabs>
      </Page>
      <ProjectDialog
        editing={project}
        onDone={() => {
          void router.invalidate();
        }}
        onOpenChange={setEditing}
        open={editing}
      />
      {builds ? (
        <DeleteProject
          onOpenChange={setDeleting}
          open={deleting}
          project={project}
        />
      ) : null}
    </>
  );
};
