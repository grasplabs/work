/**
 * Platform's own places, as its pages link them: its overview (the
 * channels, the companies that need a look and what Grasp's own AI costs),
 * every release the admin imported, the offboarded clients, and its
 * maintenance (shared secrets, and what staff did).
 */
import { TabsLink, TabsNav } from "@grasp-os/ui/components/tabs";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link, useMatchRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { AdminPage } from "./page.tsx";
import type { Crumb } from "./page.tsx";

const styles = stylex.create({
  // The tabs, then the tab's parts a step further apart than the lines
  // within each, as an organization's Setup sets its tabs.
  page: { display: "flex", flexDirection: "column", gap: space["8"] },
  parts: { display: "flex", flexDirection: "column", gap: space["10"] },
});

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
const PlatformNav = () => {
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

/** A page of Platform's: its header, its tabs, then its parts. */
export const PlatformPage = ({
  title,
  description,
  action,
  parents,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  parents?: readonly Crumb[];
  children: ReactNode;
}) => (
  <AdminPage
    action={action}
    description={description}
    parents={parents}
    title={title}
  >
    <div {...stylex.props(styles.page)}>
      <PlatformNav />
      <div {...stylex.props(styles.parts)}>{children}</div>
    </div>
  </AdminPage>
);

/** Where the overview holds its channels, to promote a release, for a link to it. */
export const channelsId = "channels";
