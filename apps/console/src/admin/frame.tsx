/**
 * Grasp's admin as a place of its own, apart from the console's pages and
 * from the platform a company works in, ported from the prototype
 * (grasplabs/prototype `packages/grasp/src/components/admin/admin-frame.tsx`):
 * its own sidebar (its places, every organization, and the way back to the
 * console at its foot) and none of the console's bar above. It folds to
 * icons, so inside one organization that organization's own column of
 * sections has the room.
 *
 * Not yet here, as the prototype has them: how many integrations wait on
 * Grasp, how many companies' platforms need a look, and how many things
 * need Grasp in each organization. The console has no source for the first
 * two yet, and the third needs the admin's model of what needs Grasp
 * (`adminViewOf`) worked out from a client's snapshot, which the overview
 * brings. Until then an entry shows no number rather than a made-up one.
 */
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
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
  ArrowLeftIcon,
  BuildingIcon,
  CableIcon,
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

/** One of the admin's own places, down the top of its sidebar. */
interface Place {
  to:
    | "/admin"
    | "/admin/integrations"
    | "/admin/platform"
    | "/admin/ask"
    | "/admin/sources"
    | "/admin/lab";
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

const places: readonly Place[] = [
  { to: "/admin", label: "Overview", icon: LayoutDashboardIcon },
  {
    to: "/admin/integrations",
    label: "Integrations to build",
    icon: WrenchIcon,
  },
  { to: "/admin/platform", label: "Platform", icon: ServerIcon },
  { to: "/admin/ask", label: "Ask Grasp", icon: SparklesIcon },
  { to: "/admin/sources", label: "Sources", icon: CableIcon },
  { to: "/admin/lab", label: "Stephen Lab", icon: FlaskConicalIcon },
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
  return admin.error === "not_deployed"
    ? { words: "not deployed", Mark: HourglassIcon }
    : { words: "unreachable", Mark: UnplugIcon };
};

const PlaceItem = ({ place }: { place: Place }) => {
  const matchRoute = useMatchRoute();
  const { to, label, icon: Icon } = place;
  // The overview is only itself; any other place holds the pages under it.
  const active = matchRoute({ to, fuzzy: to !== "/admin" }) !== false;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        render={<Link to={to} />}
        tooltip={label}
      >
        <Icon />
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
};

/** An organization: its name, and when its core isn't read now, why. */
const OrganizationItem = ({ admin }: { admin: ClientAdmin }) => {
  const matchRoute = useMatchRoute();
  const { id, name } = admin.client;
  const unread = unreadOf(admin);
  const active =
    matchRoute({
      to: "/admin/organizations/$clientId",
      params: { clientId: id },
      fuzzy: true,
    }) !== false;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        // Room for the mark, so a long name ends before it.
        className={unread === null ? undefined : "pr-8"}
        isActive={active}
        render={
          <Link params={{ clientId: id }} to="/admin/organizations/$clientId" />
        }
        tooltip={unread === null ? name : `${name}: ${unread.words}`}
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
    </SidebarMenuItem>
  );
};

const AdminSidebar = ({ admins }: { admins: readonly ClientAdmin[] }) => {
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
    <Sidebar collapsible="icon" label="Admin" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/admin" />}
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
                  <PlaceItem key={place.to} place={place} />
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
                {admins.map((admin) => (
                  <OrganizationItem admin={admin} key={admin.client.id} />
                ))}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/" />}
              tooltip="Back to the console"
            >
              <ArrowLeftIcon />
              <span>Back to the console</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
};

/**
 * The admin's frame around its pages: its sidebar beside the page, which
 * scrolls inside it so its bar stays in view, as the platform's frame does.
 */
export const AdminFrame = ({ admins }: { admins: readonly ClientAdmin[] }) => (
  <TooltipProvider>
    <SidebarProvider className="h-svh">
      <AdminSidebar admins={admins} />
      <SidebarInset className="min-h-0 min-w-0 overflow-y-auto">
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  </TooltipProvider>
);
