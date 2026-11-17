import { isMemberAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouteContext } from "@tanstack/react-router";
import type { ReactNode } from "react";

import {
  Tabs,
  TabsList,
  TabsContent,
  TabsTrigger,
} from "../grasp/tabs/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { TeamsPanel } from "./teams.tsx";

// Settings › Members in three tabs, for the organization's own admins: the
// members and their roles, the teams they are in (teams.tsx), and what each
// role may do: a reference, kept out of the way of the list. Anyone else
// gets the members and the roles one under the other: core refuses them
// the teams.

const styles = stylex.create({
  stack: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space5,
    paddingBlockStart: grasp.space4,
  },
  alone: { display: "flex", flexDirection: "column", gap: grasp.space5 },
});

/** The Members page's tabs: `children`, its members, and `roles`, what each role may do. */
export const MembersTabs = ({
  children,
  roles,
}: {
  children: ReactNode;
  roles: ReactNode;
}) => {
  const { t } = useLingui();
  const { identity } = useRouteContext({ from: "/_shell" });
  if (!isMemberAdmin(identity)) {
    return (
      <div {...stylex.props(styles.alone)}>
        {children}
        {roles}
      </div>
    );
  }
  return (
    <Tabs defaultValue="members">
      <TabsList aria-label={t`Members and roles`}>
        <TabsTrigger value="members">{t`Members`}</TabsTrigger>
        <TabsTrigger value="teams">{t`Teams`}</TabsTrigger>
        <TabsTrigger value="roles">{t`Roles`}</TabsTrigger>
      </TabsList>
      <TabsContent value="members">
        <div {...stylex.props(styles.stack)}>{children}</div>
      </TabsContent>
      <TabsContent value="teams">
        <div {...stylex.props(styles.stack)}>
          <TeamsPanel />
        </div>
      </TabsContent>
      <TabsContent value="roles">
        <div {...stylex.props(styles.stack)}>{roles}</div>
      </TabsContent>
    </Tabs>
  );
};
