import { readWithin } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { useFrameRead } from "../frame/frame-read.ts";

// How many things wait on the person, beside the sidebar's Dashboard
// (grasp/frame/grasp-sidebar.tsx): everything core's feed of
// what waits lists (`session.waiting`), the failed workflows, questions,
// stopped schedules, sources and package notices among it only while
// unread. Read again after every change on a page, and on the way to
// another once the count is older than half a minute (frame/frame-read.ts);
// nothing is marked read by counting.

/** How many things wait on the person; `undefined` when core couldn't say. Outside the component, as the React Compiler can't compile `try`. */
const readCount = async (core: CoreConnection): Promise<number | undefined> => {
  try {
    return await readWithin(core, async (session) => {
      const { items, unreadNotifications } = await session.waiting.list();
      const notified = new Set([
        "failedRun",
        "openQuestion",
        "stoppedSchedule",
        "packageNotice",
        "stoppedEvents",
        "appMessage",
      ]);
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
