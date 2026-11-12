"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { SidebarInset, SidebarProvider } from "@grasp-os/ui/components/sidebar";
import { cn } from "@grasp-os/ui/lib/utils";
import * as React from "react";

// The app's frame: the main area, the page as a card lying on the
// sidebar's ink, with Panels on its edges that open and collapse, taking
// their space from it rather than covering it (the sidebar on the left, the
// chat docked on the right; a Panel on the top or bottom works the same
// way). Over the main area, centred at its foot, a dock for what stays at
// hand on every page (the chat's idle bar). The page's content is the
// document's main landmark; the dock beside it is not. A panel gone full
// screen (DockablePanel's `fullscreen`) covers the main area beside the
// sidebar: its card stays as the panel's ground while its content fades
// out (`covered`), and the shell publishes where that card starts
// (`--app-shell-main-left`) for it. On a phone the sidebar is a
// sheet and a docked panel takes the whole screen.
//
//   <AppShell>
//     <Sidebar collapsible="icon" variant="inset">…</Sidebar>
//     <AppShellMain>
//       <AppShellContent>{page}</AppShellContent>
//       <AppShellDock>{bar}</AppShellDock>
//     </AppShellMain>
//     <Panel side="right" open={docked} size={width}>
//       <DockablePanel open placement="docked" label="Chat">…</DockablePanel>
//     </Panel>
//   </AppShell>

function AppShell({
  className,
  ...props
}: React.ComponentProps<typeof SidebarProvider>) {
  return <SidebarProvider className={cn("h-svh", className)} {...props} />;
}

/**
 * The main area, the page's card: its content scrolls inside it, under the
 * dock. `covered`, a panel lies over it: its content fades out and takes no
 * presses or keys, while the card stays.
 */
function AppShellMain({
  covered = false,
  className,
  ...props
}: React.ComponentProps<"div"> & { covered?: boolean }) {
  const main = React.useRef<HTMLDivElement>(null);
  // Where the card starts, on the shell, for a panel gone full screen over
  // it: as the sidebar folds or the window resizes, its size changes too.
  React.useEffect(() => {
    const element = main.current;
    const shell = element?.parentElement;
    if (!(element && shell)) {
      return () => {
        // Nothing observed.
      };
    }
    const publish = () => {
      shell.style.setProperty(
        "--app-shell-main-left",
        `${element.getBoundingClientRect().left}px`
      );
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return (
    <SidebarInset
      ref={main}
      data-slot="app-shell-main"
      data-covered={covered}
      inert={covered}
      render={<div />}
      className={cn("min-h-0 min-w-0 overflow-hidden", className)}
      {...props}
    />
  );
}

/**
 * The page's content, which scrolls in its card: the document's `main`
 * (`render` another element where something around it is already). Only up
 * and down: what is wider than the page is cut at its edge, rather than
 * sliding the page sideways. Covered, it fades out as the panel comes over
 * it, and back in a beat after the panel starts to leave, once that is
 * mostly out of the way, on the sidebar's curve, as the panel moves.
 */
function AppShellContent({
  className,
  render,
  ...props
}: useRender.ComponentProps<"main">) {
  return useRender({
    defaultTagName: "main",
    props: mergeProps<"main">(
      {
        className: cn(
          "ease-sidebar flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto transition-opacity delay-(--motion-stagger) duration-(--motion-duration) in-data-[covered=true]:opacity-0 in-data-[covered=true]:delay-0 motion-reduce:transition-none",
          className
        ),
      },
      props
    ),
    render,
    state: { slot: "app-shell-content" },
  });
}

/**
 * Over the page, centred at its foot, clear of its edges: what stays at
 * hand on every page. It lets presses through where it has nothing.
 */
function AppShellDock({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="app-shell-dock"
      className={cn(
        "pointer-events-none absolute inset-x-4 bottom-4 z-30 flex justify-center *:pointer-events-auto",
        className
      )}
      {...props}
    />
  );
}

export { AppShell, AppShellContent, AppShellDock, AppShellMain };
