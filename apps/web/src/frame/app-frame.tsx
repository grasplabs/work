import type { Identity } from "@grasp-os/shared/rpc";
import {
  AppShell,
  AppShellContent,
  AppShellDock,
  AppShellMain,
} from "@grasp-os/ui/components/app-shell";
import { Toaster } from "@grasp-os/ui/components/toast";
import { TooltipProvider } from "@grasp-os/ui/components/tooltip";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactNode } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { keepFolded, readFolded } from "../fold.ts";
import {
  FrameStyleProvider,
  readFrameStyle,
} from "../grasp/frame/frame-style.ts";
import { frame } from "../grasp/frame/frame.stylex.ts";
import { GraspSidebar } from "../grasp/frame/grasp-sidebar.tsx";
import { media } from "../grasp/tokens/tokens.stylex.ts";
import { TourLayer } from "../tour/tour-layer.tsx";
import { useTour } from "../tour/tour-state.ts";
import { AiKeyBanner, providersOf } from "./ai-key-banner.tsx";
import type { FailingProvider } from "./ai-key-banner.tsx";
import { AppSidebar } from "./app-sidebar.tsx";
import { InFrame } from "./in-frame.ts";

// Grasp UI's frame: the sidebar on the window's ground, the page a card on
// it a hair off the window's edges, lifted by a hair (frame.stylex.ts).
const styles = stylex.create({
  shell: {
    backgroundColor: frame.ground,
  },
  // On a phone the sidebar is a sheet: the card is the whole window.
  card: {
    margin: { default: frame.inset, [media.belowTablet]: 0 },
    borderRadius: { default: frame.cardCorner, [media.belowTablet]: 0 },
    backgroundColor: frame.card,
    boxShadow: { default: frame.cardShadow, [media.belowTablet]: "none" },
  },
});

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
  // oxlint-disable-next-line react/hook-use-state -- read once, never set
  const [style] = useState(readFrameStyle);
  const { phase } = useTour();
  const touring = phase === "opening" || phase === "running";
  return (
    // What the frame says of an action outside any page, such as a
    // sign-out from the person menu that core didn't carry out.
    <Toaster>
      <TooltipProvider>
        <FrameStyleProvider value={style}>
          <AppShell
            {...(style.frame === "grasp" ? stylex.props(styles.shell) : {})}
            data-frame={style.frame}
            inert={touring}
            onOpenChange={(next) => {
              setOpen(next);
              void keepFolded("sidebar", !next);
            }}
            open={open}
          >
            {style.frame === "grasp" ? (
              <GraspSidebar core={core} identity={identity} />
            ) : (
              <AppSidebar core={core} identity={identity} />
            )}
            <AppShellMain
              {...(style.frame === "grasp" ? stylex.props(styles.card) : {})}
              covered={covered}
            >
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
        </FrameStyleProvider>
        <TourLayer identity={identity} />
      </TooltipProvider>
    </Toaster>
  );
};
