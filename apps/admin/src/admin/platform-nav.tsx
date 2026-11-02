/**
 * Platform's own places, as its pages link them: its overview (the
 * channels, every company and what Grasp's own AI costs), every release
 * the admin imported, and the offboarded clients.
 */
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
} from "@grasp-os/ui/components/navigation-menu";
import { Link, useMatchRoute } from "@tanstack/react-router";

import type { Crumb } from "./page.tsx";

/** Platform, above its releases in the bar. */
export const platformCrumb: Crumb = {
  label: "Platform",
  link: <Link to="/platform" />,
};

/** The releases, above one release or a comparison in the bar. */
export const releasesCrumb: Crumb = {
  label: "Releases",
  link: <Link to="/platform/releases" />,
};

/** Platform's places, in the order its navigation shows them. */
const platformPlaces = [
  { to: "/platform", label: "Overview" },
  { to: "/platform/releases", label: "Releases" },
  { to: "/platform/offboarded", label: "Offboarded" },
] as const;

/**
 * Platform's places as links under a page's title, looking as line tabs
 * do: the one shown, or the one above it, is the current page. Its
 * overview is only itself.
 */
export const PlatformNav = () => {
  const matchRoute = useMatchRoute();
  const shown =
    platformPlaces.find(
      ({ to }) => matchRoute({ to, fuzzy: to !== "/platform" }) !== false
    )?.to ?? "/platform";
  return (
    <NavigationMenu aria-label="Platform">
      <NavigationMenuList variant="line">
        {platformPlaces.map(({ to, label }) => (
          <NavigationMenuItem key={to}>
            <NavigationMenuLink
              active={to === shown}
              render={
                <Link activeOptions={{ exact: to === "/platform" }} to={to} />
              }
              variant="line"
            >
              {label}
            </NavigationMenuLink>
          </NavigationMenuItem>
        ))}
      </NavigationMenuList>
    </NavigationMenu>
  );
};

/** Where the overview holds its channels, to promote a release, for a link to it. */
export const channelsId = "channels";
