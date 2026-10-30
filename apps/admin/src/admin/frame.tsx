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
 * need a look and a rollout waiting for approval, as the admin recorded
 * them (`platformCounts`), and under it its releases and rollouts.
 * Beside Apps asked for, how many apps the companies asked for
 * (`askedApps`).
 */
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  useSidebar,
} from "@grasp-os/ui/components/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { Link, Outlet, useMatchRoute, useRouter } from "@tanstack/react-router";
import {
  BuildingIcon,
  FlaskConicalIcon,
  HourglassIcon,
  LayoutDashboardIcon,
  ServerIcon,
  SparklesIcon,
  UnplugIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect } from "react";
import type { ComponentType, SVGProps } from "react";

import type { ClientAdmin } from "../clients/admin.ts";
import { GraspMark } from "./grasp-mark.tsx";
import { askedApps } from "./integrations-asked.ts";
import type { PlatformCounts } from "./platform.ts";
import { organizationsOf, unreadWords } from "./views.ts";
import type { Organization } from "./views.ts";

/** One of the admin's own places, down the top of its sidebar. */
interface Place {
  to: "/" | "/integrations" | "/platform" | "/ask" | "/lab";
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** The pages under it, nested beneath its entry. */
  under?: readonly SubPlace[];
}

/** A page under one of the admin's places, nested beneath its entry. */
interface SubPlace {
  to: "/platform/releases" | "/platform/rollouts";
  label: string;
}

const places: readonly Place[] = [
  { to: "/", label: "Overview", icon: LayoutDashboardIcon },
  {
    to: "/integrations",
    label: "Apps asked for",
    icon: WrenchIcon,
  },
  {
    to: "/platform",
    label: "Platform",
    icon: ServerIcon,
    under: [
      { to: "/platform/releases", label: "Releases" },
      { to: "/platform/rollouts", label: "Rollouts" },
    ],
  },
  { to: "/ask", label: "Ask Grasp", icon: SparklesIcon },
  { to: "/lab", label: "Stephen Lab", icon: FlaskConicalIcon },
];

/**
 * Why an organization's core isn't read now, in words and as a mark: not
 * deployed yet, or not answering; null when it answered. A mark, where the
 * prototype has its count, for words don't fit beside the name.
 */
