/**
 * Platform's own places, as its pages link them: its overview (the
 * channels, the companies that need a look and what Grasp's own AI costs),
 * every release the admin imported, the offboarded clients, and its
 * maintenance (shared secrets, and what staff did).
 */
import { TabsLink, TabsNav } from "@grasp-os/ui/components/tabs";
import { Link, useMatchRoute } from "@tanstack/react-router";

import type { Crumb } from "./page.tsx";

/** Platform, above its releases in the bar. */
export const platformCrumb: Crumb = { label: "Platform", to: "/platform" };

/** The releases, above one release or a comparison in the bar. */
export const releasesCrumb: Crumb = {
  label: "Releases",
  to: "/platform/releases",
};

/** Platform's places, in the order its navigation shows them. */
const platformPlaces = [
  { to: "/platform", label: "Overview" },
  { to: "/platform/releases", label: "Releases" },
  { to: "/platform/offboarded", label: "Offboarded" },
  { to: "/platform/maintenance", label: "Maintenance" },
] as const;

/**
 * Platform's places as links under a page's title, drawn as line tabs
 * (Damsko's TabsNav): the one shown, or the one above it, is the current
 * page. Its overview is only itself.
 */
export const PlatformNav = () => {
  const matchRoute = useMatchRoute();
  const shown =
    platformPlaces.find(
      ({ to }) => matchRoute({ to, fuzzy: to !== "/platform" }) !== false
    )?.to ?? "/platform";
  return (
    <TabsNav aria-label="Platform" variant="line">
      {platformPlaces.map(({ to, label }) => (
        <TabsLink asChild current={to === shown} key={to}>
          {/* The overview only itself, so the router marks one link current, as `current` does. */}
          <Link activeOptions={{ exact: to === "/platform" }} to={to}>
            {label}
          </Link>
        </TabsLink>
      ))}
    </TabsNav>
  );
};

/** Where the overview holds its channels, to promote a release, for a link to it. */
export const channelsId = "channels";
