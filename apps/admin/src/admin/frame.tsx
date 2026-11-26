/**
 * Grasp's admin, the one place staff manage everything, apart from the
 * platform a company works in, ported from the prototype
 * (grasplabs/prototype `packages/grasp/src/components/admin/admin-frame.tsx`):
 * its own sidebar, with its places and every organization. It folds to
 * icons, so inside one organization that organization's own column of
 * sections has the room.
 *
 * Beside each organization, as the prototype has it, how many things need
 * Grasp there, as the admin's model works it out of what its core answered
 * (src/admin/views.ts). Beside Platform, how many companies' platforms
 * need a look, as the admin recorded them (`platformCounts`).
 * Beside Apps asked for, how many apps the companies asked for
 * (`askedApps`).
 *
 * Drawn with Damsko's Sidebar parts, composed as its app-shell-01 block
 * composes them, not the block itself: the block draws the page's bar from
 * props and folds off the side, where each admin page draws its own bar
 * (page.tsx) and the sidebar folds to its icons.
 */
import { TooltipProvider as KitTooltipProvider } from "@grasp-os/app-kit/components/tooltip";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarLevel,
  SidebarLevels,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@grasp-os/ui/components/sidebar";
import { Text } from "@grasp-os/ui/components/text";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import {
  AudioWaveformIcon,
  BuildingIcon,
  CircleAlertIcon,
  ClockIcon,
  FlaskConicalIcon,
  Icon,
  LayoutDashboardIcon,
  ServerIcon,
  SparklesIcon,
  WrenchIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import {
  Link,
  Outlet,
  useMatch,
  useMatchRoute,
  useRouter,
} from "@tanstack/react-router";
import { Suspense, useEffect } from "react";
import type { ReactNode } from "react";

import type { ClientAdmin } from "../clients/admin.ts";
import type { GridRow } from "../clients/grid.ts";
import { PageLoading } from "./failure.tsx";
import { GraspMark } from "./grasp-mark.ts";
import { askedApps } from "./integrations-asked.ts";
import { OrganizationLevel, organizationLevel } from "./organization.tsx";
import type { PlatformCounts } from "./platform.ts";
import { useSettled } from "./settled.tsx";
import type { Deferred } from "./settled.tsx";
import { organizationsOf, unreadWords } from "./views.ts";
import type { Organization } from "./views.ts";

const styles = stylex.create({
  // The sidebar's head: Grasp's mark and the admin's name, the fold at the
  // end; folded to the icons, the fold alone, over the icons' column.
  brand: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    minHeight: size.sidebarIconButton,
    paddingInlineStart: size.sidebarRowInline,
    color: colors.sidebarForeground,
  },
  folded: { justifyContent: "center", paddingInlineStart: 0 },
  name: { display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0 },
  // What the card holds, laid over its box, as app-shell-01 lays it: the
  // card is as tall as the window, never as the page, so the page scrolls
  // inside it and its bar (page.tsx) stays.
  card: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "clip",
    backgroundColor: colors.sidebarCard,
    borderRadius: "inherit",
  },
  // The page, down the card: it scrolls up and down only, what is wider
  // than the card is cut at its edge.
  page: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    overflowX: "clip",
    overflowY: "auto",
  },
});

/**
 * Where the admin's sidebar keeps, in this browser, whether staff folded
 * it to its icons. Not drawn before the page wakes: Damsko's
 * `sidebarStateScript` is an inline script, and the admin runs none
 * (public/theme.js is a file for that reason); the frame's first paint is
 * its loading skeleton, which takes the kept fold as the page wakes.
 */
const sidebarKey = "grasp.admin.sidebar";

/** One of the admin's own places, down the top of its sidebar. */
interface Place {
  to: "/" | "/connectors" | "/platform" | "/ask" | "/lab" | "/voice-lab";
  label: string;
  icon: IconData;
}

