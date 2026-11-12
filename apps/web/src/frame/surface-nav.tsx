import type { SidebarApp } from "@grasp-os/shared/pages";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@grasp-os/ui/components/sidebar";
import { Trans } from "@lingui/react/macro";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { AppWindowIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { appSplat } from "../pages/app-address.ts";

// The Apps' sidebar surfaces (spec 34.1), a group of their own in the
// shell's sidebar: each App that declares any, by name, its entries under it. An
// entry opens the App's page at the entry's route (pages/app-address.ts),
// which opening checks with core as any address; listing them opens
// nothing. Read once as the sidebar shows; none while core doesn't
// answer.

/** The Apps with sidebar entries, as core lists them for the person. */
const useSidebarApps = (core: CoreConnection): SidebarApp[] => {
  const [apps, setApps] = useState<SidebarApp[]>([]);
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      const found = await loadFromCore(
        core,
        async (session) => await session.pages.sidebar(),
        left.signal
      );
      if (!left.signal.aborted && found.state === "ready") {
        setApps(found.data);
      }
    };
    void read();
    return () => {
      left.abort();
    };
  }, [core]);
  return apps;
};

/** One App, its sidebar entries under it. */
const AppEntries = ({ app }: { app: SidebarApp }) => {
  const matchRoute = useMatchRoute();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={
          matchRoute({
            to: "/apps/$app",
            params: { app: app.app },
            fuzzy: true,
          }) !== false
        }
        render={<Link params={{ app: app.app }} to="/apps/$app" />}
        tooltip={app.name}
      >
        <AppWindowIcon />
        <span>{app.name}</span>
      </SidebarMenuButton>
      <SidebarMenuSub>
        {app.entries.map((entry) => {
          const splat = appSplat(entry.path);
          return (
            <SidebarMenuSubItem key={entry.path}>
              <SidebarMenuSubButton
                render={
                  splat === "" ? (
                    <Link params={{ app: app.app }} to="/apps/$app" />
                  ) : (
                    <Link
                      params={{ app: app.app, _splat: splat }}
                      to="/apps/$app/pages/$"
                    />
                  )
                }
                size="sm"
              >
                <span className="truncate">{entry.title}</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          );
        })}
      </SidebarMenuSub>
    </SidebarMenuItem>
  );
};

/**
 * The Apps' sidebar entries, a group of their own under the sections;
 * nothing when there are none.
 */
export const SurfaceNav = ({ core }: { core: CoreConnection }) => {
  const apps = useSidebarApps(core);
  const labelId = useId();
  if (apps.length === 0) {
    return null;
  }
  return (
    <SidebarGroup>
      {/* Said in so many words: below are the Apps' own entries, not
          Grasp's, whatever an App calls them. */}
      <SidebarGroupLabel id={labelId}>
        <Trans>From your Apps</Trans>
      </SidebarGroupLabel>
      <SidebarMenu aria-labelledby={labelId}>
        {apps.map((app) => (
          <AppEntries app={app} key={app.app} />
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
};
