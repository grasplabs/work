import { GraspMark } from "@grasp-os/ui/components/grasp-mark";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@grasp-os/ui/components/sidebar";
import type * as React from "react";

/**
 * The head of Grasp's sidebar, the same in the platform and the admin: the
 * app icon, the mark on its pale lime tile, and `title` over `subtitle`
 * (the organization's name over "Grasp", or "Grasp" over "Admin"), as one
 * way home. `render` is the link home.
 */
function BrandHeader({
  title,
  subtitle,
  render,
  tooltip,
}: {
  title: string;
  subtitle?: string;
  render?: React.ComponentProps<typeof SidebarMenuButton>["render"];
  /** What the icon says when the sidebar is folded to its icons. */
  tooltip?: string;
}) {
  return (
    <SidebarMenu data-slot="brand-header">
      <SidebarMenuItem>
        <SidebarMenuButton render={render} size="lg" tooltip={tooltip}>
          <span className="bg-icon-tile text-icon-tile-foreground flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg">
            <GraspMark className="size-4" />
          </span>
          {subtitle === undefined ? (
            <span className="truncate font-medium">{title}</span>
          ) : (
            <span className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{title}</span>
              <span className="text-sidebar-foreground/70 truncate text-xs">
                {subtitle}
              </span>
            </span>
          )}
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export { BrandHeader };