const places: readonly Place[] = [
  { to: "/", label: "Overview", icon: LayoutDashboardIcon },
  {
    to: "/connectors",
    label: "Apps asked for",
    icon: WrenchIcon,
  },
  { to: "/platform", label: "Platform", icon: ServerIcon },
  { to: "/ask", label: "Ask Grasp", icon: SparklesIcon },
  { to: "/lab", label: "Stephen Lab", icon: FlaskConicalIcon },
  { to: "/voice-lab", label: "Voice Lab", icon: AudioWaveformIcon },
];

/**
 * Why an organization's core isn't read now, in words and as a mark: not
 * deployed yet, or not answering; null when it answered. A mark, where the
 * prototype has its count, for words don't fit beside the name.
 */
const unreadOf = (
  admin: ClientAdmin
): { words: string; mark: IconData } | null => {
  if (admin.state === "answered") {
    return null;
  }
  return {
    words: unreadWords(admin),
    mark: admin.error === "not_deployed" ? ClockIcon : CircleAlertIcon,
  };
};

/** The tooltip of an organization's entry: its name, and what its mark or count says. */
const tooltipOf = (
  name: string,
  unread: { words: string } | null,
  needs: number
): string => {
  if (unread !== null) {
    return `${name}: ${unread.words}`;
  }
  if (needs === 0) {
    return name;
  }
  return `${name}: ${needs} ${needs === 1 ? "thing needs" : "things need"} Grasp`;
};

/** What a place says beside its name: a count, and what it counts in words. */
interface PlaceBadge {
  count: number;
  words: string;
}

/** Platform's badge: how many companies need a look. */
const platformBadge = ({ needLook }: PlatformCounts): PlaceBadge | null =>
  needLook === 0
    ? null
    : {
        count: needLook,
        words: `${needLook} ${needLook === 1 ? "company needs" : "companies need"} a look`,
      };

/** Apps asked for's badge: how many apps the companies asked for. */
const integrationsBadge = (asked: number): PlaceBadge | null =>
  asked === 0
    ? null
    : {
        count: asked,
        words: `${asked} ${asked === 1 ? "app" : "apps"} asked for`,
      };

/** What a place says beside its name, if anything. */
const badgeOf = (
  to: Place["to"],
  platform: PlatformCounts,
  asked: number
): PlaceBadge | null => {
  if (to === "/platform") {
    return platformBadge(platform);
  }
  return to === "/connectors" ? integrationsBadge(asked) : null;
};

/** A row's badge: what it shows, and in words for a screen reader what it means. */
const RowBadge = ({ shown, words }: { shown: ReactNode; words: string }) => (
  <SidebarMenuBadge>
    {shown}
    <span {...stylex.props(visuallyHidden)}>{words}</span>
  </SidebarMenuBadge>
);

const PlaceItem = ({
  place,
  badge = null,
}: {
  place: Place;
  badge?: PlaceBadge | null;
}) => {
  const matchRoute = useMatchRoute();
  const { to, label, icon } = place;
  // The overview is only itself; any other place holds the pages under it.
  const active = matchRoute({ to, fuzzy: to !== "/" }) !== false;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        // The folded sidebar hides the badge, so its tooltip says the count.
        tooltip={badge === null ? undefined : `${label}: ${badge.words}`}
      >
        <Link to={to}>
          <Icon icon={icon} />
          {label}
        </Link>
      </SidebarMenuButton>
      {badge === null ? null : (
        <RowBadge shown={badge.count} words={`: ${badge.words}`} />
      )}
    </SidebarMenuItem>
  );
};

/**
 * An organization: its name, and how many things need Grasp there, or when
 * its core isn't read now, why; only its name until its core's answer
 * is in.
 */
