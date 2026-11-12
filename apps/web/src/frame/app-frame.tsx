import type { Identity } from "@grasp-os/shared/rpc";
import {
  AppShell,
  AppShellContent,
  AppShellDock,
  AppShellMain,
} from "@grasp-os/ui/components/app-shell";
import { Toaster } from "@grasp-os/ui/components/toast";
import { TooltipProvider } from "@grasp-os/ui/components/tooltip";
import { useState } from "react";
import type { ReactNode } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { keepFolded, readFolded } from "../fold.ts";
import { TourLayer } from "../tour/tour-layer.tsx";
import { useTour } from "../tour/tour-state.ts";
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
  const { phase } = useTour();
  const touring = phase === "opening" || phase === "running";
  return (
    // What the frame says of an action outside any page, such as a
    // sign-out from the person menu that core didn't carry out.
    <Toaster>
      <TooltipProvider>
        <AppShell
          inert={touring}
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
        <TourLayer identity={identity} />
      </TooltipProvider>
    </Toaster>
  );
};
