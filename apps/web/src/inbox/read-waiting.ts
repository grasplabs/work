import { expectedMessageOf } from "@grasp-os/shared/errors";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type {
  WaitingFeed,
  WaitingItem,
  WaitingKind,
  WaitingPart,
} from "@grasp-os/shared/waiting";

import { readRequestNames } from "../activity/pending.tsx";
import type { CoreConnection } from "../core-connection.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { readOutcomes } from "./everyones-outcomes.ts";
import { markShownRead } from "./notifications-page.ts";
import { decidesRequests } from "./waiting.ts";
import type { Waiting } from "./waiting.ts";

// What waits on the person, as the Inbox and the sidebar's Inbox view read
// it: core's feed in one read, each part on its own so one that fails
// leaves the rest, with the names its items are shown with.

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
 * notifications it lists as read, as the inbox, which shows them, does; the sidebar's list, which only says what
 * waits, reads them with `markShownRead: false`. Everyone's unknown
 * outcomes are listed only with `everyonesOutcomes` (the inbox showing
 * them): core records each such read in the audit trail, so the frame's
 * read, every few minutes, would fill it.
 */
export const readWaiting = async (
  core: CoreConnection,
  identity: Identity,
  {
    markShownRead: marking = true,
    everyonesOutcomes: listOutcomes = false,
  }: { markShownRead?: boolean; everyonesOutcomes?: boolean } = {}
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
  if (marking && notifications.state === "ready") {
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
  // The onboarding, for the admins Settings, Onboarding was for, Grasp's staff included.
  const interviews = isAdmin(identity.role)
    ? await loadFromCore(core, async (session) => {
        const [view, links, programme] = await Promise.all([
          session.onboarding.view(),
          session.onboarding.links(),
          session.onboarding.programme(),
        ]);
        return { view, links, stage: programme?.stage ?? null };
      })
    : undefined;
  // Everyone's, for the organization's own admins, as Settings › Unknown outcomes was.
  const everyonesOutcomes =
    listOutcomes && decidesRequests(identity)
      ? await readOutcomes(core)
      : undefined;
  return {
    ...(interviews === undefined ? {} : { interviews }),
    ...(everyonesOutcomes === undefined ? {} : { everyonesOutcomes }),
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
          gaps: await loadFromCore(
            core,
            async (session) => await session.brain.openGaps()
          ),
        }
      : {}),
  };
};
