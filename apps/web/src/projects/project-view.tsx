import type { AppOverview } from "@grasp-os/shared/apps";
import type { ChatSummary } from "@grasp-os/shared/chat";
import type {
  Project,
  ProjectConnection,
  ProjectConnections as ProjectConnectionsList,
  ProjectItem,
  ProjectRole,
} from "@grasp-os/shared/projects";
import { canBuild } from "@grasp-os/shared/roles";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
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
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { Badge } from "@grasp-os/ui/components/badge";
import { BrandIcon } from "@grasp-os/ui/components/brand-icon";
import { Button } from "@grasp-os/ui/components/button";
import { Container } from "@grasp-os/ui/components/container";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { Heading } from "@grasp-os/ui/components/heading";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Link as TextLink } from "@grasp-os/ui/components/link";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import { TabsLink, TabsNav } from "@grasp-os/ui/components/tabs";
import { Text } from "@grasp-os/ui/components/text";
import {
  EllipsisIcon,
  Icon,
  LayoutDashboardIcon,
  MessageCircleIcon,
  MinusIcon,
  PlusIcon,
  SettingsIcon,
  TrashIcon,
  UserPlusIcon,
  UsersIcon,
  WorkflowIcon,
} from "@grasp-os/ui/lib/icons";
import { size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { AppCardGrid } from "../apps/app-card/app-card.tsx";
import { OneApp } from "../apps/apps-overview.tsx";
import type { Viewer } from "../apps/apps-overview.tsx";
import { changeThenRefresh } from "../change-then-refresh.ts";
import { brands } from "../connections/brands.ts";
import type { Brand } from "../connections/brands.ts";
import { ErrorText } from "../error-text.tsx";
import {
  formatDayMonth,
  formatList,
  formatNumber,
  formatTime,
} from "../format.ts";
import { pageText } from "../frame/page-text.ts";
import { Page } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { roleLabel } from "../labels.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useHeldDialog } from "../workflows/held-dialog.ts";
import { stateOf } from "../workflows/overview.ts";
import type { OverviewRow, WorkflowState } from "../workflows/overview.ts";
import { EmptyLine } from "./empty-line.tsx";
import { FileItemDialog } from "./file-item-dialog.tsx";
import { AddChat, ProjectChatList } from "./project-chats.tsx";
import { ProjectDialog } from "./project-dialog.tsx";
import { usePages } from "./project-pages.ts";
import { namesInProject } from "./project-people-names.ts";
import { ProjectPeople } from "./project-people.tsx";
import { WorkflowStateIcon } from "./state-icon.tsx";

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
  body: { display: "flex", flexDirection: "column", gap: space["8"] },
  head: { display: "flex", flexDirection: "column", gap: space["4"] },
  actions: { display: "flex", alignItems: "center", gap: space["1"] },
  chips: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  chip: { display: "inline-flex", alignItems: "center", gap: space["1"] },
  failing: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["3"],
  },
  failingWords: { flexGrow: 1, flexBasis: "20rem", minWidth: 0 },
  section: { display: "flex", flexDirection: "column", gap: space["3"] },
  sectionHead: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space["3"],
    minHeight: size.avatarSm,
  },
  // A row's figure keeps its line: the name gives way first.
  detail: { flexShrink: 0, whiteSpace: "nowrap" },
});

