import type { AuditRecord } from "@grasp-os/shared/audit-log";
import type { BoardReport, StandardWidgetId } from "@grasp-os/shared/dashboard";
import { expectedMessageOf } from "@grasp-os/shared/errors";
import type { KnowledgeSignals } from "@grasp-os/shared/knowledge-signals";
import type { Programme } from "@grasp-os/shared/onboarding";
import { canBuild, isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { ImprovementSignals } from "@grasp-os/shared/signals";
import type {
  WaitingFeed,
  WaitingItem,
  WaitingKind,
  WaitingPart,
} from "@grasp-os/shared/waiting";
import type { WorkflowSummary } from "@grasp-os/shared/workflows";

import { readRequestNames } from "../activity/pending.tsx";
import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { listedOrNone } from "../directory.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { listWorkflows, openableApps } from "../workflows/reads.ts";
import { activityShown } from "./activity.tsx";
import type { LatestActivity } from "./activity.tsx";
import { markShownRead } from "./failed-workflows.tsx";
import { offeredWidgets } from "./layout.ts";
import { goalProgressOf, noReturns } from "./returns.ts";
import type { GoalProgress } from "./returns.ts";
import { fullDays } from "./runs.ts";
import type { Signals } from "./signals.tsx";
import { decidesRequests } from "./to-do.tsx";
import type { Waiting } from "./to-do.tsx";
import type { Board, EnginesRead } from "./widget-board.tsx";

// What the dashboard reads, each part on its own so one that fails or
// hangs leaves the rest: what waits on the person, the person's layout of
// the widget board and what it shows (the workflows, the engines, the
// runs over time, the signals), the programme with Grasp and its weekly
// report, both as core counts and reads them, and, for admins, the latest of the audit
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
 * permission requests are shown with. Reading it marks the failed
 * workflows it lists as read.
 */
export const readWaiting = async (
  core: CoreConnection,
  identity: Identity
): Promise<Waiting> => {
  const feed = await loadFromCore(
    core,
    async (session) => await session.waiting.list()
  );
  const failed = partOf(feed, "notifications", (read) => {
    const notifications = read.items.flatMap((item) =>
      item.kind === "failedRun" || item.kind === "openQuestion"
        ? [item.notification]
        : []
    );
    return {
      page: {
        notifications,
        unread: read.unreadNotifications,
        more: read.moreNotifications,
      },
      model: read.fixModel ?? undefined,
    };
  });
  // Marked read as shown; one that couldn't be stays unread, and shows all the same.
  if (failed.state === "ready") {
    await loadFromCore(core, async (session) => {
      await markShownRead(session, failed.data.page.notifications);
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
    failed,
    reconnect: partOf(feed, "connections", (read) =>
      ofKind(read, "signInAgain")
    ),
    versions: partOf(feed, "versions", (read) => ofKind(read, "goLive")),
    requests,
    dependencies: partOf(feed, "packages", (read) => {
      const items = ofKind(read, "packages");
      return {
        policyGeneration: items[0]?.policyGeneration ?? 0,
        requests: items.map(({ request }) => request),
      };
    }),
    screens: decidesRequests(identity)
      ? partOf(feed, "screens", (read) =>
          ofKind(read, "appApproval").map(({ waiting }) => waiting)
        )
      : undefined,
    decisions: partOf(feed, "decisions", (read) =>
      ofKind(read, "decision").map(({ decision }) => decision)
    ),
  };
};

/**
 * Whether core refused the read to this person's role (admins read every
 * improvement signal, an engine's builders its own): their having none to
 * see, not a failure. Any other error is one.
 */
const refusedToRole = (error: unknown): boolean =>
  roleErrors.codeOf(error) === "role.forbidden";

/**
 * A read of signals core may refuse this person: none, rather than a
 * failure, then. Anything else (another error, a read that doesn't come
 * in time, a lost connection) fails the card, which says so, rather than
 * hiding it.
 */
const orNone = async <T>(read: Promise<T>): Promise<T | undefined> => {
  try {
    return await read;
  } catch (error) {
    if (refusedToRole(error)) {
      return undefined;
    }
    throw error;
  }
};

/**
 * The improvement signals this person may read: every one for admins,
 * each engine's they build for builders (one read per engine, those core
 * refuses left out), none for anyone else.
 */
const readImprovement = async (
  session: Session,
  identity: Identity,
  engines: readonly string[]
): Promise<ImprovementSignals | undefined> => {
  if (isAdmin(identity.role)) {
    return await orNone(session.signals.list());
  }
  if (!canBuild(identity.role)) {
    return undefined;
  }
  const each = await Promise.all(
    engines.map(async (app) => await orNone(session.signals.list({ app })))
  );
  const read = each.filter((signals) => signals !== undefined);
  if (read.length === 0) {
    return undefined;
  }
  return {
    computedAt:
      read
        .map(({ computedAt }) => computedAt)
        .filter((at) => at !== null)
        .toSorted()
        .at(-1) ?? null,
    signals: read.flatMap(({ signals }) => signals),
  };
};

/** The signals this person sees, with the engines' names and the model a fix is asked with. */
const readSignals = async (
  session: Session,
  identity: Identity
): Promise<Signals> => {
  const [apps, models, knowledge] = await Promise.all([
    openableApps(session),
    listedOrNone(session.chats.models()),
    orNone<KnowledgeSignals>(session.knowledgeSignals.list()),
  ]);
  const improvement = await readImprovement(
    session,
    identity,
    apps.map(({ id }) => id)
  );
  return {
    improvement,
    knowledge,
    engines: new Map(apps.map(({ id, name }) => [id, name])),
    model: models[0],
  };
};

/** How many pages of the trail the card reads at most, past the trail's own searches. */
const activityPages = 5;

/**
 * The latest events of the audit trail, without its own searches: core
 * records every search, the dashboard's too, and those alone can fill a
 * page. It reads older pages until it has `enough` to show, or the trail
 * ends, or it has read as many as it reads; only a first page records a
 * search. `older` says the trail goes on past what was read.
 */
export const readActivity = async (
  session: Session,
  enough: number = activityShown
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

/** Both of two reads, once both came: or the first that has no data, as it is. */
const bothOf = async <A, B>(
  first: Promise<Loaded<A>>,
  second: Promise<Loaded<B>>
): Promise<Loaded<[A, B]>> => {
  const [one, other] = await Promise.all([first, second]);
  if (one.state !== "ready") {
    return one;
  }
  if (other.state !== "ready") {
    return other;
  }
  return { state: "ready", data: [one.data, other.data] };
};

/** The engines widget's read: the engines, with the workflows read once for both widgets. */
const readEngines = async (
  core: CoreConnection,
  workflows: Promise<Loaded<WorkflowSummary[]>>
): Promise<Loaded<EnginesRead>> => {
  const both = await bothOf(loadFromCore(core, openableApps), workflows);
  return both.state === "ready"
    ? { state: "ready", data: { apps: both.data[0], workflows: both.data[1] } }
    : both;
};

/**
 * The goals widget's read: the board's goals, with the workflows read once
 * for the board, to say how far each goal's are.
 */
const readGoals = async (
  core: CoreConnection,
  workflows: Promise<Loaded<WorkflowSummary[]>>
): Promise<Loaded<GoalProgress[]>> => {
  const both = await bothOf(
    loadFromCore(core, async (session) => await session.brain.goals()),
    workflows
  );
  return both.state === "ready"
    ? { state: "ready", data: goalProgressOf(both.data[0], both.data[1]) }
    : both;
};

/**
 * The widgets on the person's board, in order: as they last saved it, or
 * as it begins when they never did. A read that fails gives the board as
 * it begins too, rather than no board. A widget no longer `offered` (an
 * admin's, saved before they stopped being one) is left out.
 */
const readLayout = async (
  core: CoreConnection,
  offered: readonly StandardWidgetId[]
): Promise<readonly StandardWidgetId[]> => {
  const loaded = await loadFromCore(
    core,
    async (session) => await session.dashboard.layout()
  );
  return loaded.state === "ready" && loaded.data !== null
    ? loaded.data.widgets.filter((widget) => offered.includes(widget))
    : offered;
};

/**
 * Everything the dashboard shows. What waits on the person comes first;
 * the board's widgets and activity come as they are read, so a slow one
 * never holds back the rest.
 */
export interface Dashboard {
  waiting: Waiting;
  board: Board;
  /** The programme with Grasp; null without a plan. */
  programme: Loaded<Programme | null>;
  /** The weekly report, as core reads it in one call: shown only with a programme. */
  report: Promise<Loaded<BoardReport>>;
  /** Admins only. */
  activity: Promise<Loaded<LatestActivity>> | undefined;
}

export const readDashboard = async (
  core: CoreConnection,
  identity: Identity
): Promise<Dashboard> => {
  // Not awaited: their blocks and cards wait for them.
  const workflows = loadFromCore(core, listWorkflows);
  const signals = loadFromCore(
    core,
    async (session) => await readSignals(session, identity)
  );
  const engines = readEngines(core, workflows);
  const goals = readGoals(core, workflows);
  // The full view's days, once: the block shows the last week of them.
  const runs = loadFromCore(
    core,
    async (session) => await session.workflows.activity({ days: fullDays })
  );
  const activity = isAdmin(identity.role)
    ? loadFromCore(core, async (session) => await readActivity(session))
    : undefined;
  const spend = isAdmin(identity.role)
    ? loadFromCore(core, async (session) => await session.models.spend())
    : undefined;
  const offered = offeredWidgets(isAdmin(identity.role));
  const programme = loadFromCore(
    core,
    async (session) => await session.onboarding.programme()
  );
  // Not awaited: the report's dialog waits for it.
  const report = loadFromCore(
    core,
    async (session) => await session.dashboard.report()
  );
  // The board's order and the page's heading are known before they show,
  // so nothing moves once it is there; read alongside what waits, which
  // the page waits for too.
  const [waiting, layout, read] = await Promise.all([
    readWaiting(core, identity),
    readLayout(core, offered),
    programme,
  ]);
  return {
    waiting,
    // Core keeps no hours, stages or teams' work yet: the return and
    // teams widgets show they have nothing to count.
    board: {
      layout,
      offered,
      returns: noReturns,
      goals,
      workflows,
      engines,
      runs,
      signals,
      spend,
    },
    programme: read,
    report,
    activity,
  };
};
