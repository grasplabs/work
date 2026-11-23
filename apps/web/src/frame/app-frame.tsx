import {
  AppShell,
  AppShellContent,
  AppShellDock,
  AppShellMain,
} from "@grasp-os/app-kit/components/app-shell";
import { Toaster as KitToaster } from "@grasp-os/app-kit/components/toast";
import { TooltipProvider } from "@grasp-os/app-kit/components/tooltip";
import type { Identity } from "@grasp-os/shared/rpc";
import { Toaster } from "@grasp-os/ui/components/toast";
import { useState } from "react";
import type { ReactNode } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { keepFolded, readFolded } from "../fold.ts";
import { AiKeyBanner, providersOf } from "./ai-key-banner.tsx";
import type { FailingProvider } from "./ai-key-banner.tsx";
import { AppSidebar } from "./app-sidebar.tsx";
import { InFrame } from "./in-frame.ts";

/**
 * The signed-in product's frame (the kit's AppShell): the app's sidebar
 * beside the page, which scrolls inside its card so its site header stays
 * in view; over the page, at its foot, what stays at hand on every page
 * (`dock`); and beside or over the page, its panels (`panels`): an App's
 * page opened beside it, and Grasp's chat. The shell's pages are in it,
 * with all of them, and a page
 * outside the shell for someone signed in, such as a decision opened from
 * a link, with none of them.
 */
export const AppFrame = ({
  core,
  identity,
  failing,
  dock,
  panels,
  covered = false,
  children,
}: {
  core: CoreConnection;
  identity: Identity;
  /** The AI providers that fail, read before the page showed (`failingUpFront`). */
  failing?: FailingProvider[];
  /** Over the page, centred at its foot: the chat's idle bar. */
  dock?: ReactNode;
  /** Beside or over the page: an App's page opened beside it, and the chat. */
  panels?: ReactNode;
  /** A panel is full screen over the page, whose content fades out under it. */
  covered?: boolean;
  children: ReactNode;
}) => {
  // Folded as the person left it in this browser.
  const [open, setOpen] = useState(() => readFolded("sidebar") !== true);
  return (
    // What the frame says of an action outside any page, such as a
    // sign-out from the person menu that core didn't carry out.
    <KitToaster>
      <TooltipProvider>
        <AppShell
          onOpenChange={(next) => {
            setOpen(next);
            void keepFolded("sidebar", !next);
          }}
          open={open}
        >
          <AppSidebar core={core} identity={identity} />
          <AppShellMain covered={covered}>
            <AppShellContent>
              <AiKeyBanner
                failing={failing}
                identity={identity}
                providers={providersOf(core)}
              />
              <InFrame value>{children}</InFrame>
            </AppShellContent>
            {dock === undefined ? null : <AppShellDock>{dock}</AppShellDock>}
          </AppShellMain>
          {panels}
        </AppShell>
      </TooltipProvider>
      {/* Damsko's toasts, for the pages on it (the Brain's). */}
      <Toaster />
    </KitToaster>
  );
};
