import type { ChatSummary } from "@grasp-os/shared/chat";
import type {
  Project,
  ProjectConnection,
  ProjectConnections as ProjectConnectionsList,
  ProjectItem,
  ProjectRole,
} from "@grasp-os/shared/projects";
import { canBuild } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { brandOf } from "../connections/provider-mark.tsx";
import { ErrorText } from "../error-text.tsx";
import {
  formatDayMonth,
  formatList,
  formatNumber,
  formatTime,
} from "../format.ts";
import { PageHeading, SectionTitle } from "../frame/page.tsx";
import { RouterLink } from "../frame/router-link.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Avatar, AvatarFallback } from "../grasp/avatar/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { BrandIcon, brands } from "../grasp/brand-icon/index.ts";
import { Button } from "../grasp/button/index.ts";
import { CardLink, CardMedia, CardTitle } from "../grasp/card/index.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import {
  AppPanels,
  Chat,
  Icon,
  Minus,
  More,
  People,
  Plus,
  Settings,
  Trash,
  UserAdd,
  Workflow,
} from "../grasp/icons/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { PageColumn } from "../grasp/page-column/index.ts";
import { TabsLink, TabsNav } from "../grasp/tabs/index.ts";
import { Tag } from "../grasp/tag/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { roleLabel } from "../labels.ts";
import { useCoreAction } from "../use-core-action.ts";
import { stateOf } from "../workflows/overview.ts";
import type { OverviewRow, WorkflowState } from "../workflows/overview.ts";
import { WorkflowStateIcon } from "../workflows/state-icon.tsx";
import { EmptyLine } from "./empty-line.tsx";
import { FileItemDialog } from "./file-item-dialog.tsx";
import { AddChat, ProjectChatList } from "./project-chats.tsx";
import { ProjectDialog } from "./project-dialog.tsx";
import { AppPageDrawing } from "./project-drawings.tsx";
import { usePages } from "./project-pages.ts";
import { namesInProject } from "./project-people-names.ts";
import { ProjectPeople } from "./project-people.tsx";

// A project's page (Project A, "Glass", Ruben's pick of 23 Nov): its name
// with Settings and "…" for its builders, the connections its Apps and
// workflows use as chips, then the tabs Overview, Chats, Workflows, Apps
// and People. The overview shows three of each part with View all, which
// opens its tab: workflows, chats and people as rows, Apps as cards with a
// drawing of a page. A part with nothing in it says so on one dashed line,
// with its one action for whoever may take it. Knowledge in a project, a
// project's own pause and when an App was last opened wait on core
// (handoffs/core-needs.md 84 to 86), so the page leaves them out. As drawn,
// the project's description stands only in its Settings.

/** The project page's tabs, by the name the address carries. */
export const projectTabs = [
  "overview",
  "chats",
  "workflows",
  "apps",
  "people",
] as const;
export type ProjectTab = (typeof projectTabs)[number];

/** The tab an address names; none (the overview) for anything else. */
export const projectTabOf = (value: unknown): ProjectTab | undefined =>
  projectTabs.find((tab) => tab === value && tab !== "overview");

/** How many of each part the overview shows. */
const slice = 3;

