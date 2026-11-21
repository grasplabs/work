import type { AuditRecord } from "@grasp-os/shared/audit-log";
import { expectedMessageOf } from "@grasp-os/shared/errors";
import type { Identity } from "@grasp-os/shared/rpc";
import type {
  WaitingFeed,
  WaitingItem,
  WaitingKind,
  WaitingPart,
} from "@grasp-os/shared/waiting";

import { readRequestNames } from "../activity/pending.tsx";
import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { markShownRead } from "./notifications-page.ts";
import { decidesRequests } from "./waiting.ts";
import type { Waiting } from "./waiting.ts";

// What the inbox reads: what waits on the person, each part on its own so
// one that fails leaves the rest, and, for admins, the latest of the audit
// trail.

/** The items of the feed of one kind. */
const ofKind = <Kind extends WaitingKind>(
  feed: WaitingFeed,
  kind: Kind
): Extract<WaitingItem, { kind: Kind }>[] =>
  feed.items.filter(
    (item): item is Extract<WaitingItem, { kind: Kind }> => item.kind === kind
  );

/** One part of the feed: what it read of it, or why it couldn't. */
const partOf = <T>(
  feed: Loaded<WaitingFeed>,
  part: WaitingPart,
  read: (feed: WaitingFeed) => T
): Loaded<T> => {
  if (feed.state !== "ready") {
    return feed;
  }
  const failed = feed.data.unread.find((unread) => unread.part === part);
  // Core's own words for why: not translated.
  return failed === undefined
    ? { state: "ready", data: read(feed.data) }
    : {
        state: "refused",
        message: expectedMessageOf(failed.code) ?? failed.code,
      };
};

/**
 * What waits on the person: core's feed of it, in one read, and the names
 * permission requests are shown with. Reading it marks the
 * notifications it lists as read.
 */
export const readWaiting = async (
  core: CoreConnection,
  identity: Identity
): Promise<Waiting> => {
  const feed = await loadFromCore(
    core,
    async (session) => await session.waiting.list()
  );
  const notifications = partOf(feed, "notifications", (read) => {
    const listed = read.items.flatMap((item) =>
      item.kind === "openQuestion" ||
      item.kind === "stoppedSchedule" ||
      item.kind === "workflowChanged" ||
      item.kind === "packageNotice" ||
      item.kind === "stoppedEvents" ||
      item.kind === "appMessage"
        ? [item.notification]
        : []
    );
    const accounts = new Map(
      read.items.flatMap((item) =>
        item.kind === "stoppedEvents" && item.account !== null
          ? [[item.notification.connection, item.account] as const]
          : []
      )
    );
    return {
      page: {
        notifications: listed,
        unread: read.unreadNotifications,
      },
      accounts,
    };
  });
  // Marked read as shown; one that couldn't be stays unread, and shows all the same.
  if (notifications.state === "ready") {
    await loadFromCore(core, async (session) => {
      await markShownRead(session, notifications.data.page.notifications);
    });
  }
  const asked = partOf(feed, "requests", (read) =>
    ofKind(read, "permissionRequest").map(({ request }) => request)
  );
  // Only admins decide them: nobody else is shown any.
  let requests: Waiting["requests"];
  if (decidesRequests(identity)) {
    requests =
      asked.state === "ready"
        ? await loadFromCore(
            core,
            async (session) => await readRequestNames(session, asked.data)
          )
        : asked;
  }
  return {
    held: partOf(feed, "held", (read) =>
      ofKind(read, "heldWrite").map(({ action }) => action)
    ),
    outcomes: partOf(feed, "outcomes", (read) =>
      ofKind(read, "unknownOutcome").map(({ outcome }) => outcome)
    ),
    notifications,
    reconnect: partOf(feed, "connections", (read) =>
      ofKind(read, "signInAgain")
    ),
    requests,
    heldStarts: partOf(feed, "heldStarts", (read) =>
      ofKind(read, "heldStart").map(({ start }) => start)
    ),
    decisions: partOf(feed, "decisions", (read) =>
      ofKind(read, "decision").map(({ decision }) => decision)
    ),
    ...(decidesRequests(identity)
      ? {
          bindings: partOf(feed, "bindings", (read) =>
            ofKind(read, "bindingApproval")
          ),
          skillShares: partOf(feed, "skillShares", (read) =>
            ofKind(read, "skillShare")
          ),
        }
      : {}),
  };
};

/** What was read of the trail: the latest events, and whether it stopped before the trail's end. */
export interface LatestActivity {
  records: AuditRecord[];
  older: boolean;
}

/** How many pages of the trail the inbox reads at most, past the trail's own searches. */
const activityPages = 5;

/**
 * The latest events of the audit trail, without its own searches: core
 * records every search, the inbox's too, and those alone can fill a
 * page. It reads older pages until it has `enough` to show, or the trail
 * ends, or it has read as many as it reads; only a first page records a
 * search. `older` says the trail goes on past what was read.
 */
export const readActivity = async (
  session: Session,
  enough: number
): Promise<LatestActivity> => {
  const records: AuditRecord[] = [];
  let before: number | undefined;
  for (let page = 0; page < activityPages; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each page starts where the last ended
    const read = await session.audit.search({}, before);
    records.push(
      ...read.records.filter(({ event }) => event?.action !== "audit.searched")
    );
    if (records.length >= enough || read.next === null) {
      return { records, older: false };
    }
    before = read.next;
  }
  return { records, older: true };
};