/** An item's link: to its App or workflow page. */
const ItemLink = ({ item }: { item: ProjectItem }) =>
  item.type === "app" ? (
    <TextLink asChild>
      <Link params={{ app: item.id }} to="/apps/$app">
        {item.name}
      </Link>
    </TextLink>
  ) : (
    <TextLink asChild>
      <Link params={{ workflow: item.id }} to="/workflows/$workflow">
        {item.name}
      </Link>
    </TextLink>
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
  const dialog = useHeldDialog();
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
      // The dialog stays open, with core's reason in it.
      throw new Error("It wasn't taken out.");
    }
  };
  return (
    <>
      <AlertDialog onOpenChange={dialog.handleOpenChange} open={dialog.open}>
        <AlertDialogTrigger asChild>
          <Button
            aria-label={t`Take ${itemName} out of the project`}
            size="sm"
            variant="ghost"
          >
            <Icon icon={MinusIcon} />
            {t({ message: "Remove", context: "take out of a project" })}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t`Take ${itemName} out of ${projectName}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {item.sharedAs === null
                ? t`It isn’t shared with the project, so nobody loses access. It isn’t deleted.`
                : t`It stops being shared with everyone in the project: ${who} lose access, unless it is shared with them another way. It isn’t deleted.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* Why it wasn't taken out, in the question the person is in. */}
          <ErrorText>{failure}</ErrorText>
          <AlertDialogFooter>
            <AlertDialogCancel />
            <Button
              errorText={t`Not taken out`}
              loadingText={t`Taking out`}
              onClick={async () => {
                await dialog.hold(takeOut);
              }}
              variant="destructive"
            >
              {t`Take out`}
            </Button>
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
            <ItemMedia variant="default">
              <Icon
                icon={item.type === "app" ? LayoutDashboardIcon : WorkflowIcon}
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
        ))}
      </ItemGroup>
      {pages.more ? (
        <Button
          disabled={pages.busy}
          onClick={() => {
            void pages.readMore();
          }}
          size="sm"
          variant="outline"
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
  // Held open while it deletes: Escape and Cancel wait for the answer.
  const [working, setWorking] = useState(false);
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
          <AlertDialogTitle>{t`Delete ${projectName}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {project.shared === 0
              ? t`Its apps and workflows aren’t deleted, and nothing in it is shared with the project, so nobody loses access.`
              : t`Its apps and workflows aren’t deleted, but they stop being shared with everyone in it: ${who} lose access to them, unless they are shared with them another way.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ErrorText>{failure}</ErrorText>
        <AlertDialogFooter>
          <AlertDialogCancel />
          <Button
            errorText={t`Couldn't delete`}
            loadingText={t`Deleting`}
            onClick={async () => {
              setWorking(true);
              await remove().finally(() => {
                setWorking(false);
              });
            }}
            variant="destructive"
          >
            {t`Delete project`}
          </Button>
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
      <DropdownMenuTrigger asChild>
        <Button aria-label={t`More for ${title}`} size="icon" variant="outline">
          <Icon icon={EllipsisIcon} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {makes ? (
          <>
            <DropdownMenuItem
              icon={PlusIcon}
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
        <DropdownMenuItem
          icon={TrashIcon}
          onSelect={onDelete}
          variant="destructive"
        >
          {t`Delete`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** Words without case or marks, to compare a provider's id with a brand. */
const plain = (words: string) => words.toLowerCase().replaceAll(/\W/gu, "");

/** The connectors the product has a mark for. */
const brandKeys: readonly Brand[] = ["microsoft", "google"];

/** The product's mark for a connection: by its provider's id, or its catalog name a brand's own ("Microsoft 365"). */
const brandOf = (id: string, name: string): Brand | undefined =>
  brandKeys.find((key) => plain(key) === plain(id)) ??
  brandKeys.find((key) => plain(name).startsWith(plain(brands[key].name))) ??
  brandKeys.find((key) => plain(key) === plain(id.split("-")[0] ?? ""));

/** A connection's name: the brand's name where the product has its mark, else core's. */
const connectionName = ({ provider, name }: ProjectConnection): string => {
  const brand = brandOf(provider, provider);
  return brand === undefined ? name : brands[brand].name;
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
              <Badge variant="destructive">{words}</Badge>
            ) : (
              <Badge variant="outline">
                <span {...stylex.props(styles.chip)}>
                  {brand === undefined ? null : (
                    <BrandIcon
                      decorative
                      logo={brands[brand].logo}
                      name={brands[brand].name}
                      size="xs"
                    />
                  )}
                  {words}
                </span>
              </Badge>
            )}
          </li>
        );
      })}
      {unseen === 0 ? null : (
        <li>
          <Badge variant="outline">
            {t({
              message: `${more} more`,
              context: "connections the person can't see",
            })}
          </Badge>
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
        appearance="subtle"
        style={styles.failingWords}
        variant="destructive"
      >
        <AlertTitle>{t`${name} stopped letting Grasp in`}</AlertTitle>
        <AlertDescription>
          {builds
            ? t`Reconnect it so the Apps and workflows that use it work again.`
            : t`Ask ${owner} to reconnect it.`}
        </AlertDescription>
      </Alert>
      {builds ? (
        <Button asChild size="sm" variant="outline">
          <Link to="/connectors">{t`Reconnect`}</Link>
        </Button>
      ) : null}
    </div>
  );
};

/**
 * A section title inside the page, in the smallest heading; with `count`,
 * how many it holds beside it, small and quiet, inside the heading so the
 * list it names is named with it (#2503's frame/page.tsx SectionTitle).
 */
const SectionTitle = ({
  children,
  count,
  id,
}: {
  children: ReactNode;
  count?: string;
  id?: string;
}) => (
  <Heading level={2} size="xs" {...(id === undefined ? {} : { id })}>
    {children}
    {count === undefined ? null : (
      <>
        {" "}
        <Text as="span" color="muted" size="xs">
          {count}
        </Text>
      </>
    )}
  </Heading>
);

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
    <TextLink asChild>
      <Link
        params={{ projectId: project.id }}
        search={{ tab }}
        to="/projects/$projectId"
      >
        {t`View all`}
      </Link>
    </TextLink>
  );
};

