import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { lazy, Suspense, useSyncExternalStore } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { entryNow, subscribeEntry } from "../onboarding/entry-store.ts";
import { loadPartsFor } from "../page-parts.ts";

// The way from the setup into the platform, which outlives both pages:
// loaded only once the setup's last screen asks for it.
const PlatformEntry = lazy(async () => {
  const entry = await import("../onboarding/platform-entry.tsx");
  return { default: entry.PlatformEntry };
});

const Root = () => {
  const entering = useSyncExternalStore(
    subscribeEntry,
    () => entryNow() !== null,
    () => false
  );
  return (
    <>
      <Outlet />
      {entering ? (
        <Suspense fallback={null}>
          <PlatformEntry />
        </Suspense>
      ) : null}
    </>
  );
};

/** What every route gets from the router: the tab's connection to core. */
interface RouterContext {
  core: CoreConnection;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  // The lean page the tab started on (lean-pages.ts) has what it needs
  // from the start; any other needs the whole stylesheet and catalog
  // first, once.
  beforeLoad: async ({ location }) => {
    await loadPartsFor(location.pathname);
  },
  component: Root,
});
