import { z } from "zod";

import type { FixRunResult } from "./chat.ts";
import type {
  CatalogSource,
  ListedConnection,
  PendingAction,
  UnknownOutcome,
} from "./connect.ts";
import { unknownOutcomeKeySchema } from "./connect.ts";
import type { DecisionView } from "./decisions.ts";
import { dependencyDecisionSchema } from "./dependencies.ts";
import type { DependencyRequest } from "./dependencies.ts";
import { defineErrorFamily } from "./errors.ts";
import { identifierSchema } from "./ids.ts";
import type { AppId } from "./ids.ts";
import type {
  EventsStoppedNotification,
  GapAskedNotification,
  RunFailedNotification,
  TriggerStoppedNotification,
} from "./notifications.ts";
import { grantReviewSchema } from "./permissions.ts";
import type { Permission } from "./permissions.ts";
import type { ScreensWaiting } from "./screen-trust.ts";

// What waits on a person (core's waiting-rpc.ts): one feed of everything
// that stops until they decide or do something, each item of a kind,
// with the verdicts it takes there and then. Core reads every kind
// through its own API, as the person may read it, so the feed shows
// nobody anything they couldn't see already, and a verdict acts through
// that same kind's own call, its checks and audit included: the feed adds
// no way to decide anything. An item goes by itself once what it is
// about is settled, wherever that was. A kind settled on its own page (a
// decision, which is confirmed there; an engine's apps or version to
// review; a connection to sign in to again; a question of the brain)
// takes no verdict here.

/** Why a call on what waits was refused. */
export const waitingErrors = defineErrorFamily({
  "waiting.invalid_verdict":
    "That isn't a verdict one of the kinds of what waits takes.",
});

/** Who an item waits on: the person themself, an admin, or whoever holds a permission. */
export type WaitsOn =
  | { type: "person"; userId: string }
  | { type: "admin" }
  | { type: "permission"; permission: "dependencies.approve" };

interface ItemBase {
  /** Stable from one read to the next: its kind and what it is about, e.g. `heldWrite:<id>`. */
  id: string;
  /** When it came in (ISO 8601); null when core keeps no date for it, only that it waits now. */
  at: string | null;
  /** Something stops until it is settled: a run, a call, a connection. */
  urgent: boolean;
  waitsOn: WaitsOn;
}

/** A change an agent, App or run wants to make, held until the person approves it. */
export interface HeldWriteItem extends ItemBase {
  kind: "heldWrite";
  verdicts: ("approve" | "decline")[];
  action: PendingAction;
}

/** A change sent for the person whose answer was lost: they say whether it happened. */
export interface UnknownOutcomeItem extends ItemBase {
  kind: "unknownOutcome";
  verdicts: ("happened" | "notHappened")[];
  outcome: UnknownOutcome;
}

/** A permission an App or agent asked for, which an admin grants or rejects. */
export interface PermissionRequestItem extends ItemBase {
  kind: "permissionRequest";
  verdicts: ("grant" | "reject")[];
  request: Permission;
  /**
   * The version of the asking App current as it was read, which a grant
   * approves (`GrantReview`); null for an agent's or independent
   * resource's request, or an App with none current.
   */
  reviewedVersion: number | null;
}

/** Packages proposed for an App or workflow, which someone given the permission approves. */
export interface PackagesItem extends ItemBase {
  kind: "packages";
  verdicts: ("approve" | "reject")[];
  request: DependencyRequest;
  /** The policy generation it was read under: a decision names it. */
  policyGeneration: number;
}

/** An engine whose current apps run code nobody approved: approved on the engine's page. */
export interface AppApprovalItem extends ItemBase {
  kind: "appApproval";
  verdicts: never[];
  waiting: ScreensWaiting;
}

/** A version of an App up for review, for the person who answers for the App: made current on its page. */
export interface GoLiveItem extends ItemBase {
  kind: "goLive";
  verdicts: never[];
  app: { id: AppId; name: string };
  version: number;
}

/**
 * A version of an independent workflow a builder asked to go live, for
 * its owner or an admin to approve or send back; for whoever asked only
 * while nobody else may (`selfApproval`).
 */
export interface WorkflowGoLiveItem extends ItemBase {
  kind: "workflowGoLive";
  verdicts: ("approve" | "reject")[];
  workflow: { id: string; name: string };
  version: number;
  requestedBy: string;
  /** The lifecycle revision it was read at: a verdict names it. */
  revision: number;
  /** The reader asked for it, and approves it themselves as nobody else may. */
  selfApproval: boolean;
}

/** A workflow that failed while acting for the person, which they can ask the agent to fix. */
export interface FailedRunItem extends ItemBase {
  kind: "failedRun";
  /** `askToFix` while chats have a model to ask with. */
  verdicts: "askToFix"[];
  notification: RunFailedNotification;
}

/** One of the brain's open questions an admin asked the person: answered in the brain. */
export interface OpenQuestionItem extends ItemBase {
  kind: "openQuestion";
  verdicts: never[];
  notification: GapAskedNotification;
}

/** A schedule trigger the person owns that stopped after too many failed starts: enabled again where they manage it. */
export interface StoppedScheduleItem extends ItemBase {
  kind: "stoppedSchedule";
  verdicts: never[];
  notification: TriggerStoppedNotification;
}

