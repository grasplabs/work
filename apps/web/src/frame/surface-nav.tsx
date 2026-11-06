import type { SidebarApp } from "@grasp-os/shared/pages";
import {
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@grasp-os/ui/components/sidebar";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { appSplat } from "../pages/app-address.ts";

// The Apps' sidebar surfaces (spec 34.1), under Apps in the shell's
// sidebar: each App that declares any, by name, its entries under it. An
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

/** One App's entry, its sidebar surfaces under it. */
const AppEntries = ({ app }: { app: SidebarApp }) => (
  <SidebarMenuSubItem>
    <SidebarMenuSubButton
      render={<Link params={{ app: app.app }} to="/apps/$app" />}
    >
      <span className="truncate">{app.name}</span>
    </SidebarMenuSubButton>
    <SidebarMenuSub>
      {app.entries.map((entry) => (
        <SidebarMenuSubItem key={entry.path}>
          <SidebarMenuSubButton
            render={
              appSplat(entry.path) === "" ? (
                <Link params={{ app: app.app }} to="/apps/$app" />
              ) : (
                <Link
                  params={{ app: app.app, _splat: appSplat(entry.path) }}
                  to="/apps/$app/pages/$"
                />
              )
            }
            size="sm"
          >
            <span className="truncate">{entry.title}</span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ))}
    </SidebarMenuSub>
  </SidebarMenuSubItem>
);

/** The Apps' sidebar entries, under Apps; nothing when there are none. */
export const SurfaceNav = ({ core }: { core: CoreConnection }) => {
  const apps = useSidebarApps(core);
  const { t } = useLingui();
  if (apps.length === 0) {
    return null;
  }
  return (
    <SidebarMenuItem>
      {/* Said in so many words: below are the Apps' own entries, not
          Grasp's, whatever an App calls them. */}
      <p className="text-sidebar-foreground/70 px-2 pt-1 text-xs">
        <Trans>From your Apps</Trans>
      </p>
      <SidebarMenuSub aria-label={t`App shortcuts`}>
        {apps.map((app) => (
          <AppEntries app={app} key={app.app} />
        ))}
      </SidebarMenuSub>
    </SidebarMenuItem>
  );
};
