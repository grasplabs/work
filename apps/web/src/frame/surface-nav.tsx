import type { SidebarApp } from "@grasp-os/shared/screens";
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
import { openingState } from "../screens/screen-navigate.ts";

// The Apps' sidebar surfaces (spec 34.1), under Domains in the shell's
// sidebar: each App that declares any, by name, its entries under it. An
// entry opens its screen in the main pane by its route and surface, with
// nothing as input, which opening checks with core as any screen; listing
// them opens nothing. Read once as the sidebar shows; none while core
// doesn't answer.

/** The Apps with sidebar entries, as core lists them for the person. */
const useSidebarApps = (core: CoreConnection): SidebarApp[] => {
  const [apps, setApps] = useState<SidebarApp[]>([]);
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      const found = await loadFromCore(
        core,
        async (session) => await session.screens.sidebar(),
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
      render={<Link params={{ engine: app.app }} to="/domains/$engine" />}
    >
      <span className="truncate">{app.name}</span>
    </SidebarMenuSubButton>
    <SidebarMenuSub>
      {app.entries.map((entry) => (
        <SidebarMenuSubItem key={entry.name}>
          <SidebarMenuSubButton
            render={
              <Link
                params={{ engine: app.app, screen: entry.screen }}
                state={openingState(app.app, {
                  screen: entry.screen,
                  route: entry.route,
                  input: {},
                  surface: entry.name,
                })}
                to="/domains/$engine/apps/$screen"
              />
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

/** The Apps' sidebar entries, under Domains; nothing when there are none. */
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
      <p className="text-muted-foreground px-2 pt-1 text-xs">
        <Trans>From your domains</Trans>
      </p>
      <SidebarMenuSub aria-label={t`Domain shortcuts`}>
        {apps.map((app) => (
          <AppEntries app={app} key={app.app} />
        ))}
      </SidebarMenuSub>
    </SidebarMenuItem>
  );
};
