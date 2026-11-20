import { useMatchRoute, useRouterState } from "@tanstack/react-router";
import type { UseMatchRouteOptions } from "@tanstack/react-router";

/** A route a match names, as `useMatchRoute` takes it. */
export type RouteTo = UseMatchRouteOptions["to"];

/**
 * `useMatchRoute`, against the newest address: the one being loaded while a
 * page loads (its pending state shows at once, main.tsx), else the one shown.
 * TanStack's `pending: true` matches only while something loads, and false
 * after, so it is set from the router's own state.
 */
export const useMatchLatest = (): ((
  opts: Omit<UseMatchRouteOptions, "pending">
) => false | Record<string, string>) => {
  const matchRoute = useMatchRoute();
  const loading = useRouterState({
    select: (state) => state.status === "pending",
  });
  return (opts) => matchRoute({ ...opts, pending: loading });
};
