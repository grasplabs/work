import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@grasp-os/ui/components/sidebar";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { readWithin } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { GraspMark } from "../grasp-mark.tsx";

// The sidebar's header, as the prototype's (`app-sidebar.tsx`): the mark,
// and the organization's name over "Grasp", the product it works in.
// Until core says the name, or when it has none, "Grasp" alone.

/** The organization's name, or none when core couldn't say. Outside the component, as the React Compiler can't compile `try`. */
const readName = async (core: CoreConnection): Promise<string | undefined> => {
  try {
    const { name } = await readWithin(
      core,
      async (session) => await session.organization.get()
    );
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

/** The header, reading the organization's name from core once. */
export const SidebarBrand = ({ core }: { core: CoreConnection }) => {
  const [name, setName] = useState<string>();
  useEffect(() => {
    let current = true;
    const read = async (): Promise<void> => {
      const named = await readName(core);
      if (current) {
        setName(named);
      }
    };
    void read();
    return () => {
      current = false;
    };
  }, [core]);
  return <SidebarBrandView name={name} />;
};
