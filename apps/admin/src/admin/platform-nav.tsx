/**
 * Platform's own places, as its pages link them: its overview (the
 * Platform page), every release the admin imported, every rollout, the
 * offboarded clients and the hosting destinations,
 * each a page of its own under Platform, as the admin's Releases and
 * Rollouts pages were before the admin took them in.
 */
import { Tabs, TabsList, TabsTrigger } from "@grasp-os/ui/components/tabs";
import {
  getRouteApi,
  Link,
  rootRouteId,
  useMatchRoute,
} from "@tanstack/react-router";

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

/** Platform's places, in the order its tabs show them. */
const platformPlaces = [
  { to: "/platform", label: "Overview" },
  { to: "/platform/releases", label: "Releases" },
  { to: "/platform/rollouts", label: "Rollouts" },
  { to: "/platform/offboarded", label: "Offboarded" },
] as const;

/**
 * Platform's places as tabs under a page's title, as the workspace's
 * pages show theirs: the one shown, or the one above it, marked. Its
 * overview is only itself.
 */
export const PlatformNav = () => {
  const matchRoute = useMatchRoute();
  const shown =
    platformPlaces.find(
      ({ to }) => matchRoute({ to, fuzzy: to !== "/platform" }) !== false
    )?.to ?? "/platform";
  return (
    <Tabs value={shown}>
      <TabsList aria-label="Platform" variant="line">
        {platformPlaces.map(({ to, label }) => (
          <TabsTrigger
            key={to}
            nativeButton={false}
            render={<Link to={to} />}
            value={to}
          >
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
};

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