const styles = stylex.create({
  body: { display: "flex", flexDirection: "column", gap: grasp.space8 },
  head: { display: "flex", flexDirection: "column", gap: grasp.space4 },
  actions: { display: "flex", alignItems: "center", gap: grasp.space1 },
  chips: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  chip: { display: "inline-flex", alignItems: "center", gap: grasp.space1 },
  failing: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space3,
  },
  failingWords: { flexGrow: 1, flexBasis: "20rem", minWidth: 0 },
  section: { display: "flex", flexDirection: "column", gap: grasp.space3 },
  sectionHead: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: grasp.space3,
    minHeight: grasp.avatarSm,
  },
  // Three across; on a phone one card and the edge of the next, sideways,
  // with room around so the cards' edges and focus ring aren't cut.
  cards: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(3, minmax(0, 1fr))",
      [media.belowPhone]: "none",
    },
    gridAutoFlow: { default: "row", [media.belowPhone]: "column" },
    gridAutoColumns: { default: null, [media.belowPhone]: "78%" },
    gap: grasp.space3,
    overflowX: { default: "visible", [media.belowPhone]: "auto" },
    scrollSnapType: { default: null, [media.belowPhone]: "x mandatory" },
    padding: { default: 0, [media.belowPhone]: grasp.space1 },
    scrollbarWidth: "none",
  },
  card: { display: "grid", minWidth: 0, scrollSnapAlign: "start" },
  // A row's figure keeps its line: the name gives way first.
  detail: { flexShrink: 0, whiteSpace: "nowrap" },
});

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
  const { failure, run } = useCoreAction();
  const itemName = item.name;
  const projectName = project.name;
  const who = formatList(namesInProject(project));
  const takeOut = async (): Promise<void> => {
    const done = await run(async (session) => {
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
    });
    if (done !== true) {
      // The dialog stays open, and core's reason shows under the row.
      throw new Error("It wasn't taken out.");
    }
  };
  return (
    <>
      <AlertDialog>
        <AlertDialogTrigger
          aria-label={t`Take ${itemName} out of the project`}
          icon={Minus}
          size="sm"
          variant="ghost"
        >
          {t({ message: "Remove", context: "take out of a project" })}
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>
            {t`Take ${itemName} out of ${projectName}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {item.sharedAs === null
              ? t`It isn’t shared with the project, so nobody loses access. It isn’t deleted.`
              : t`It stops being shared with everyone in the project: ${who} lose access, unless it is shared with them another way. It isn’t deleted.`}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel />
            <AlertDialogAction
              action={takeOut}
              failedLabel={t`Not taken out`}
              variant="danger"
              workingLabel={t`Taking out`}
            >
              {t`Take out`}
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
 * Every item of one kind in the project that the person may open, a page
 * at a time, with Remove for its builders: a tab's list. Core pages Apps
 * and workflows together: each tab shows its own kind of what is read so
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
  const { t } = useLingui();
  const builds = project.role === "builder";
  const items = pages.all.filter(({ type }) => type === kind);
  return (
    <>
      <ItemGroup separated>
        {items.map((item) => (
          <Item key={`${item.type}:${item.id}`} size="sm">
            <ItemMedia
              icon={item.type === "app" ? AppPanels : Workflow}
              iconLook="inline"
            />
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
  const { t } = useLingui();
  const navigate = useNavigate();
  const { failure, run } = useCoreAction();
  const projectName = project.name;
  const who = formatList(namesInProject(project));
  const remove = async (): Promise<void> => {
    const done = await run(async (session) => {
      await session.projects.remove(project.id);
      return true;
    });
    if (done !== true) {
      throw new Error("The project wasn't deleted.");
    }
    await navigate({ to: "/projects" });
  };
  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogTitle>{t`Delete ${projectName}?`}</AlertDialogTitle>
        <AlertDialogDescription>
          {project.shared === 0
            ? t`Its apps and workflows aren’t deleted, and nothing in it is shared with the project, so nobody loses access.`
            : t`Its apps and workflows aren’t deleted, but they stop being shared with everyone in it: ${who} lose access to them, unless they are shared with them another way.`}
        </AlertDialogDescription>
        <ErrorText>{failure}</ErrorText>
        <AlertDialogFooter>
          <AlertDialogCancel />
          <AlertDialogAction
            action={remove}
            failedLabel={t`Couldn't delete`}
            variant="danger"
            workingLabel={t`Deleting`}
          >
            {t`Delete project`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/** The page's "…", for the project's builders: make something in it, or delete it. */
const ProjectMenu = ({
  project,
  makes,
  onDelete,
}: {
  project: Project;
  makes: boolean;
  onDelete: () => void;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const title = project.name;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={t`More for ${title}`} icon={More} />
      <DropdownMenuContent align="end">
        {makes ? (
          <>
            <DropdownMenuItem
              icon={Plus}
              onSelect={() => {
                void navigate({
                  to: "/",
                  search: { make: "app", project: project.id },
                });
              }}
            >
              {t`Make something`}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem icon={Trash} onSelect={onDelete} variant="danger">
          {t`Delete`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** A connection's name: the library's brand name where it has one, else core's. */
const connectionName = ({ provider }: ProjectConnection): string => {
  const brand = brandOf(provider, provider);
  return brand === undefined ? provider : brands[brand].name;
};

/** Whether a connection has stopped letting Grasp in. */
const stopped = ({ status }: ProjectConnection): boolean => status !== "active";

/**
 * What the project's Apps and workflows are connected to, as chips under
 * its name, one per app with how many accounts of it; one that stopped
 * letting Grasp in in the danger tone. Those the person may not see are
 * counted at the end.
 */
const ConnectionChips = ({
  connections: { connections, unseen },
}: {
  connections: ProjectConnectionsList;
}) => {
  const { t } = useLingui();
  const byName = Map.groupBy(connections, connectionName);
  const more = formatNumber(unseen);
  if (byName.size === 0 && unseen === 0) {
    return null;
  }
  return (
    <ul aria-label={t`Connections`} {...stylex.props(styles.chips)}>
      {[...byName].map(([name, accounts]) => {
        const brand = brandOf(accounts[0]?.provider ?? name, name);
        const count = formatNumber(accounts.length);
        const words = accounts.length > 1 ? t`${name} · ${count}` : name;
        return (
          <li key={name}>
            {accounts.some((account) => stopped(account)) ? (
              <Badge tone="danger">{words}</Badge>
            ) : (
              <Tag variant="outline">
                <span {...stylex.props(styles.chip)}>
                  {brand === undefined ? null : (
                    <BrandIcon brand={brand} decorative size="xs" />
                  )}
                  {words}
                </span>
              </Tag>
            )}
          </li>
        );
      })}
      {unseen === 0 ? null : (
        <li>
          <Tag variant="outline">
            {t({
              message: `${more} more`,
              context: "connections the person can't see",
            })}
          </Tag>
        </li>
      )}
    </ul>
  );
};

/**
 * The first connection that stopped letting Grasp in, with what to do: its
 * builders reconnect it in Integrations, anyone else asks the project's
 * owner.
 */
const StoppedConnection = ({
  connections,
  builds,
  owner,
}: {
  connections: readonly ProjectConnection[];
  builds: boolean;
  owner: string;
}) => {
  const { t } = useLingui();
  const first = connections.find((connection) => stopped(connection));
  if (first === undefined) {
    return null;
  }
  const name = connectionName(first);
  return (
    <div {...stylex.props(styles.failing)}>
      <Alert
        layout={styles.failingWords}
        quiet
        title={t`${name} stopped letting Grasp in`}
        tone="danger"
      >
        {builds
          ? t`Reconnect it so the Apps and workflows that use it work again.`
          : t`Ask ${owner} to reconnect it.`}
      </Alert>
      {builds ? (
        <Button render={<Link to="/integrations" />} size="sm" variant="quiet">
          {t`Reconnect`}
        </Button>
      ) : null}
    </div>
  );
};

/** A part's title with how many it holds, and its one link or action at the end. */
const SectionHead = ({
  id,
  title,
  count,
  end,
}: {
  id: string;
  title: string;
  count?: number;
  end?: ReactNode;
}) => (
  <div {...stylex.props(styles.sectionHead)}>
    <SectionTitle
      {...(count === undefined || count === 0
        ? {}
        : { count: formatNumber(count) })}
      id={id}
    >
      {title}
    </SectionTitle>
    {end}
  </div>
);

/** View all: the part's own tab. */
const ViewAll = ({ project, tab }: { project: Project; tab: ProjectTab }) => {
  const { t } = useLingui();
  return (
    <RouterLink
      params={{ projectId: project.id }}
      search={{ tab }}
      to="/projects/$projectId"
    >
      {t`View all`}
    </RouterLink>
  );
};

/** A row's figure at its end, muted; it keeps its line and the name gives way. */
const Figure = ({ children }: { children: ReactNode }) => (
  <span {...stylex.props(styles.detail)}>
    <Text element="span" size="sm" tone="muted">
      {children}
    </Text>
  </span>
);

/** When something happened, short: the time alone today, the day before that. */
const whenOf = (at: string): string =>
  new Date(at).toDateString() === new Date().toDateString()
    ? formatTime(at)
    : formatDayMonth(at);

/** What a workflow's row says at its end, by how it stands. */
const WorkflowFigure = ({
  row,
  state,
}: {
  row: OverviewRow;
  state: WorkflowState;
}) => {
  const { t } = useLingui();
  const failed = formatNumber(row.failed);
  const waiting = formatNumber(row.waiting);
  const runs = formatNumber(row.runs ?? 0);
  const since = row.lastRun === null ? "" : whenOf(row.lastRun);
  if (state === "failing") {
    return t`${failed} failed`;
  }
  if (state === "waiting") {
    return t`${waiting} waiting`;
  }
  if (state === "paused") {
    return t`Paused`;
  }
  if (row.lastRun === null) {
    return t`No runs yet`;
  }
  if ((row.runs ?? 0) > 0) {
    return row.role === "user"
      ? t`${runs} of yours done this week`
      : t`${runs} done this week`;
  }
  return t`Last run ${since}`;
};

/** A workflow's row: how it stands, its name, and what it did lately. */
const WorkflowRow = ({
  item,
  row,
}: {
  item: ProjectItem;
  row: OverviewRow | undefined;
}) => {
  const state = row === undefined ? undefined : stateOf(row);
  return (
    <Item
      render={<Link params={{ workflow: item.id }} to="/workflows/$workflow" />}
      size="sm"
    >
      <ItemMedia>
        {state === undefined ? (
          <Icon icon={Workflow} />
        ) : (
          <WorkflowStateIcon state={state} />
        )}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{row?.name ?? item.name}</ItemTitle>
      </ItemContent>
      {row === undefined || state === undefined ? null : (
        <ItemActions>
          <Figure>
            <WorkflowFigure row={row} state={state} />
          </Figure>
        </ItemActions>
      )}
    </Item>
  );
};

/** An App's card: a drawing of a page, and its name. */
const AppCard = ({ item }: { item: ProjectItem }) => (
  <li {...stylex.props(styles.card)}>
    <CardLink
      render={<Link params={{ app: item.id }} to="/apps/$app" />}
      variant="soft"
    >
      <CardMedia>
        <AppPageDrawing />
      </CardMedia>
      <CardTitle>{item.name}</CardTitle>
    </CardLink>
  </li>
);

/** A chat's row: its title, and when it last had a message. */
const ChatRow = ({ chat }: { chat: ChatSummary }) => (
  <Item
    render={<Link params={{ chatId: chat.id }} to="/chats/$chatId" />}
    size="sm"
  >
    <ItemMedia icon={Chat} iconLook="inline" />
    <ItemContent>
      <ItemTitle>{chat.title}</ItemTitle>
    </ItemContent>
    <ItemActions>
      <Figure>{whenOf(chat.lastAt)}</Figure>
    </ItemActions>
  </Item>
);

/** Someone in the project: their name and their role in it. */
const PersonRow = ({
  name,
  team,
  role,
}: {
  name: string;
  team: boolean;
  role: string;
}) => (
  <Item size="sm">
    <ItemMedia>
      {team ? (
        <Icon icon={People} />
      ) : (
        <Avatar decorative name={name} size="xs">
          <AvatarFallback />
        </Avatar>
      )}
    </ItemMedia>
    <ItemContent>
      <ItemTitle>{name}</ItemTitle>
    </ItemContent>
    <ItemActions>
      <Figure>{role}</Figure>
    </ItemActions>
  </Item>
);

/** A make link: a new chat that makes an App or a workflow in the project. */
const MakeButton = ({
  project,
  kind,
  children,
}: {
  project: Project;
  kind: "app" | "workflow";
  children: string;
}) => (
  <Button
    icon={Plus}
    render={<Link search={{ make: kind, project: project.id }} to="/" />}
    size="sm"
    variant="quiet"
  >
    {children}
  </Button>
);

/** The overview: three of each part, each with View all, or its empty line. */
const Overview = ({
  project,
  chats,
  workflows,
  makes,
  userId,
}: {
  project: Project;
  chats: readonly ChatSummary[];
  workflows: readonly OverviewRow[];
  makes: boolean;
  userId: string;
}) => {
  const { t } = useLingui();
  const builds = project.role === "builder";
  const rows = new Map(workflows.map((row) => [row.id, row]));
  const filedWorkflows = project.items.filter(
    ({ type }) => type === "workflow"
  );
  const apps = project.items.filter(({ type }) => type === "app");
  const owner = project.owner.name ?? t`the owner`;
  const people = project.members;
  const ownerIsYou = project.owner.id === userId;
  return (
    <>
      <section
        aria-labelledby="project-workflows"
        {...stylex.props(styles.section)}
      >
        <SectionHead
          count={project.counts.workflows}
          end={
            project.counts.workflows === 0 ? null : (
              <ViewAll project={project} tab="workflows" />
            )
          }
          id="project-workflows"
          title={t`Workflows`}
        />
        {project.counts.workflows === 0 ? (
          <EmptyLine
            action={
              makes ? (
                <MakeButton kind="workflow" project={project}>
                  {t`Make a workflow`}
                </MakeButton>
              ) : undefined
            }
            icon={Workflow}
          >
            {t`No workflows yet, such as booking invoices.`}
          </EmptyLine>
        ) : null}
        {filedWorkflows.length === 0 ? null : (
          <ItemGroup separated>
            {filedWorkflows.slice(0, slice).map((item) => (
              <WorkflowRow item={item} key={item.id} row={rows.get(item.id)} />
            ))}
          </ItemGroup>
        )}
      </section>
      <section
        aria-labelledby="project-chats"
        {...stylex.props(styles.section)}
      >
        <SectionHead
          count={chats.length}
          end={
            chats.length === 0 ? null : (
              <ViewAll project={project} tab="chats" />
            )
          }
          id="project-chats"
          title={t`Your chats`}
        />
        {chats.length === 0 ? (
          <EmptyLine
            action={<AddChat filed={chats} project={project} />}
            icon={Chat}
          >
            {t`None of your chats are in this project yet.`}
          </EmptyLine>
        ) : (
          <ItemGroup separated>
            {chats.slice(0, slice).map((chat) => (
              <ChatRow chat={chat} key={chat.id} />
            ))}
          </ItemGroup>
        )}
      </section>
      <section aria-labelledby="project-apps" {...stylex.props(styles.section)}>
        <SectionHead
          count={project.counts.apps}
          end={
            project.counts.apps === 0 ? null : (
              <ViewAll project={project} tab="apps" />
            )
          }
          id="project-apps"
          title={t`Apps`}
        />
        {project.counts.apps === 0 ? (
          <EmptyLine
            action={
              makes ? (
                <MakeButton kind="app" project={project}>
                  {t`Make an App`}
                </MakeButton>
              ) : undefined
            }
            icon={AppPanels}
          >
            {t`No Apps yet, such as a debtor overview.`}
          </EmptyLine>
        ) : null}
        {apps.length === 0 ? null : (
          <ul {...stylex.props(styles.cards)}>
            {apps.slice(0, slice).map((item) => (
              <AppCard item={item} key={item.id} />
            ))}
          </ul>
        )}
      </section>
      <section
        aria-labelledby="project-people"
        {...stylex.props(styles.section)}
      >
        <SectionHead
          {...(project.moreMembers ? {} : { count: 1 + people.length })}
          end={
            people.length > 0 || project.moreMembers ? (
              <ViewAll project={project} tab="people" />
            ) : null
          }
          id="project-people"
          title={t`People`}
        />
        {people.length === 0 ? (
          <EmptyLine
            action={
              builds ? (
                <Button
                  icon={UserAdd}
                  render={
                    <Link
                      params={{ projectId: project.id }}
                      search={{ tab: "people" }}
                      to="/projects/$projectId"
                    />
                  }
                  size="sm"
                  variant="quiet"
                >
                  {t`Invite`}
                </Button>
              ) : undefined
            }
            icon={People}
          >
            {ownerIsYou ? t`Only you so far.` : t`Only ${owner} so far.`}
          </EmptyLine>
        ) : (
          <ItemGroup separated>
            <PersonRow
              name={project.owner.name ?? project.owner.id}
              role={t({ message: "Owner", context: "a project's owner" })}
              team={false}
            />
            {people.slice(0, slice - 1).map((member) => (
              <PersonRow
                key={`${member.type}:${member.id}`}
                name={member.name ?? member.id}
                role={roleLabel(member.role)}
                team={member.type === "team"}
              />
            ))}
          </ItemGroup>
        )}
      </section>
    </>
  );
};

/** One tab's view: its title with its one action, then its whole list. */
const TabView = ({
  project,
  tab,
  chats,
  pages,
}: {
  project: Project;
  tab: Exclude<ProjectTab, "overview">;
  chats: readonly ChatSummary[];
  pages: ItemPages;
}) => {
  const { t } = useLingui();
  const builds = project.role === "builder";
  const add = builds ? <FileItemDialog project={project} /> : undefined;
  if (tab === "people") {
    return (
      <section aria-labelledby="project-tab" {...stylex.props(styles.section)}>
        <SectionHead id="project-tab" title={t`People`} />
        <ProjectPeople project={project} />
      </section>
    );
  }
  if (tab === "chats") {
    return (
      <section aria-labelledby="project-tab" {...stylex.props(styles.section)}>
        <SectionHead
          end={<AddChat filed={chats} project={project} />}
          id="project-tab"
          title={t`Your chats`}
        />
        {chats.length === 0 ? (
          <EmptyLine icon={Chat}>
            {t`None of your chats are in this project yet.`}
          </EmptyLine>
        ) : (
          <ProjectChatList chats={chats} />
        )}
      </section>
    );
  }
  const apps = tab === "apps";
  const count = apps ? project.counts.apps : project.counts.workflows;
  return (
    <section aria-labelledby="project-tab" {...stylex.props(styles.section)}>
      <SectionHead
        end={add}
        id="project-tab"
        title={apps ? t`Apps` : t`Workflows`}
      />
      {count === 0 && !pages.more ? (
        <EmptyLine icon={apps ? AppPanels : Workflow}>
          {apps
            ? t`No Apps yet, such as a debtor overview.`
            : t`No workflows yet, such as booking invoices.`}
        </EmptyLine>
      ) : (
        <Items
          kind={apps ? "app" : "workflow"}
          pages={pages}
          project={project}
        />
      )}
    </section>
  );
};

/** The page's tabs, each its own address. */
const ProjectTabs = ({
  project,
  tab,
}: {
  project: Project;
  tab: ProjectTab;
}) => {
  const { t } = useLingui();
  const names: Record<ProjectTab, string> = {
    overview: t`Overview`,
    chats: t`Chats`,
    workflows: t`Workflows`,
    apps: t`Apps`,
    people: t`People`,
  };
  return (
    <TabsNav aria-label={t`Project`} variant="segmented">
      {projectTabs.map((each) => (
        <TabsLink
          current={each === tab}
          key={each}
          render={
            <Link
              params={{ projectId: project.id }}
              search={each === "overview" ? {} : { tab: each }}
              to="/projects/$projectId"
            />
          }
        >
          {names[each]}
        </TabsLink>
      ))}
    </TabsNav>
  );
};

/** A project's page, for someone in it. */
export const ProjectView = ({
  project,
  chats,
  connections,
  workflows,
  identity,
  tab = "overview",
}: {
  project: Project;
  /** The person's own chats in it. */
  chats: readonly ChatSummary[];
  connections: ProjectConnectionsList;
  /** The workflows the person has a role in, as the Workflows page reads them: how each stands. */
  workflows: readonly OverviewRow[];
  identity: Pick<Identity, "role" | "userId">;
  tab?: ProjectTab;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const builds = project.role === "builder";
  const makes = builds && canBuild(identity.role);
  const pages = useItemPages(project);
  const owner = project.owner.name ?? t`the owner`;
  const empty = project.counts.apps === 0 && project.counts.workflows === 0;
  return (
    <>
      <SiteHeader
        crumbs={[
          { label: t`Projects`, to: "/projects" },
          { label: project.name },
        ]}
      />
      <PageColumn align="center" measure="page">
        <div {...stylex.props(styles.body)}>
          <div {...stylex.props(styles.head)}>
            <PageHeading
              action={
                builds ? (
                  <span {...stylex.props(styles.actions)}>
                    <Button
                      icon={Settings}
                      onClick={() => {
                        setEditing(true);
                      }}
                      variant="ghost"
                    >
                      {t`Settings`}
                    </Button>
                    <ProjectMenu
                      makes={makes}
                      onDelete={() => {
                        setDeleting(true);
                      }}
                      project={project}
                    />
                  </span>
                ) : undefined
              }
              title={project.name}
            />
            <ConnectionChips connections={connections} />
            <StoppedConnection
              builds={makes}
              connections={connections.connections}
              owner={owner}
            />
            {!builds && empty ? (
              <EmptyLine icon={People}>
                {t`Ask ${owner} to set this project up.`}
              </EmptyLine>
            ) : null}
            <ProjectTabs project={project} tab={tab} />
          </div>
          {tab === "overview" ? (
            <Overview
              chats={chats}
              makes={makes}
              project={project}
              userId={identity.userId}
              workflows={workflows}
            />
          ) : (
            <TabView chats={chats} pages={pages} project={project} tab={tab} />
          )}
        </div>
      </PageColumn>
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
