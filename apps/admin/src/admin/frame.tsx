// Grasp's admin frame, composed as Grasp Work's (src/frame/ holds the
// parts, as apps/web/src/frame holds the product's), filled with the
// admin's places: Grasp's mark, the search and the fold; the Home | Inbox
// switch, Home listing the admin's places, every organization and the
// labs, the Inbox what needs Grasp; an organization's sections as a level
// of the sidebar while one of its pages is open, as the product's Settings
// is; the staff member at its foot. Readiness stands across the card's top
// until set aside for the session, as the product's AI-key banner does.

import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandList,
} from "@grasp-os/ui/components/command";
import type { CommandItems } from "@grasp-os/ui/components/command";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from "@grasp-os/ui/components/sidebar";
import {
  AudioWaveformIcon,
  BellIcon,
  CircleAlertIcon,
  ClockIcon,
  BuildingIcon,
  ContrastIcon,
  FlaskConicalIcon,
  HouseIcon,
  Icon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  ServerIcon,
  SparklesIcon,
  SunIcon,
  WrenchIcon,
} from "@grasp-os/ui/lib/icons";
import { focusRing } from "@grasp-os/ui/lib/styles";
import { radius } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import {
  Link,
  Outlet,
  useLocation,
  useMatch,
  useMatchRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { Suspense, useEffect, useState, useSyncExternalStore } from "react";

import type { GridRow } from "../clients/grid.ts";
import type { ClientSummary } from "../clients/summary.ts";
import { FrameProfile } from "../frame/profile.tsx";
import { FrameShell } from "../frame/shell.tsx";
import { FrameSidebar } from "../frame/sidebar.tsx";
import type {
  RenderLink,
  SidebarTab,
  SidebarGroupEntry,
  SidebarRow,
  SidebarSection,
} from "../frame/sidebar.tsx";
import { PageLoading } from "./failure.tsx";
import { GraspMark } from "./grasp-mark.ts";
import { needCount, needsOf, summaryNeedsOf } from "./needs.ts";
import type { OrgNeed } from "./needs.ts";
import type { OrgRead } from "./org-reads.ts";
import type { PlatformCounts } from "./platform.ts";
import { ReadinessBanner } from "./readiness-parts.tsx";
import type { Readiness } from "./readiness.ts";
import { sectionGroups, sectionTo, sectionWords } from "./sections.ts";
import type { OrgSection } from "./sections.ts";
import { useSettled } from "./settled.tsx";
import type { Deferred } from "./settled.tsx";
import { organizationOf } from "./views.ts";

/** Where the sidebar keeps, in this browser, whether it is folded. */
const sidebarKey = "grasp.admin.sidebar";

const styles = stylex.create({
  home: { display: "flex", borderRadius: radius.sm, color: "inherit" },
});

export interface Staff {
  name: string;
}

/** A link to one of an organization's sections, in a sidebar row's look. */
const sectionLink = (
  clientId: string,
  section: OrgSection,
  search?: { tab: "contract" }
): RenderLink =>
  function SectionLink(look) {
    return (
      <Link
        {...look}
        // The overview is only itself; a section holds the pages under it.
        activeOptions={{ exact: section === "overview", includeSearch: false }}
        params={{ clientId }}
        search={search}
        to={sectionTo[section]}
      />
    );
  };

/** How many apps a company asked Grasp for, as its summary or, from an older core, its snapshot says. */
const askedOf = (entry: ClientSummary): number => {
  if (entry.state === "answered") {
    return entry.summary.asked ?? 0;
  }
  return entry.state === "older" ? entry.admin.snapshot.asked.length : 0;
};

/** How many things need Grasp, as a row's count; none at 0. */
const needsCount = (needs: number): Partial<SidebarRow> =>
  needs > 0
    ? {
        count: needs,
        countLabel: `${needs} ${needs === 1 ? "thing needs" : "things need"} Grasp`,
      }
    : {};

/**
 * What an organization's row says at its end: how many things need Grasp
 * there; or, while its core isn't read, why, as a mark that leads to its
 * Setup, which says more.
 */
const rowEnd = (
  client: GridRow,
  entry: ClientSummary | undefined,
  needs: number
): Partial<SidebarRow> => {
  if (
    entry === undefined ||
    entry.state === "answered" ||
    entry.state === "older"
  ) {
    return needsCount(needs);
  }
  const words = entry.state === "not_deployed" ? "not deployed" : "unreachable";
  return {
    mark: {
      icon: entry.state === "not_deployed" ? ClockIcon : CircleAlertIcon,
      label: `${client.name}: ${words}. Open its Setup`,
      render: (look) => (
        <Link
          {...look}
          params={{ clientId: client.id }}
          to="/organizations/$clientId/setup"
        />
      ),
    },
  };
};

const homeGroups = ({
  clients,
  organizations,
  platform,
  isAt,
}: {
  clients: readonly GridRow[];
  organizations: Map<string, ClientSummary> | null;
  platform: PlatformCounts;
  isAt: (to: string, fuzzy?: boolean) => boolean;
}): SidebarGroupEntry[] => {
  // Each company's apps asked for, added up: one asked for at two counts
  // twice. A company that doesn't share it (it ended Grasp's staff
  // access) isn't counted; one on a core from before the summary is
  // counted from its snapshot.
  const asked = [...(organizations?.values() ?? [])].reduce(
    (sum, entry) => sum + askedOf(entry),
    0
  );
  const live = clients.filter(({ status }) => status !== "offboarded");
  return [
    {
      id: "places",
      rows: [
        {
          id: "home",
          label: "Home",
          icon: HouseIcon,
          render: (look) => <Link {...look} to="/" />,
          current: isAt("/", false),
        },
        {
          id: "platform",
          label: "Platform",
          icon: ServerIcon,
          render: (look) => <Link {...look} to="/platform" />,
          current: isAt("/platform"),
          ...(platform.needLook > 0
            ? {
                count: platform.needLook,
                countLabel: `${platform.needLook} ${platform.needLook === 1 ? "company needs" : "companies need"} a look`,
              }
            : {}),
        },
        {
          id: "asked",
          label: "Apps asked for",
          icon: WrenchIcon,
          render: (look) => <Link {...look} to="/connectors" />,
          current: isAt("/connectors"),
          ...(asked > 0
            ? {
                count: asked,
                countLabel: `${asked} ${asked === 1 ? "app" : "apps"} asked for`,
              }
            : {}),
        },
      ],
    },
    {
      id: "organizations",
      label: "Organizations",
      landmark: "Organizations",
      collapsible: true,
      count: live.length,
      rows: live.map((client) => {
        const entry = organizations?.get(client.id);
        const needs =
          entry === undefined ? 0 : needCount(summaryNeedsOf(entry));
        return {
          id: client.id,
          label: client.name,
          icon: BuildingIcon,
          render: (look) => (
            <Link
              {...look}
              params={{ clientId: client.id }}
              to="/organizations/$clientId"
            />
          ),
          current: isAt(`/organizations/${client.id}`),
          ...rowEnd(client, entry, needs),
        };
      }),
    },
    {
      id: "labs",
      label: "Labs",
      collapsible: true,
      rows: [
        {
          id: "ask",
          label: "Ask Grasp",
          icon: SparklesIcon,
          render: (look) => <Link {...look} to="/ask" />,
          current: isAt("/ask"),
        },
        {
          id: "lab",
          label: "Stephen Lab",
          icon: FlaskConicalIcon,
          render: (look) => <Link {...look} to="/lab" />,
          current: isAt("/lab"),
        },
        {
          id: "voice",
          label: "Voice Lab",
          icon: AudioWaveformIcon,
          render: (look) => <Link {...look} to="/voice-lab" />,
          current: isAt("/voice-lab"),
        },
      ],
    },
  ];
};

/**
 * The Inbox view: what needs Grasp, by organization, the most pressing
 * first, from the summaries: a row for each kind, with how many of it.
 */
const inboxGroups = (
  organizations: Map<string, ClientSummary> | null
): SidebarGroupEntry[] =>
  [...(organizations?.values() ?? [])].flatMap((entry) => {
    const needs = summaryNeedsOf(entry);
    const { id, name } = entry.client;
    return needs.length === 0
      ? []
      : [
          {
            id: `inbox-${id}`,
            label: name,
            count: needCount(needs),
            rows: needs.map((need, at) => ({
              id: `${id}-${String(at)}`,
              label: need.text,
              quiet: true,
              render: sectionLink(id, need.section, need.search),
              ...needsCount(need.count),
            })),
          },
        ];
  });

/**
 * An organization's sections, as a level of the sidebar while one of its
 * pages is open, each with how many of `needs` wait there.
 */
const organizationSection = (
  client: GridRow,
  needs: readonly OrgNeed[],
  pathname: string
): SidebarSection => {
  const waiting = new Map<OrgSection, number>();
  for (const need of needs) {
    waiting.set(need.section, (waiting.get(need.section) ?? 0) + need.count);
  }
  const base = `/organizations/${client.id}`;
  const row = (section: OrgSection): SidebarRow => {
    const path = sectionTo[section].replace("/organizations/$clientId", base);
    return {
      id: section,
      label: sectionWords[section].title,
      icon: sectionWords[section].icon,
      render: sectionLink(client.id, section),
      current:
        section === "overview" ? pathname === base : pathname.startsWith(path),
      ...needsCount(waiting.get(section) ?? 0),
    };
  };
  return {
    id: `organization:${client.id}`,
    title: client.name,
    icon: BuildingIcon,
    home: (look) => (
      <Link
        {...look}
        activeOptions={{ exact: true, includeSearch: false }}
        params={{ clientId: client.id }}
        to="/organizations/$clientId"
      />
    ),
    homeCurrent: pathname === base,
    back: { label: "Back", render: (look) => <Link {...look} to="/" /> },
    groups: [
      { id: "overview", rows: [row("overview")] },
      ...sectionGroups.map((group) => ({
        id: group.id,
        label: group.label,
        rows: group.sections.map(row),
      })),
    ],
  };
};

// The admin's look follows the system unless staff chose one here; kept in
// this browser, read by public/theme.js before the first paint.
const themeKey = "grasp.admin.theme";
const themeListeners = new Set<() => void>();
// The choice made in this page, which stands even where storage refuses it.
let chosenTheme: string | null = null;
const readTheme = (): string => {
  if (chosenTheme !== null) {
    return chosenTheme;
  }
  try {
    return localStorage.getItem(themeKey) ?? "system";
  } catch {
    return "system";
  }
};
const chooseTheme = (mode: string) => {
  chosenTheme = mode;
  try {
    localStorage.setItem(themeKey, mode);
  } catch {
    // Kept for this page only.
  }
  const dark =
    mode === "dark" ||
    (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.mode = mode;
  for (const listener of themeListeners) {
    listener();
  }
};
const onTheme = (listener: () => void) => {
  themeListeners.add(listener);
  return () => {
    themeListeners.delete(listener);
  };
};

const StaffMenu = ({ staff }: { staff: Staff }) => {
  const theme = useSyncExternalStore(onTheme, readTheme, () => "system");
  return (
    <FrameProfile
      detail="Grasp staff"
      entries={[
        {
          theme: {
            label: "Appearance",
            icon: ContrastIcon,
            value: theme,
            choices: [
              { label: "Light", value: "light", icon: SunIcon },
              { label: "Dark", value: "dark", icon: MoonIcon },
              { label: "System", value: "system", icon: MonitorIcon },
            ],
            onValueChange: chooseTheme,
          },
        },
        "separator",
        {
          action: {
            label: "Sign out",
            icon: LogOutIcon,
            danger: true,
            render: <a aria-label="Sign out" href="/cdn-cgi/access/logout" />,
          },
        },
      ]}
      name={staff.name}
    />
  );
};

/** Find an organization or a place by name: the sidebar's search, and ⌘K. */
const Search = ({
  open,
  onOpenChange,
  clients,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clients: readonly GridRow[];
}) => {
  const navigate = useNavigate();
  const items: CommandItems = [
    {
      type: "group",
      label: "Organizations",
      items: clients
        .filter(({ status }) => status !== "offboarded")
        .map((client) => ({
          value: `org:${client.id}`,
          label: client.name,
          icon: BuildingIcon,
        })),
    },
    {
      type: "group",
      label: "Places",
      items: [
        { value: "/", label: "Home", icon: HouseIcon },
        { value: "/platform", label: "Platform", icon: ServerIcon },
        { value: "/platform/releases", label: "Releases", icon: ServerIcon },
        { value: "/connectors", label: "Apps asked for", icon: WrenchIcon },
        {
          value: "/new-organization",
          label: "New organization",
          icon: BuildingIcon,
        },
      ],
    },
  ];
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogTitle>Search</DialogTitle>
        <Command
          items={items}
          onAction={async (value) => {
            onOpenChange(false);
            await (value.startsWith("org:")
              ? navigate({
                  to: "/organizations/$clientId",
                  params: { clientId: value.slice(4) },
                })
              : navigate({ to: value }));
          }}
        >
          <CommandInput placeholder="Find an organization or a place" />
          <CommandEmpty>Nothing by that name.</CommandEmpty>
          <CommandList />
        </Command>
      </DialogContent>
    </Dialog>
  );
};

/**
 * What waits in the open organization's sections: in full from its page's
 * own read of its core once that is in, so the level follows the page as
 * it is read again; from its summary until then.
 */
const levelNeeds = (
  entry: ClientSummary | undefined,
  openRead: OrgRead | undefined
): OrgNeed[] => {
  if (openRead !== undefined) {
    return needsOf(organizationOf(openRead.admin));
  }
  return entry === undefined ? [] : summaryNeedsOf(entry);
};

type View = "home" | "inbox";

/** The sidebar's two views: Home, and the Inbox of what needs Grasp, its count as the bell's dot. */
const viewTabs = (waiting: number): SidebarTab[] => [
  { value: "home", label: "Home", icon: HouseIcon },
  {
    value: "inbox",
    label: "Inbox",
    icon: BellIcon,
    count: waiting,
    countLabel: `${waiting} ${waiting === 1 ? "thing needs" : "things need"} Grasp`,
  },
];

/** The sidebar's view and whether the search is open: kept by the frame, so they stay as the organizations come in. */
interface SidebarState {
  view: View;
  setView: (view: View) => void;
  searching: boolean;
  setSearching: (searching: boolean) => void;
}

interface SidebarProps {
  clients: readonly GridRow[];
  summaries: readonly ClientSummary[] | null;
  platform: PlatformCounts;
  staff: Staff;
  state: SidebarState;
}

const SidebarBody = ({
  clients,
  summaries,
  platform,
  staff,
  state: { view, setView, searching, setSearching },
  openRead,
}: SidebarProps & { openRead: OrgRead | undefined }) => {
  const router = useRouter();
  const matchRoute = useMatchRoute();
  const { pathname } = useLocation();
  const { setOpenMobile } = useSidebar();
  useEffect(
    () =>
      router.subscribe("onBeforeNavigate", () => {
        setOpenMobile(false);
      }),
    [router, setOpenMobile]
  );
  const organizations =
    summaries === null
      ? null
      : new Map(summaries.map((entry) => [entry.client.id, entry]));
  const isAt = (to: string, fuzzy = true) =>
    matchRoute({ to, fuzzy }) !== false;
  const inbox = inboxGroups(organizations);
  const waiting = inbox.reduce((sum, group) => sum + (group.count ?? 0), 0);
  const open = useMatch({
    from: "/organizations/$clientId",
    shouldThrow: false,
  })?.loaderData;
  const shown = open?.state === "open" ? open.client : undefined;
  return (
    <>
      <FrameSidebar
        aria-label="Sidebar"
        closeLabel="Close"
        foldLabel="Show or hide the sidebar"
        groups={
          view === "inbox"
            ? inbox
            : homeGroups({ clients, organizations, platform, isAt })
        }
        mark={
          <Link
            onClick={() => {
              setView("home");
            }}
            to="/"
            {...stylex.props(styles.home, focusRing)}
          >
            <Icon icon={GraspMark} label="Grasp admin" />
          </Link>
        }
        navLabel={view === "inbox" ? "Inbox" : "Main"}
        profile={<StaffMenu staff={staff} />}
        search={{
          label: "Search",
          shortcut: "⌘K",
          onSearch: () => {
            setSearching(true);
          },
        }}
        views={{
          tabs: viewTabs(waiting),
          tab: view,
          onTabChange: (next) => {
            if (next === "home" || next === "inbox") {
              setView(next);
            }
          },
          label: "Views",
        }}
        {...(view === "inbox" && summaries !== null
          ? { empty: "Nothing needs Grasp." }
          : {})}
        {...(shown === undefined
          ? {}
          : {
              section: organizationSection(
                shown,
                levelNeeds(organizations?.get(shown.id), openRead),
                pathname
              ),
            })}
      />
      <Search clients={clients} onOpenChange={setSearching} open={searching} />
    </>
  );
};

/** The sidebar once the open organization's page has read its core. */
const SettledOpen = ({
  read,
  ...props
}: SidebarProps & { read: Deferred<OrgRead> }) => (
  <SidebarBody {...props} openRead={useSettled(read)} />
);

/**
 * The sidebar, and while an organization's page is open, its level drawn
 * from that page's own read of its core (`read`), so what waits where
 * follows the page as it is read again; from its summary until it
 * is in.
 */
const AdminSidebar = (props: SidebarProps) => {
  const open = useMatch({
    from: "/organizations/$clientId",
    shouldThrow: false,
  })?.loaderData;
  const read = open?.state === "open" ? open.read : undefined;
  if (read === undefined) {
    return <SidebarBody {...props} openRead={undefined} />;
  }
  return (
    <Suspense fallback={<SidebarBody {...props} openRead={undefined} />}>
      <SettledOpen {...props} read={read} />
    </Suspense>
  );
};

const SettledSidebar = ({
  summaries,
  ...rest
}: {
  clients: readonly GridRow[];
  summaries: Deferred<ClientSummary[] | null>;
  platform: PlatformCounts;
  staff: Staff;
  state: SidebarState;
}) => <AdminSidebar {...rest} summaries={useSettled(summaries)} />;

// Readiness set aside for this session: a standing item staff know of
// needn't stand over every page, as the product's AI-key banner across
// the card's top never pushes a page down.
const readinessKey = "grasp.admin.readiness-aside";
const asideNow = (): boolean => {
  try {
    return sessionStorage.getItem(readinessKey) !== null;
  } catch {
    return false;
  }
};

/** What stops an organization being onboarded, across the top of the frame, until set aside. */
const ReadinessAcross = ({
  readiness,
}: {
  readiness: Deferred<Readiness | null>;
}) => {
  const read = useSettled(readiness);
  const [aside, setAside] = useState(asideNow);
  if (aside || read === null) {
    return null;
  }
  return (
    <ReadinessBanner
      onClose={() => {
        try {
          sessionStorage.setItem(readinessKey, "1");
        } catch {
          // Set aside for this page only.
        }
        setAside(true);
      }}
      readiness={read}
    />
  );
};

/** The admin's frame around its pages. */
export const AdminFrame = ({
  clients,
  summaries,
  platform,
  staff,
  readiness,
}: {
  clients: readonly GridRow[];
  summaries: Deferred<ClientSummary[] | null>;
  platform: PlatformCounts;
  staff: Staff;
  readiness: Deferred<Readiness | null>;
}) => {
  const [view, setView] = useState<View>("home");
  const [searching, setSearching] = useState(false);
  const state = { view, setView, searching, setSearching };
  // ⌘K opens the search, wherever focus is.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
    };
  }, []);

  return (
    <FrameShell
      banner={
        <Suspense fallback={null}>
          <ReadinessAcross readiness={readiness} />
        </Suspense>
      }
      sidebar={
        <Suspense
          fallback={
            <AdminSidebar
              clients={clients}
              platform={platform}
              staff={staff}
              state={state}
              summaries={null}
            />
          }
        >
          <SettledSidebar
            clients={clients}
            platform={platform}
            staff={staff}
            state={state}
            summaries={summaries}
          />
        </Suspense>
      }
      storageKey={sidebarKey}
    >
      <Outlet />
    </FrameShell>
  );
};

/** How many organizations the sidebar's skeleton stands in for. */
const loadingEntries = 6;

/** The frame while the admin's own records come, before the first page shows. */
export const FrameLoading = () => (
  <FrameShell
    sidebar={
      <FrameSidebar
        aria-label="Sidebar"
        closeLabel="Close"
        foldLabel="Show or hide the sidebar"
        groups={[
          {
            id: "loading",
            rows: [],
            content: (
              <SidebarMenu aria-busy>
                {Array.from({ length: loadingEntries }, (_, entry) => (
                  <SidebarMenuItem key={entry}>
                    <SidebarMenuSkeleton showIcon />
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            ),
          },
        ]}
        mark={<Icon icon={GraspMark} label="Grasp admin" />}
        navLabel="Main"
        search={{
          label: "Search",
          shortcut: "⌘K",
          onSearch: () => {
            // Nothing to search while the admin's records come.
          },
        }}
      />
    }
    storageKey={sidebarKey}
  >
    <PageLoading />
  </FrameShell>
);