/** A row's figure at its end, muted; it keeps its line and the name gives way. */
const Figure = ({ children }: { children: ReactNode }) => (
  <span {...stylex.props(styles.detail)}>
    <Text as="span" size="sm" color="muted">
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
    <Item asChild size="sm">
      <Link params={{ workflow: item.id }} to="/workflows/$workflow">
        <ItemMedia>
          {state === undefined ? (
            <Icon icon={WorkflowIcon} />
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
      </Link>
    </Item>
  );
};

/** A chat's row: its title, and when it last had a message. */
const ChatRow = ({ chat }: { chat: ChatSummary }) => (
  <Item asChild size="sm">
    <Link params={{ chatId: chat.id }} to="/chats/$chatId">
      <ItemMedia variant="default">
        <Icon icon={MessageCircleIcon} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{chat.title}</ItemTitle>
      </ItemContent>
      <ItemActions>
        <Figure>{whenOf(chat.lastAt)}</Figure>
      </ItemActions>
    </Link>
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
        <Icon icon={UsersIcon} />
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
  <Button asChild size="sm" variant="outline">
    <Link search={{ make: kind, project: project.id }} to="/">
      <Icon icon={PlusIcon} />
      {children}
    </Link>
  </Button>
);

/** The overview's Apps: three as cards, or its empty line. */
const AppsPart = ({
  project,
  makes,
  apps: listed,
  viewer,
}: {
  project: Project;
  makes: boolean;
  /** The Apps the person can open, as the Apps page reads them. */
  apps: readonly AppOverview[];
  viewer: Viewer;
}) => {
  const { t } = useLingui();
  const byId = new Map<string, AppOverview>(
    listed.map((each) => [each.app.id, each])
  );
  const apps = project.items.flatMap(({ type, id }) => {
    const overview = type === "app" ? byId.get(id) : undefined;
    return overview === undefined ? [] : [overview];
  });
  return (
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
          icon={LayoutDashboardIcon}
        >
          {t`No Apps yet, such as a debtor overview.`}
        </EmptyLine>
      ) : null}
      {apps.length === 0 ? null : (
        <AppCardGrid empty={null}>
          {apps.slice(0, slice).map((overview) => (
            <OneApp key={overview.app.id} overview={overview} viewer={viewer} />
          ))}
        </AppCardGrid>
      )}
    </section>
  );
};

