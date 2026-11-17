import { isMemberAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouteContext } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Tabs, TabsList, TabsPanel, TabsTab } from "../grasp/tabs/index.ts";
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
        <TabsTab value="members">{t`Members`}</TabsTab>
        <TabsTab value="teams">{t`Teams`}</TabsTab>
        <TabsTab value="roles">{t`Roles`}</TabsTab>
      </TabsList>
      <TabsPanel value="members">
        <div {...stylex.props(styles.stack)}>{children}</div>
      </TabsPanel>
      <TabsPanel value="teams">
        <div {...stylex.props(styles.stack)}>
          <TeamsPanel />
        </div>
      </TabsPanel>
      <TabsPanel value="roles">
        <div {...stylex.props(styles.stack)}>{roles}</div>
      </TabsPanel>
    </Tabs>
  );
};
