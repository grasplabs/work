import type { Organization } from "@grasp-os/shared/organization";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@grasp-os/ui/components/sidebar";
import { Link } from "@tanstack/react-router";
import { useEffect, useSyncExternalStore } from "react";

import { readWithin } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { GraspMark } from "../grasp-mark.tsx";

// The sidebar's header, as the prototype's (`app-sidebar.tsx`): the mark,
// and the organization's name over "Grasp", the product it works in.
// Until core says the name, or when it has none, "Grasp" alone. Read from
// core as the shell mounts, and changed at once when an admin renames the
// organization on this page (`organizationRenamed`), so the header never
// shows a name the page itself just replaced.

/** The organization's name as the header shows it, for the tab. */
let shownName: string | undefined;

const listeners = new Set<() => void>();

/** Shows `name` as the organization's: core's answer, or a rename just saved. */
const showName = (name: string | undefined): void => {
  if (name === shownName) {
    return;
  }
  shownName = name;
  for (const listener of listeners) {
    listener();
  }
};

/**
 * Tells the header the organization's name changed on this page: the
 * Workspace settings call it once core saved a new name.
 */
export const organizationRenamed = (name: string): void => {
  showName(name.trim() === "" ? undefined : name);
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The organization's name, or none when it has none or core couldn't say. Outside the component, as the React Compiler can't compile `try`. */
const nameOf = async (
  organization: () => Promise<Organization>
): Promise<string | undefined> => {
  try {
    const { name } = await organization();
    return name.trim() === "" ? undefined : name;
  } catch {
    return undefined;
  }
};

/** The header's link home, with `name` over "Grasp" when there is one. */
export const SidebarBrandView = ({ name }: { name?: string }) => (
  <SidebarMenu>
    <SidebarMenuItem>
      <SidebarMenuButton render={<Link to="/" />} size="lg">
        <span className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
          <GraspMark className="size-4" />
        </span>
        {name === undefined ? (
          <span className="truncate font-medium">Grasp</span>
        ) : (
          <span className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">{name}</span>
            <span className="text-muted-foreground truncate text-xs">
              Grasp
            </span>
          </span>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  </SidebarMenu>
);

/**
 * The header, reading the organization's name once with `organization`,
 * and showing any rename since (`organizationRenamed`).
 */
export const SidebarBrandOf = ({
  organization,
}: {
  organization: () => Promise<Organization>;
}) => {
  const name = useSyncExternalStore(subscribe, () => shownName);
  useEffect(() => {
    let current = true;
    const read = async (): Promise<void> => {
      const named = await nameOf(organization);
      if (current) {
        showName(named);
      }
    };
    void read();
    return () => {
      current = false;
    };
  }, [organization]);
  return <SidebarBrandView name={name} />;
};

/** The header, reading the organization's name from core once. */
export const SidebarBrand = ({ core }: { core: CoreConnection }) => (
  <SidebarBrandOf
    organization={async () =>
      await readWithin(
        core,
        async (session) => await session.organization.get()
      )
    }
  />
);
