import type { Identity } from "@grasp-os/shared/rpc";
import { SidebarInset, SidebarProvider } from "@grasp-os/ui/components/sidebar";
import { TooltipProvider } from "@grasp-os/ui/components/tooltip";
import { useState } from "react";
import type { ReactNode } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { keepFolded, readFolded } from "../fold.ts";
import { AppSidebar } from "./app-sidebar.tsx";
import { InFrame } from "./in-frame.ts";

/**
 * The signed-in product's frame: the app's sidebar beside the page, which
 * scrolls inside it so its site header stays in view. The shell's pages
 * are in it, and a page outside the shell for someone signed in, such as
 * a decision opened from a link.
 */
export const AppFrame = ({
  core,
  identity,
  children,
}: {
  core: CoreConnection;
  identity: Identity;
  children: ReactNode;
}) => {
  // Folded as the person left it in this browser.
  const [open, setOpen] = useState(() => readFolded("sidebar") !== true);
  return (
    <TooltipProvider>
      <SidebarProvider
        className="h-svh"
        onOpenChange={(next) => {
          setOpen(next);
          void keepFolded("sidebar", !next);
        }}
        open={open}
      >
        <AppSidebar core={core} identity={identity} />
        <SidebarInset className="min-h-0 min-w-0 overflow-y-auto">
          <InFrame value>{children}</InFrame>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
};
