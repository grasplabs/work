/**
 * Platform's own places, as its pages link them: its overview (the
 * Platform page), every release the admin imported, every rollout, the
 * offboarded clients and the hosting destinations,
 * each a page of its own under Platform, as the admin's Releases and
 * Rollouts pages were before the admin took them in.
 */
import { buttonVariants } from "@grasp-os/ui/components/button";
import { getRouteApi, Link, rootRouteId } from "@tanstack/react-router";

import type { RolloutSummary } from "../rollout/queries.ts";
import type { Crumb } from "./page.tsx";

/** Platform, above its releases and rollouts in the bar. */
export const platformCrumb: Crumb = {
  label: "Platform",
  link: <Link to="/platform" />,
};

/** The releases, above one release or a comparison in the bar. */
export const releasesCrumb: Crumb = {
  label: "Releases",
  link: <Link to="/platform/releases" />,
};

/** The rollouts, above one rollout in the bar. */
export const rolloutsCrumb: Crumb = {
  label: "Rollouts",
  link: <Link to="/platform/rollouts" />,
};

const tab = buttonVariants({ variant: "ghost", size: "sm" });
const activeTab = buttonVariants({ variant: "secondary", size: "sm" });

/**
 * Platform's places in a row under a page's title: the one shown, or the
 * one above it, marked. Its overview is only itself.
 */
export const PlatformNav = () => (
  <nav aria-label="Platform" className="-ml-2.5 flex flex-wrap gap-1">
    <Link
      activeOptions={{ exact: true }}
      activeProps={{ className: activeTab }}
      inactiveProps={{ className: tab }}
      to="/platform"
    >
      Overview
    </Link>
    <Link
      activeProps={{ className: activeTab }}
      inactiveProps={{ className: tab }}
      to="/platform/releases"
    >
      Releases
    </Link>
    <Link
      activeProps={{ className: activeTab }}
      inactiveProps={{ className: tab }}
      to="/platform/rollouts"
    >
      Rollouts
    </Link>
    <Link
      activeProps={{ className: activeTab }}
      inactiveProps={{ className: tab }}
      to="/platform/offboarded"
    >
      Offboarded
    </Link>
  </nav>
);

/** Where the rollouts page holds its form to start one, for a link to it. */
export const startRolloutId = "start-a-rollout";

/** A rollout's status, as the admin says it. */
export const rolloutStatusWords: Record<RolloutSummary["status"], string> = {
  running: "Rolling out",
  waiting: "Waits",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** What a rollout takes out: its release, or the shared secrets alone. */
export const rolloutWhatWords = (
  rollout: Pick<RolloutSummary, "kind" | "releaseId">
): string =>
  rollout.kind === "secrets" ? "New secrets" : (rollout.releaseId ?? "");

const adminRoute = getRouteApi(rootRouteId);

/**
 * Each company's name by its client id, as the admin's frame read them:
 * a page under Platform names a company rather than its id.
 */
export const useCompanyNames = (): ReadonlyMap<string, string> => {
  const { admins } = adminRoute.useLoaderData();
  return new Map(admins.map(({ client }) => [client.id, client.name]));
};
