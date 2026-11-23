import type { SidebarApp } from "@grasp-os/shared/pages";
import {
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  SidebarCollapsible,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@grasp-os/ui/components/sidebar";
import { ChevronDownIcon, Icon, LayoutGridIcon } from "@grasp-os/ui/lib/icons";
import { Trans } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { appSplat } from "../pages/app-address.ts";

// The Apps' sidebar surfaces (spec 34.1), a group of their own in the
// shell's sidebar, which folds under its label as the person leaves it
// (Damsko's SidebarCollapsible, kept with the sidebar's own choices): each
// App that declares any, by name, its entries under it. An
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

const styles = stylex.create({
  // The fold's mark, at the label's end.
  chevron: { display: "inline-flex", marginInlineStart: "auto" },
});

/** One App, its sidebar entries under it. */
const AppEntries = ({ app }: { app: SidebarApp }) => {
  const matchRoute = useMatchRoute();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={
          matchRoute({
            to: "/apps/$app",
            params: { app: app.app },
            fuzzy: true,
          }) !== false
        }
      >
        <Link params={{ app: app.app }} to="/apps/$app">
          <Icon icon={LayoutGridIcon} />
          {app.name}
        </Link>
      </SidebarMenuButton>
      <SidebarMenuSub>
        {app.entries.map((entry) => {
          const splat = appSplat(entry.path);
          return (
            <SidebarMenuSubItem key={entry.path}>
              <SidebarMenuSubButton asChild>
                {splat === "" ? (
                  <Link params={{ app: app.app }} to="/apps/$app">
                    {entry.title}
                  </Link>
                ) : (
                  <Link
                    params={{ app: app.app, _splat: splat }}
                    to="/apps/$app/pages/$"
                  >
                    {entry.title}
                  </Link>
                )}
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
    <SidebarCollapsible name="apps">
      <SidebarGroup>
        {/* Said in so many words: below are the Apps' own entries, not
            Grasp's, whatever an App calls them. */}
        <CollapsibleTrigger asChild>
          <SidebarGroupLabel asChild>
            <button id={labelId} type="button">
              <Trans>From your Apps</Trans>
              <span aria-hidden="true" {...stylex.props(styles.chevron)}>
                <Icon icon={ChevronDownIcon} />
              </span>
            </button>
          </SidebarGroupLabel>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenu aria-labelledby={labelId}>
            {apps.map((app) => (
              <AppEntries app={app} key={app.app} />
            ))}
          </SidebarMenu>
        </CollapsibleContent>
      </SidebarGroup>
    </SidebarCollapsible>
  );
};
