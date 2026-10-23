import type { Identity } from "@grasp-os/shared/rpc";
import { SidebarInset, SidebarProvider } from "@grasp-os/ui/components/sidebar";
import { Toaster } from "@grasp-os/ui/components/toast";
import { TooltipProvider } from "@grasp-os/ui/components/tooltip";
import { useState } from "react";
import type { ReactNode } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { keepFolded, readFolded } from "../fold.ts";
import { TourLayer } from "../tour/tour-layer.tsx";
import { useTour } from "../tour/tour-state.ts";
import { AppSidebar } from "./app-sidebar.tsx";
import { InFrame } from "./in-frame.ts";

/**
 * The signed-in product's frame: the app's sidebar beside the page, which
 * scrolls inside it so its site header stays in view. The shell's pages
 * are in it, and a page outside the shell for someone signed in, such as
 * a decision opened from a link.
 *
 * While Stephen gives the tour, from his question whether the person is
 * ready to its end, the frame is inert: no press or key reaches a page
 * under him, as in the prototype. His card stands outside it, so it is
 * what is left to use. His offer alone doesn't hold it: the person may
 * pass it by and ask their own question.
 */
export const AppFrame = ({
  core,
  identity,
  aside,
  children,
}: {
  core: CoreConnection;
  identity: Identity;
  /** Beside the page, over it: the shell's chat dock. */
  aside?: ReactNode;
  children: ReactNode;
}) => {
  // Folded as the person left it in this browser.
  const [open, setOpen] = useState(() => readFolded("sidebar") !== true);
  const { phase } = useTour();
  const touring = phase === "opening" || phase === "running";
  return (
    // What the frame says of an action outside any page, such as a
    // sign-out from the person menu that core didn't carry out.
    <Toaster>
      <TooltipProvider>
        <SidebarProvider
          className="h-svh"
          inert={touring}
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
          {aside}
        </SidebarProvider>
        <TourLayer identity={identity} />
      </TooltipProvider>
    </Toaster>
  );
};