/**
 * A mailbox or drive the person's triggers listen to, which connect
 * stopped hearing: their triggers there start nothing new until it
 * answers again.
 */
export interface StoppedEventsItem extends ItemBase {
  kind: "stoppedEvents";
  verdicts: never[];
  notification: EventsStoppedNotification;
  /** The connection's account and catalog entry, while the person may see it. */
  account: {
    name: string | null;
    source: CatalogSource;
    provider: string;
  } | null;
}

/** A connection whose access ran out, which the person can sign in to again on its page. */
export interface SignInAgainItem extends ItemBase {
  kind: "signInAgain";
  verdicts: never[];
  connection: ListedConnection;
  /** Its catalog entry, by the name the catalog gives it (its provider's ID when it lists none). */
  integration: { source: CatalogSource; id: string; name: string };
}

/** A decision a workflow's run waits for the person to answer: reviewed and confirmed on its page. */
export interface DecisionItem extends ItemBase {
  kind: "decision";
  verdicts: never[];
  decision: DecisionView;
}

export type WaitingItem =
  | HeldWriteItem
  | UnknownOutcomeItem
  | PermissionRequestItem
  | PackagesItem
  | AppApprovalItem
  | GoLiveItem
  | WorkflowGoLiveItem
  | FailedRunItem
  | OpenQuestionItem
  | StoppedScheduleItem
  | StoppedEventsItem
  | SignInAgainItem
  | DecisionItem;

export type WaitingKind = WaitingItem["kind"];

/**
 * The parts core reads the feed from, each through its own API: one that
 * fails leaves the rest, and the feed says which it couldn't read.
 */
export const waitingParts = [
  "held",
  "outcomes",
  "requests",
  "packages",
  "screens",
  "versions",
  "workflowGoLives",
  "notifications",
  "connections",
  "decisions",
] as const;
export type WaitingPart = (typeof waitingParts)[number];

/** Everything that waits on the person now. */
export interface WaitingFeed {
  /** When core read it (ISO 8601): what an item without a date of its own waits as of. */
  readAt: string;
  /** Urgent first, then the newest, an item without a date as of `readAt`. */
  items: WaitingItem[];
  /** The parts that couldn't be read, with why: the feed may be missing their items. */
  unread: { part: WaitingPart; code: string }[];
  /** Whether older notifications follow those listed (`NotificationsApi.list`). */
  moreNotifications: boolean;
  /** How many of the person's notifications are unread, of all they can see. */
  unreadNotifications: number;
  /** The model a fix is asked with (`askToFix`); null while chats have none. */
  fixModel: string | null;
}

/** A verdict on one item, with what the person reviewed as they gave it. */
export const waitingVerdictSchema = z.union([
  z.strictObject({
    kind: z.literal("heldWrite"),
    id: identifierSchema,
    verdict: z.literal("approve"),
    /** The hash of exactly the input the person was shown. */
    inputHash: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal("heldWrite"),
    id: identifierSchema,
    verdict: z.literal("decline"),
  }),
  z.strictObject({
    kind: z.literal("unknownOutcome"),
    key: unknownOutcomeKeySchema,
    /** The call's claim, as shown: one sent again since is another item. */
    claim: z.int().nonnegative(),
    verdict: z.enum(["happened", "notHappened"]),
  }),
  z.strictObject({
    kind: z.literal("permissionRequest"),
    id: identifierSchema,
    verdict: z.literal("grant"),
    reviewed: grantReviewSchema,
  }),
  z.strictObject({
    kind: z.literal("permissionRequest"),
    id: identifierSchema,
    verdict: z.literal("reject"),
  }),
  z.strictObject({
    kind: z.literal("packages"),
    id: identifierSchema,
    verdict: z.enum(["approve", "reject"]),
    reviewed: dependencyDecisionSchema.shape.reviewed,
  }),
  z.strictObject({
    kind: z.literal("workflowGoLive"),
    workflow: identifierSchema,
    version: z.int().min(1),
    /** The lifecycle revision as shown: one changed since is refused. */
    revision: z.int().min(0),
    verdict: z.enum(["approve", "reject"]),
  }),
  z.strictObject({
    kind: z.literal("failedRun"),
    run: identifierSchema,
    verdict: z.literal("askToFix"),
    model: identifierSchema,
  }),
]);
export type WaitingVerdict = z.input<typeof waitingVerdictSchema>;

/** What a verdict came to: for asking a fix, the chat it started. */
export type WaitingSettled =
  | { kind: "failedRun"; fix: FixRunResult }
  | { kind: Exclude<WaitingVerdict["kind"], "failedRun"> };

/** What waits on the signed-in person, and their verdicts on it. */
export interface WaitingApi {
  /**
   * Everything that waits on the person now, each kind as its own API
   * lists it for them: permission requests and apps to approve only for
   * the organization's own admins, packages only for whoever holds
   * `dependencies.approve`. Reading it marks nothing read.
   */
  list: () => Promise<WaitingFeed>;
  /**
   * Gives a verdict on one item, through its kind's own call, which
   * checks again that the person may give it and records it as it
   * always does. Refused as that call refuses it.
   */
  settle: (verdict: WaitingVerdict) => Promise<WaitingSettled>;
}