const OrganizationItem = ({
  client,
  organization,
}: {
  client: GridRow;
  /** Null while its core's answer isn't in. */
  organization: Organization | null;
}) => {
  const matchRoute = useMatchRoute();
  const { id, name } = client;
  const unread = organization === null ? null : unreadOf(organization.admin);
  const needs = organization?.view?.needs.length ?? 0;
  const active =
    matchRoute({
      to: "/organizations/$clientId",
      params: { clientId: id },
      fuzzy: true,
    }) !== false;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={tooltipOf(name, unread, needs)}
      >
        <Link params={{ clientId: id }} to="/organizations/$clientId">
          <Icon icon={BuildingIcon} />
          {name}
        </Link>
      </SidebarMenuButton>
      {unread === null ? null : (
        // Why it isn't read, said by the mark's own tooltip whether the
        // sidebar is open or folded; it leads to its Setup, which says more.
        <Tooltip>
          <TooltipTrigger asChild>
            <SidebarMenuAction asChild>
              <Link
                aria-label={`${name}: ${unread.words}. Open its Setup`}
                params={{ clientId: id }}
                to="/organizations/$clientId/setup"
              >
                <Icon icon={unread.mark} />
              </Link>
            </SidebarMenuAction>
          </TooltipTrigger>
          <TooltipContent side="right">{unread.words}</TooltipContent>
        </Tooltip>
      )}
      {needs > 0 ? (
        <RowBadge
          shown={needs}
          words={needs === 1 ? "thing needs Grasp" : "things need Grasp"}
        />
      ) : null}
    </SidebarMenuItem>
  );
};

/**
 * The sidebar's places and organizations: every organization the admin
 * knows by name, and once their cores' answers are in (`admins`, null
 * until then, or when they couldn't be read), what needs Grasp in each.
 */
