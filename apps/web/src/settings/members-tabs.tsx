import { isMemberAdmin } from "@grasp-os/shared/roles";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { Trans } from "@lingui/react/macro";
import { useRouteContext } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { TeamsPanel } from "./teams.tsx";

// Settings › Members in two tabs, for the organization's own admins: the
// members and their roles, then the teams they are in (teams.tsx). Anyone
// else gets the members alone, as before: core refuses them the teams.

/** The Members page's tabs around `children`, its members. */
export const MembersTabs = ({ children }: { children: ReactNode }) => {
  const { identity } = useRouteContext({ from: "/_shell" });
  const members = <div className="flex flex-col gap-6">{children}</div>;
  if (!isMemberAdmin(identity)) {
    return members;
  }
  return (
    <Tabs defaultValue="members">
      <TabsList>
        <TabsTrigger value="members">
          <Trans>Members</Trans>
        </TabsTrigger>
        <TabsTrigger value="teams">
          <Trans>Teams</Trans>
        </TabsTrigger>
      </TabsList>
      <TabsContent value="members">{members}</TabsContent>
      <TabsContent value="teams">
        <TeamsPanel />
      </TabsContent>
    </Tabs>
  );
};
