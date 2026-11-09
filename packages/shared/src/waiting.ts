import { z } from "zod";

import type {
  CatalogSource,
  ListedConnection,
  PendingAction,
  UnknownOutcome,
} from "./connect.ts";
import { unknownOutcomeKeySchema } from "./connect.ts";
import type { DecisionView } from "./decisions.ts";
import { defineErrorFamily } from "./errors.ts";
import type { HeldStart } from "./held-starts.ts";
import { identifierSchema } from "./ids.ts";
import type { AppId } from "./ids.ts";
import type {
  AppMessageNotification,
  EventsStoppedNotification,
  GapAskedNotification,
  PackageNotification,
  TriggerStoppedNotification,
} from "./notifications.ts";
import { grantReviewSchema } from "./permissions.ts";
import type { Permission } from "./permissions.ts";
import type { PendingWorkflowBindings } from "./workflow-resources.ts";

// What waits on a person (core's waiting-rpc.ts): one feed of everything
// that stops until they decide or do something, each item of a kind,
// with the verdicts it takes there and then. Core reads every kind
// through its own API, as the person may read it, so the feed shows
// nobody anything they couldn't see already, and a verdict acts through
// that same kind's own call, its checks and audit included: the feed adds
// no way to decide anything. An item goes by itself once what it is
// about is settled, wherever that was. A kind settled on its own page (a
// decision, which is confirmed there; an App's version to
// review; a connection to sign in to again; a question of the brain)
// takes no verdict here.

/** Why a call on what waits was refused. */
export const waitingErrors = defineErrorFamily({
  "waiting.invalid_verdict":
    "That isn't a verdict one of the kinds of what waits takes.",
});

/** Who an item waits on: the person themself, or an admin. */
export type WaitsOn = { type: "person"; userId: string } | { type: "admin" };

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

/** A start of a workflow a chat's agent asked for, held until the person confirms it. */
export interface HeldStartItem extends ItemBase {
  kind: "heldStart";
  verdicts: ("confirm" | "decline")[];
  start: HeldStart;
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
   * approves (`GrantReview`); for a workflow's request on one of an App's
   * functions, that App's; null for any other request, or an App with
   * none current.
   */
  reviewedVersion: number | null;
}

/** A version of an App up for review, for the person who answers for the App: made current under Versions in the App's details. */
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

/** Packages of an App the person builds, revoked as malware or newly advised against. */
export interface PackageNoticeItem extends ItemBase {
  kind: "packageNotice";
  verdicts: never[];
  notification: PackageNotification;
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

/** What an App the person can open told them: opened on the App's page. */
export interface AppMessageItem extends ItemBase {
  kind: "appMessage";
  verdicts: never[];
  notification: AppMessageNotification;
}

/**
 * A workflow version, live or asked to go live, whose bindings no admin
 * approved, so its starts are refused: for the organization's own admins,
 * who approve each binding on it (`WorkflowResourcesApi.approveBinding`).
 */
export interface BindingApprovalItem extends ItemBase {
  kind: "bindingApproval";
  verdicts: never[];
  pending: PendingWorkflowBindings;
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
  | GoLiveItem
  | WorkflowGoLiveItem
  | OpenQuestionItem
  | StoppedScheduleItem
  | PackageNoticeItem
  | StoppedEventsItem
  | AppMessageItem
  | BindingApprovalItem
  | SignInAgainItem
  | DecisionItem
  | HeldStartItem;

export type WaitingKind = WaitingItem["kind"];

/**
 * The parts core reads the feed from, each through its own API: one that
 * fails leaves the rest, and the feed says which it couldn't read.
 */
export const waitingParts = [
  "held",
  "outcomes",
  "requests",
  "versions",
  "workflowGoLives",
  "notifications",
  "connections",
  "decisions",
  "heldStarts",
  "bindings",
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
    kind: z.literal("heldStart"),
    id: identifierSchema,
    verdict: z.literal("confirm"),
    /** The hash of exactly the input the person was shown. */
    inputHash: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal("heldStart"),
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
    kind: z.literal("workflowGoLive"),
    workflow: identifierSchema,
    version: z.int().min(1),
    /** The lifecycle revision as shown: one changed since is refused. */
    revision: z.int().min(0),
    verdict: z.enum(["approve", "reject"]),
  }),
]);
export type WaitingVerdict = z.input<typeof waitingVerdictSchema>;

/** What a verdict came to. */
export interface WaitingSettled {
  kind: WaitingVerdict["kind"];
}

/** What waits on the signed-in person, and their verdicts on it. */
export interface WaitingApi {
  /**
   * Everything that waits on the person now, each kind as its own API
   * lists it for them: permission requests and apps to approve only for
   * the organization's own admins. Reading it marks nothing read.
   */
  list: () => Promise<WaitingFeed>;
  /**
   * Gives a verdict on one item, through its kind's own call, which
   * checks again that the person may give it and records it as it
   * always does. Refused as that call refuses it.
   */
  settle: (verdict: WaitingVerdict) => Promise<WaitingSettled>;
}
