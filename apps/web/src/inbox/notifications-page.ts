import type {
  Notification,
  NotificationPage,
} from "@grasp-os/shared/notifications";
import type { StoppedEventsItem } from "@grasp-os/shared/waiting";

import type { Session } from "../core.ts";
import { frameChanged } from "../frame/frame-read.ts";

/** The latest page of the person's notifications, as the feed read it. */
export interface NotificationsPage {
  page: NotificationPage;
  /**
   * The accounts of the connections the page's stopped sources are at,
   * by connection ID, as the feed named them; none where it couldn't.
   */
  accounts?: ReadonlyMap<string, StoppedAccount>;
}

/** A connection's account and catalog entry, as the feed names it. */
export type StoppedAccount = NonNullable<StoppedEventsItem["account"]>;

/**
 * Marks read the unread ones of the notifications a page shows, only as
 * they were when listed. The nav's count is read again once they are.
 */
export const markShownRead = async (
  session: Session,
  shown: readonly Notification[]
): Promise<void> => {
  const unread = shown.filter(({ read }) => !read);
  const [newest] = shown;
  if (unread.length > 0 && newest !== undefined) {
    await session.notifications.markRead(
      unread.map(({ id }) => id),
      newest.at
    );
    frameChanged();
  }
};