/** The overview: three of each part, each with View all, or its empty line. */
const Overview = ({
  project,
  chats,
  workflows,
  makes,
  viewer,
  apps,
  askOwner,
}: {
  project: Project;
  chats: readonly ChatSummary[];
  workflows: readonly OverviewRow[];
  makes: boolean;
  viewer: Viewer;
  /** The Apps the person can open, as the Apps page reads them. */
  apps: readonly AppOverview[];
  /** The page asks the owner to set the project up: its empty Workflows and Apps say nothing more. */
  askOwner: boolean;
}) => {
  const { t } = useLingui();
  const builds = project.role === "builder";
  const rows = new Map(workflows.map((row) => [row.id, row]));
  const filedWorkflows = project.items.filter(
    ({ type }) => type === "workflow"
  );
  const owner = project.owner.name ?? t`the owner`;
  const people = project.members;
  const ownerIsYou = project.owner.id === viewer.userId;
  return (
    <>
      {askOwner ? null : (
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
              icon={WorkflowIcon}
            >
              {t`No workflows yet, such as booking invoices.`}
            </EmptyLine>
          ) : null}
          {filedWorkflows.length === 0 ? null : (
            <ItemGroup separated>
              {filedWorkflows.slice(0, slice).map((item) => (
                <WorkflowRow
                  item={item}
                  key={item.id}
                  row={rows.get(item.id)}
                />
              ))}
            </ItemGroup>
          )}
        </section>
      )}
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
            icon={MessageCircleIcon}
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
      {askOwner ? null : (
        <AppsPart apps={apps} makes={makes} project={project} viewer={viewer} />
      )}
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
                <Button asChild size="sm" variant="outline">
                  <Link
                    params={{ projectId: project.id }}
                    search={{ tab: "people" }}
                    to="/projects/$projectId"
                  >
                    <Icon icon={UserPlusIcon} />
                    {t`Invite`}
                  </Link>
                </Button>
              ) : undefined
            }
            icon={UsersIcon}
          >
            {ownerIsYou ? t`Only you so far.` : t`Only ${owner} so far.`}
          </EmptyLine>
        ) : (
          <ItemGroup separated>
            <PersonRow
              key="owner"
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
          <EmptyLine icon={MessageCircleIcon}>
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
        <EmptyLine icon={apps ? LayoutDashboardIcon : WorkflowIcon}>
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
    <TabsNav aria-label={t`Project`}>
      {projectTabs.map((each) => (
        <TabsLink asChild current={each === tab} key={each}>
          <Link
            params={{ projectId: project.id }}
            search={each === "overview" ? {} : { tab: each }}
            to="/projects/$projectId"
          >
            {names[each]}
          </Link>
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
  apps,
  tab = "overview",
}: {
  project: Project;
  /** The person's own chats in it. */
  chats: readonly ChatSummary[];
  connections: ProjectConnectionsList;
  /** The workflows the person has a role in, as the Workflows page reads them: how each stands. */
  workflows: readonly OverviewRow[];
  identity: Viewer;
  /** The Apps the person can open, as the Apps page reads them. */
  apps: readonly AppOverview[];
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
  const askOwner =
    !builds && project.counts.apps === 0 && project.counts.workflows === 0;
  return (
    <>
      <SiteHeader
        crumbs={[
          { label: t`Projects`, to: "/projects" },
          { label: project.name },
        ]}
      />
      <Page>
        <div {...stylex.props(pageText.text)}>
          <Container align="center" size="lg">
            <div {...stylex.props(styles.body)}>
              <div {...stylex.props(styles.head)}>
                <PageHeader
                  actions={
                    builds ? (
                      <span {...stylex.props(styles.actions)}>
                        <Button
                          onClick={() => {
                            setEditing(true);
                          }}
                          variant="ghost"
                        >
                          <Icon icon={SettingsIcon} />
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
                {askOwner ? (
                  <EmptyLine icon={UsersIcon}>
                    {t`Ask ${owner} to set this project up.`}
                  </EmptyLine>
                ) : null}
                <ProjectTabs project={project} tab={tab} />
              </div>
              {tab === "overview" ? (
                <Overview
                  askOwner={askOwner}
                  chats={chats}
                  makes={makes}
                  project={project}
                  apps={apps}
                  viewer={identity}
                  workflows={workflows}
                />
              ) : (
                <TabView
                  chats={chats}
                  pages={pages}
                  project={project}
                  tab={tab}
                />
              )}
            </div>
          </Container>
        </div>
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
