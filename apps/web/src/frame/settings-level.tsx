import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarLevel,
  SidebarLevelHeader,
  SidebarLevelTitle,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@grasp-os/ui/components/sidebar";
import { ChevronLeftIcon, Icon, SettingsIcon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { Link, useMatchRoute } from "@tanstack/react-router";

import { groupsFor } from "../settings/sections.ts";
import { WayOut } from "./way-out.tsx";

/** The sidebar's level for Settings: what the SidebarLevels' `value` calls it. */
export const settingsLevel = "settings";

/**
 * Settings' own navigation, a level of the sidebar while a Settings page
 * is open (in its sheet on a phone): Back, out of Settings to the page the
 * person came from, then Settings' name, then its sections in their
 * groups, the workspace's for admins and the account's for everyone.
 */
export const SettingsLevel = ({ identity }: { identity: Identity }) => {
  const { t, i18n } = useLingui();
  const matchRoute = useMatchRoute();
  const groups = groupsFor({
    admin: isAdmin(identity.role),
    staff: identity.staff,
  });
  return (
    <SidebarLevel value={settingsLevel}>
      <SidebarLevelHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <WayOut>
                <Icon icon={ChevronLeftIcon} />
                {t`Back`}
              </WayOut>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarLevelTitle>
          <Icon icon={SettingsIcon} />
          {t`Settings`}
        </SidebarLevelTitle>
      </SidebarLevelHeader>
      <SidebarContent aria-label={t`Settings`}>
        {groups.map((group) => (
          <SidebarGroup key={group.id}>
            <SidebarGroupLabel>{i18n._(group.title)}</SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map(({ label, to, icon }) => {
                // Stephen is a name and stays as it is.
                const name = typeof label === "string" ? label : i18n._(label);
                return (
                  <SidebarMenuItem key={to}>
                    <SidebarMenuButton
                      asChild
                      isActive={matchRoute({ to, fuzzy: true }) !== false}
                    >
                      <Link to={to}>
                        <Icon icon={icon} />
                        {name}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
    </SidebarLevel>
  );
};
