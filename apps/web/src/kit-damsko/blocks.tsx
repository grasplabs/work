import { AppShell } from "@grasp-os/ui/blocks/app-shell-01/app-shell-01";
import { ConnectApiKey } from "@grasp-os/ui/blocks/connect-api-key-01/connect-api-key-01";
import { Inspector } from "@grasp-os/ui/blocks/inspector-01/inspector-01";
import { ShareDialog } from "@grasp-os/ui/blocks/share-dialog-01/share-dialog-01";
import { Button } from "@grasp-os/ui/components/button";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@grasp-os/ui/components/sidebar";

import type { Demos } from "./demo.ts";

// Damsko's four blocks, one small use of each, for the local gallery
// (routes/kit_.damsko.tsx).

const done = async (): Promise<void> => {
  await Promise.resolve();
};

const noop = (): void => {
  // A demo's control does nothing.
};

export const blockDemos: Demos = {
  // The shell is a whole page's frame: here it stands in a box of its own,
  // which holds what it would fix to the window.
  "app-shell-01": () => (
    <div className="relative h-96 transform-gpu overflow-hidden rounded-lg border">
      <AppShell
        sidebar={
          <SidebarContent>
            <SidebarGroup>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive>
                    <a href="#chat">Chat</a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>
        }
        title="Members"
      >
        <PageHeader title="Members" />
      </AppShell>
    </div>
  ),
  "connect-api-key-01": () => (
    <ConnectApiKey
      onConnect={done}
      providers={[{ id: "acme", name: "Acme AI" }]}
      title="Connect a model provider"
    />
  ),
  "inspector-01": () => (
    <Inspector
      aria-label="Details"
      sections={[
        {
          id: "about",
          title: "About",
          facts: [{ id: "owner", label: "Owner", value: "Anna de Vries" }],
        },
      ]}
      title="Invoice intake"
    />
  ),
  "share-dialog-01": () => (
    <ShareDialog
      levels={[
        { value: "read", label: "Can read" },
        { value: "edit", label: "Can edit" },
      ]}
      members={[{ id: "anna", name: "Anna de Vries", owner: true, you: true }]}
      onInvite={noop}
      people={[{ id: "grace", name: "Grace Hopper" }]}
      title="Share the report"
      trigger={<Button variant="outline">Share</Button>}
    />
  ),
};
