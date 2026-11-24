import type { ChatSummary } from "@grasp-os/shared/chat";
import type {
  Project,
  ProjectItem,
  ProjectRole,
} from "@grasp-os/shared/projects";
import { canBuild } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import { IconTile } from "@grasp-os/ui/components/icon-tile";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Link } from "@grasp-os/ui/components/link";
import {
  EllipsisIcon,
  Icon,
  LayoutDashboardIcon,
  MessageCircleIcon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
  WorkflowIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import {
  Link as RouterLink,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { Fragment, useState } from "react";
import type { ReactNode } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { roleLabel } from "../labels.ts";
import { useCoreAction } from "../use-core-action.ts";
import { FileItemDialog } from "./file-item-dialog.tsx";
import { AddChat, ProjectChatList } from "./project-chats.tsx";
import { ProjectDialog } from "./project-dialog.tsx";
import { projectIconShapes } from "./project-icon.tsx";
import { usePages } from "./project-pages.ts";
import { namesInProject } from "./project-people-names.ts";
import { ProjectPeopleStack } from "./project-people-stack.tsx";

// A project's page (GRA-1458): its icon, name and what it is for, who is
// in it, then the Apps, the workflows and the person's own chats in it,
// each kind in a card of its own, or one quiet row where it has none. Each
// App and workflow says whether everyone in the project has it. Its
// builders add and take out items and people, change it and delete it;
// each step that takes access away first names who loses it.

const styles = stylex.create({
  // The icon and the name on one line, centred on each other. The name
  // takes what the actions leave and breaks inside a word that is longer.
  named: { display: "flex", alignItems: "center", gap: space["3"] },
  name: { minWidth: 0, overflowWrap: "anywhere" },
  // The page's actions, in a row that wraps on a phone.
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
  },
  // Show more and a failure, under a card's list, at the rows' inset.
  foot: {
    display: "grid",
    justifyItems: "start",
    gap: space["2"],
    paddingInline: space.tableCellInline,
    paddingBlock: space["2"],
  },
});

/** An item's link: to its App or workflow page. */
const ItemLink = ({ item }: { item: ProjectItem }) => (
  <Link asChild>
    {item.type === "app" ? (
      <RouterLink params={{ app: item.id }} to="/apps/$app">
        {item.name}
      </RouterLink>
    ) : (
      <RouterLink params={{ workflow: item.id }} to="/workflows/$workflow">
        {item.name}
      </RouterLink>
    )}
  </Link>
);

/**
 * A step that asks first, in an alert dialog of its own: it stays open
 * while the step works and when it fails (the Button says so, and core's
 * reason shows under its words), and closes once it is done.
 */
const useAsking = () => {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  return {
    open,
    setOpen,
    handleOpenChange: (
      next: boolean,
      details: { cancel: () => void }
    ): void => {
      if (working) {
        details.cancel();
        return;
      }
      setOpen(next);
    },
    /** Runs `step`; `done` is whether it worked, which closes the dialog. */
    answer: async (step: () => Promise<boolean>): Promise<void> => {
      setWorking(true);
      const done = await step().finally(() => {
        setWorking(false);
      });
      if (!done) {
        throw new Error("The step did not finish.");
      }
      setOpen(false);
    },
  };
};

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
  const { failure, run } = useCoreAction();
  const asking = useAsking();
  const itemName = item.name;
  const projectName = project.name;
  const who = formatList(namesInProject(project));
  const takeOut = async (): Promise<boolean> =>
    (await run(async (session) => {
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
      return true;
    })) === true;
  return (
    <AlertDialog onOpenChange={asking.handleOpenChange} open={asking.open}>
      <AlertDialogTrigger asChild>
        <Button
          aria-label={t`Take ${itemName} out of the project`}
          size="sm"
          tooltip={false}
          variant="ghost"
        >
          <Icon icon={MinusIcon} />
          <Trans context="take out of a project">Remove</Trans>
        </Button>
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
          <ErrorText>{failure}</ErrorText>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel />
          <Button
            errorText={t`Not taken out`}
            loadingText={t`Taking out`}
            onClick={async () => {
              await asking.answer(takeOut);
            }}
            size="sm"
            variant="destructive"
          >
            <Trans>Take out</Trans>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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

/** The project's items, read a page at a time, shared by its cards. */
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
 * workflows together: each card shows its own kind of what is read so
 * far, and Show more reads on.
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
  const builds = project.role === "builder";
  const items = pages.all.filter(({ type }) => type === kind);
  const foot =
    pages.more || pages.failure !== undefined ? (
      <div {...stylex.props(styles.foot)}>
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
    ) : null;
  if (items.length === 0) {
    return (
      <>
        <Empty size="sm">
          <EmptyHeader>
            <EmptyDescription>
              <Trans>Nothing in it that you can open.</Trans>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
        {foot}
      </>
    );
  }
  return (
    <>
      <ItemGroup>
        {items.map((item, index) => (
          <Fragment key={`${item.type}:${item.id}`}>
            {index === 0 ? null : <ItemSeparator />}
            <Item size="sm">
              <ItemMedia variant="icon">
                <Icon
                  icon={
                    item.type === "app" ? LayoutDashboardIcon : WorkflowIcon
                  }
                />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  <ItemLink item={item} />
                </ItemTitle>
                <ItemDescription>
                  <SharedWords role={item.sharedAs} />
                </ItemDescription>
              </ItemContent>
              {builds ? (
                <ItemActions>
                  <RemoveItem item={item} project={project} />
                </ItemActions>
              ) : null}
            </Item>
          </Fragment>
        ))}
      </ItemGroup>
      {foot}
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
  const { t } = useLingui();
  const navigate = useNavigate();
  const { failure, run } = useCoreAction();
  const [working, setWorking] = useState(false);
  const projectName = project.name;
  const who = formatList(namesInProject(project));
  const remove = async (): Promise<void> => {
    setWorking(true);
    const done = await run(async (session) => {
      await session.projects.remove(project.id);
      return true;
    }).finally(() => {
      setWorking(false);
    });
    if (done !== true) {
      throw new Error("The project wasn't deleted.");
    }
    await navigate({ to: "/projects" });
  };
  return (
    <AlertDialog
      onOpenChange={(next, details) => {
        if (working) {
          details.cancel();
          return;
        }
        onOpenChange(next);
      }}
      open={open}
    >
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
          <ErrorText>{failure}</ErrorText>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel />
          <Button
            errorText={t`Couldn't delete`}
            loadingText={t`Deleting`}
            onClick={remove}
            size="sm"
            variant="destructive"
          >
            <Trans>Delete project</Trans>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/**
 * A kind the project has nothing of yet: one quiet row inviting the first
 * one, in place of an empty card.
 */
const QuietKind = ({
  icon,
  children,
  action,
}: {
  icon: IconData;
  children: ReactNode;
  action?: ReactNode;
}) => (
  // Outlined, so it shows in dark as in light; its icon level with its sentence.
  <Item size="sm" variant="outline">
    <ItemMedia align="center">
      <Icon icon={icon} />
    </ItemMedia>
    <ItemContent>
      <ItemDescription>{children}</ItemDescription>
    </ItemContent>
    {action === undefined ? null : <ItemActions>{action}</ItemActions>}
  </Item>
);

/** One kind's card: its title, its action at the head's end, its rows. */
const KindCard = ({
  title,
  action,
  children,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) => (
  <Card asChild size="sm">
    <section>
      <CardHeader>
        <CardTitle level={2}>{title}</CardTitle>
        {action === undefined ? null : <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent flush>{children}</CardContent>
    </section>
  </Card>
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
      <DropdownMenuTrigger asChild>
        <Button aria-label={t`More for ${title}`} size="icon" variant="outline">
          <Icon icon={EllipsisIcon} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem icon={PencilIcon} onSelect={onChange}>
          {t({ message: "Change", context: "change the project: a menu item" })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          icon={TrashIcon}
          onSelect={onDelete}
          variant="destructive"
        >
          <Trans>Delete</Trans>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** A project's page, for someone in it. */
export const ProjectView = ({
  project,
  chats,
  identity,
}: {
  project: Project;
  /** The person's own chats in it. */
  chats: readonly ChatSummary[];
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
  const projectName = project.name;
  // Each kind's Add says what it adds to, as two of them stand on the page.
  const fileItem = (label: string) =>
    builds ? (
      <FileItemDialog aria-label={label} project={project} />
    ) : undefined;
  const addApp = fileItem(t`Add an App to ${projectName}`);
  const addWorkflow = fileItem(t`Add a workflow to ${projectName}`);
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
            <div {...stylex.props(styles.actions)}>
              <ProjectPeopleStack project={project} />
              {builds ? (
                <ProjectMenu
                  onChange={() => {
                    setEditing(true);
                  }}
                  onDelete={() => {
                    setDeleting(true);
                  }}
                  project={project}
                />
              ) : null}
              {makes ? (
                <Button asChild variant="outline">
                  <RouterLink
                    search={{ make: "app", project: project.id }}
                    to="/"
                  >
                    <Icon icon={PlusIcon} />
                    <Trans>Make something</Trans>
                  </RouterLink>
                </Button>
              ) : null}
            </div>
          }
          clamp
          description={
            project.description === "" ? undefined : project.description
          }
          title={
            // The project's own icon before its name, as its row in the list has it.
            <span {...stylex.props(styles.named)}>
              <IconTile
                icon={projectIconShapes[project.icon]}
                variant="tinted"
              />
              <span {...stylex.props(styles.name)}>{project.name}</span>
            </span>
          }
        />
        {apps === 0 ? (
          <QuietKind action={addApp} icon={LayoutDashboardIcon}>
            <Trans>No Apps in it yet.</Trans>
          </QuietKind>
        ) : (
          <KindCard action={addApp} title={<Trans>Apps</Trans>}>
            <Items kind="app" pages={pages} project={project} />
          </KindCard>
        )}
        {workflows === 0 ? (
          <QuietKind action={addWorkflow} icon={WorkflowIcon}>
            <Trans>No workflows in it yet.</Trans>
          </QuietKind>
        ) : (
          <KindCard action={addWorkflow} title={<Trans>Workflows</Trans>}>
            <Items kind="workflow" pages={pages} project={project} />
          </KindCard>
        )}
        {chats.length === 0 ? (
          <QuietKind
            action={<AddChat filed={chats} project={project} />}
            icon={MessageCircleIcon}
          >
            <Trans>
              None of your chats are in it. Only you see the chats you put here.
            </Trans>
          </QuietKind>
        ) : (
          <KindCard
            action={<AddChat filed={chats} project={project} />}
            title={<Trans>Your chats</Trans>}
          >
            <ProjectChatList chats={chats} />
          </KindCard>
        )}
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
