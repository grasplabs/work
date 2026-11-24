import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@grasp-os/ui/components/sidebar";
import { BellIcon, Icon } from "@grasp-os/ui/lib/icons";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, space } from "@grasp-os/ui/lib/tokens.stylex";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useMatchRoute } from "@tanstack/react-router";

import { readWithin } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { useFrameRead } from "../frame/frame-read.ts";
import { groupLabel } from "./groups.ts";

// The sidebar's Inbox view, chosen with the Home | Inbox switch under its
// head (frame/app-sidebar.tsx), as the reference's: All, the inbox, with
// how many things wait on the person, named as the inbox's filter names
// it; or a sentence when nothing does. The count is
// the Inbox tab's dot too. It counts everything core's feed of what waits
// lists (`session.waiting.list`), the failed workflows, questions, stopped
// schedules, sources and package notices among it only while unread. Read
// again after every change on a page, and on the way to another once the
// count is older than half a minute (frame/frame-read.ts); nothing is
// marked read by counting.

/** The kinds that count only while unread: core counts those itself. */
const notified = new Set([
  "failedRun",
  "openQuestion",
  "stoppedSchedule",
  "workflowChanged",
  "packageNotice",
  "stoppedEvents",
  "appMessage",
]);

/** How many things wait on the person; `undefined` when core couldn't say. Outside the component, as the React Compiler can't compile `try`. */
const readCount = async (core: CoreConnection): Promise<number | undefined> => {
  try {
    return await readWithin(core, async (session) => {
      const { items, unreadNotifications } = await session.waiting.list();
      return (
        items.filter(({ kind }) => !notified.has(kind)).length +
        unreadNotifications
      );
    });
  } catch {
    return undefined;
  }
};

/** How many things wait on the person; `undefined` until core says. */
export const useWaitingCount = (): number | undefined =>
  useFrameRead(readCount).value;

const styles = stylex.create({
  // Said where the rows would stand, quiet, as the reference's empty view.
  empty: {
    margin: 0,
    paddingBlock: space["2"],
    paddingInline: space["2"],
    color: colors.sidebarSecondaryForeground,
  },
});

/**
 * The Inbox view's list: everything that waits, with how many, leading to
 * the inbox; "Nothing waits for you." once core said nothing does. Blank
 * while core can't be read, rather than claim nothing waits.
 */
export const InboxView = ({ waiting }: { waiting: number | undefined }) => {
  const { t, i18n } = useLingui();
  const matchRoute = useMatchRoute();
  return (
    <SidebarContent aria-label={t`Inbox`}>
      <SidebarGroup>
        {waiting === 0 ? (
          <p {...stylex.props(styles.empty)}>
            <Trans>Nothing waits for you.</Trans>
          </p>
        ) : null}
        {waiting !== undefined && waiting > 0 ? (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={matchRoute({ to: "/inbox" }) !== false}
              >
                <Link to="/inbox">
                  <Icon icon={BellIcon} />
                  {i18n._(groupLabel.all)}
                  {/* Inside the link, so its name says how many wait. */}
                  <span {...stylex.props(visuallyHidden)}>
                    <Plural
                      one="# thing waiting"
                      other="# things waiting"
                      value={waiting}
                    />
                  </span>
                </Link>
              </SidebarMenuButton>
              <SidebarMenuBadge>
                <span aria-hidden="true">{waiting}</span>
              </SidebarMenuBadge>
            </SidebarMenuItem>
          </SidebarMenu>
        ) : null}
      </SidebarGroup>
    </SidebarContent>
  );
};