const unreadOf = (
  admin: ClientAdmin
): { words: string; Mark: ComponentType<SVGProps<SVGSVGElement>> } | null => {
  if (admin.state === "answered") {
    return null;
  }
  return {
    words: unreadWords(admin),
    Mark: admin.error === "not_deployed" ? HourglassIcon : UnplugIcon,
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

/** Platform's badge: companies that need a look, and a rollout that waits, as one count. */
const platformBadge = ({
  needLook,
  waiting,
}: PlatformCounts): PlaceBadge | null => {
  const count = needLook + (waiting ? 1 : 0);
  if (count === 0) {
    return null;
  }
  const look =
    needLook === 0
      ? []
      : [
          `${needLook} ${needLook === 1 ? "company needs" : "companies need"} a look`,
        ];
  const waits = waiting ? ["a rollout waits for approval"] : [];
  return { count, words: [...look, ...waits].join("; ") };
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
  return to === "/integrations" ? integrationsBadge(asked) : null;
};

const PlaceItem = ({
  place,
  badge = null,
}: {
  place: Place;
  badge?: PlaceBadge | null;
}) => {
  const matchRoute = useMatchRoute();
  const { to, label, icon: Icon, under = [] } = place;
  // The overview is only itself; any other place holds the pages under it.
  const active = matchRoute({ to, fuzzy: to !== "/" }) !== false;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        render={<Link to={to} />}
        // The folded sidebar hides the badge, so its tooltip says the count.
        tooltip={badge === null ? label : `${label}: ${badge.words}`}
      >
        <Icon />
        <span>{label}</span>
      </SidebarMenuButton>
      {badge === null ? null : (
        <SidebarMenuBadge>
          {badge.count}
          <span className="sr-only">{`: ${badge.words}`}</span>
        </SidebarMenuBadge>
      )}
      {under.length === 0 ? null : (
        // Hidden while the sidebar is folded to icons: its entry leads there.
        <SidebarMenuSub>
          {under.map((sub) => (
            <SidebarMenuSubItem key={sub.to}>
              <SidebarMenuSubButton
                isActive={matchRoute({ to: sub.to, fuzzy: true }) !== false}
                render={<Link to={sub.to} />}
              >
                <span>{sub.label}</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  );
};

/**
 * An organization: its name, and how many things need Grasp there, or when
 * its core isn't read now, why.
 */
const OrganizationItem = ({ organization }: { organization: Organization }) => {
  const matchRoute = useMatchRoute();
  const { admin, view } = organization;
  const { id, name } = admin.client;
  const unread = unreadOf(admin);
  const needs = view?.needs.length ?? 0;
  const active =
    matchRoute({
      to: "/organizations/$clientId",
      params: { clientId: id },
      fuzzy: true,
    }) !== false;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        // Room for the mark or count, so a long name ends before it.
        className={unread === null && needs === 0 ? undefined : "pr-8"}
        isActive={active}
        render={
          <Link params={{ clientId: id }} to="/organizations/$clientId" />
        }
        tooltip={tooltipOf(name, unread, needs)}
      >
        <BuildingIcon />
        <span>{name}</span>
      </SidebarMenuButton>
      {unread === null ? null : (
        // Its own tooltip: the button's shows only while the sidebar is
        // folded, and the badge would let no pointer through to it.
        <Tooltip>
          <TooltipTrigger
            render={<SidebarMenuBadge className="pointer-events-auto" />}
          >
            <unread.Mark aria-hidden className="size-4" />
            <span className="sr-only">{unread.words}</span>
          </TooltipTrigger>
          <TooltipContent side="right">{unread.words}</TooltipContent>
        </Tooltip>
      )}
      {needs > 0 ? (
        <SidebarMenuBadge>
          {needs}
          <span className="sr-only">
            {needs === 1 ? "thing needs Grasp" : "things need Grasp"}
          </span>
        </SidebarMenuBadge>
      ) : null}
    </SidebarMenuItem>
  );
};

const AdminSidebar = ({
  admins,
  platform,
}: {
  admins: readonly ClientAdmin[];
  platform: PlatformCounts;
}) => {
  const router = useRouter();
  const organizations = organizationsOf(admins);
  const asked = askedApps(admins).length;
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
    <Sidebar collapsible="icon" label="Admin" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/" />}
              size="lg"
              tooltip="Grasp admin"
            >
              <span className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                <GraspMark className="size-4" />
              </span>
              <span className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">Grasp</span>
                <span className="text-muted-foreground truncate text-xs">
                  Admin
                </span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <nav aria-label="Admin">
              <SidebarMenu>
                {places.map((place) => (
                  <PlaceItem
                    badge={badgeOf(place.to, platform, asked)}
                    key={place.to}
                    place={place}
                  />
                ))}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Organizations</SidebarGroupLabel>
          <SidebarGroupContent>
            <nav aria-label="Organizations">
              <SidebarMenu>
                {organizations.map((organization) => (
                  <OrganizationItem
                    key={organization.admin.client.id}
                    organization={organization}
                  />
                ))}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
};

/**
 * The admin's frame around its pages: its sidebar beside the page, which
 * scrolls inside it so its bar stays in view, as the platform's frame does.
 */
export const AdminFrame = ({
  admins,
  platform,
}: {
  admins: readonly ClientAdmin[];
  platform: PlatformCounts;
}) => (
  <TooltipProvider>
    <SidebarProvider className="h-svh">
      <AdminSidebar admins={admins} platform={platform} />
      <SidebarInset className="min-h-0 min-w-0 overflow-y-auto">
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  </TooltipProvider>
);