const SidebarLists = ({
  clients,
  admins,
  platform,
}: {
  clients: readonly GridRow[];
  admins: readonly ClientAdmin[] | null;
  platform: PlatformCounts;
}) => {
  const organizations = new Map(
    organizationsOf(admins ?? []).map((organization) => [
      organization.admin.client.id,
      organization,
    ])
  );
  const asked = askedApps(admins ?? []).length;
  return (
    <SidebarContent aria-label="Admin">
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {places.map((place) => (
              <PlaceItem
                badge={badgeOf(place.to, platform, asked)}
                key={place.to}
                place={place}
              />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      {/* A landmark of its own, so staff can jump to the organizations. */}
      <nav aria-label="Organizations">
        <SidebarGroup>
          <SidebarGroupLabel>Organizations</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {clients
                .filter(({ status }) => status !== "offboarded")
                .map((client) => (
                  <OrganizationItem
                    client={client}
                    key={client.id}
                    organization={organizations.get(client.id) ?? null}
                  />
                ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </nav>
    </SidebarContent>
  );
};

/** The sidebar's lists once the cores' answers are in. */
const SettledLists = ({
  admins,
  ...lists
}: {
  clients: readonly GridRow[];
  admins: Deferred<ClientAdmin[] | null>;
  platform: PlatformCounts;
}) => <SidebarLists {...lists} admins={useSettled(admins)} />;

/**
 * The sidebar's levels: the admin's places and organizations, and while
 * an organization's page is open, that organization's sections in their
 * place, as the frontend's areas with a navigation of their own.
 */
const Levels = ({
  clients,
  admins,
  platform,
}: {
  clients: readonly GridRow[];
  admins: Deferred<ClientAdmin[] | null>;
  platform: PlatformCounts;
}) => {
  // The open organization's page, as its route loaded it: the level shows
  // what that page read of its core.
  const open = useMatch({
    from: "/organizations/$clientId",
    shouldThrow: false,
  })?.loaderData;
  const shown = open?.state === "open" ? open : undefined;
  return (
    <SidebarLevels
      value={shown === undefined ? "main" : organizationLevel(shown.client.id)}
    >
      <SidebarLevel value="main">
        {/* Every organization by name at once; what needs Grasp in each once its core answered. */}
        <Suspense
          fallback={
            <SidebarLists admins={null} clients={clients} platform={platform} />
          }
        >
          <SettledLists admins={admins} clients={clients} platform={platform} />
        </Suspense>
      </SidebarLevel>
      {shown === undefined ? null : (
        <OrganizationLevel
          client={shown.client}
          key={shown.client.id}
          read={shown.read}
        />
      )}
    </SidebarLevels>
  );
};

/**
 * The sidebar's head: Grasp's mark, "Grasp" with "Admin" under it, and
 * the fold. Folded to the icons, the fold alone, so the sidebar opens
 * again from where it folded.
 */
const Brand = () => {
  const { state, isMobile } = useSidebar();
  const folded = state === "collapsed" && !isMobile;
  return (
    <div {...stylex.props(styles.brand, folded && styles.folded)}>
      {folded ? null : (
        <>
          <Icon icon={GraspMark} />
          <span {...stylex.props(styles.name)}>
            <Text as="span" color="default" size="sm" truncate weight="medium">
              Grasp
            </Text>
            <Text as="span" color="muted" size="xs" truncate>
              Admin
            </Text>
          </span>
        </>
      )}
      <SidebarTrigger />
    </div>
  );
};

/** The admin's sidebar, folded to its icons or open, around what it lists. */
const AdminSidebarFrame = ({ children }: { children: ReactNode }) => (
  <Sidebar collapsible="icon" variant="inset">
    <SidebarHeader>
      <Brand />
    </SidebarHeader>
    {children}
  </Sidebar>
);

const AdminSidebar = ({
  clients,
  admins,
  platform,
}: {
  clients: readonly GridRow[];
  admins: Deferred<ClientAdmin[] | null>;
  platform: PlatformCounts;
}) => {
  const router = useRouter();
  const { setOpenMobile } = useSidebar();
  // On a phone the sidebar is a sheet over the page: going anywhere from it
  // closes it, so the page it went to is in view.
  useEffect(
    () =>
      router.subscribe("onResolved", () => {
        setOpenMobile(false);
      }),
    [router, setOpenMobile]
  );
  return (
    <AdminSidebarFrame>
      <Levels admins={admins} clients={clients} platform={platform} />
    </AdminSidebarFrame>
  );
};

/**
 * The frame's row: the sidebar beside the page's card (Damsko's
 * SidebarInset, the main landmark), the page scrolling inside it so its
 * bar stays in view. The kit's tooltips stay for the pages still on the
 * kit.
 */
const Shell = ({
  sidebar,
  children,
}: {
  sidebar: ReactNode;
  children: ReactNode;
}) => (
  <KitTooltipProvider>
    <SidebarProvider storageKey={sidebarKey}>
      {sidebar}
      <SidebarInset>
        <div {...stylex.props(styles.card)}>
          <div {...stylex.props(styles.page)}>{children}</div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  </KitTooltipProvider>
);

/** The admin's frame around its pages: its sidebar beside the page. */
export const AdminFrame = ({
  clients,
  admins,
  platform,
}: {
  clients: readonly GridRow[];
  admins: Deferred<ClientAdmin[] | null>;
  platform: PlatformCounts;
}) => (
  <Shell
    sidebar={
      <AdminSidebar admins={admins} clients={clients} platform={platform} />
    }
  >
    <Outlet />
  </Shell>
);

/** How many organizations the sidebar's skeleton stands in for. */
const loadingEntries = 6;

/**
 * The frame while the admin's own records come, before the first page
 * shows: its sidebar and the page's usual layout as skeletons. The Worker
 * sends it as the document's body, so the admin never opens on a blank
 * page while its script loads.
 */
export const FrameLoading = () => (
  <Shell
    sidebar={
      <AdminSidebarFrame>
        <SidebarContent aria-label="Admin">
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu aria-busy>
                {Array.from({ length: loadingEntries }, (_, entry) => (
                  <SidebarMenuItem key={entry}>
                    <SidebarMenuSkeleton showIcon />
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </AdminSidebarFrame>
    }
  >
    <PageLoading />
  </Shell>
);
