import type { PendingAction, UnknownOutcome } from "@grasp-os/shared/connect";
import type { DecisionView } from "@grasp-os/shared/decisions";
import type { DependenciesWaiting } from "@grasp-os/shared/dependencies";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { ScreensWaiting } from "@grasp-os/shared/screen-trust";
import type {
  GoLiveItem,
  SignInAgainItem,
  WorkflowGoLiveItem,
} from "@grasp-os/shared/waiting";

import type { PendingRequests } from "../activity/pending.tsx";
import type { Loaded } from "../load-from-core.tsx";
import type { NotificationsPage } from "./failed-workflows.tsx";

// What waits on the person, as the dashboard and the inbox read it
// (`read-dashboard.ts`), apart from how either shows it.

/**
 * What the dashboard read of what waits on the person (core's feed of
 * it, `session.waiting`), each part on its own: one core couldn't read
 * says so in its place.
 */
export interface Waiting {
  held: Loaded<PendingAction[]>;
  /** Calls of the person's whose answer was lost, for them to say what became of each. */
  outcomes: Loaded<UnknownOutcome[]>;
  failed: Loaded<NotificationsPage>;
  /** Connections whose access ran out, among those the person may sign in to again. */
  reconnect: Loaded<SignInAgainItem[]>;
  /** Versions of Apps the person answers for, up for review. */
  versions: Loaded<GoLiveItem[]>;
  /** Admins only. */
  requests: Loaded<PendingRequests> | undefined;
  /** Packages to approve: none for anyone without that permission. */
  dependencies: Loaded<DependenciesWaiting>;
  /** Engines with apps whose code waits for approval. Admins only. */
  screens: Loaded<ScreensWaiting[]> | undefined;
  /** Decisions of workflows' runs that wait for the person's answer. */
  decisions: Loaded<DecisionView[]>;
  /** Versions of workflows asked to go live that the person may approve or send back. */
  workflowGoLives: Loaded<WorkflowGoLiveItem[]>;
}

/** Who counts what waits: what they may act on follows from their role. */
export type Viewer = Pick<Identity, "role" | "staff">;

/** Whether permission requests wait on this person: admins decide them; staff can't, and don't get them. */
export const decidesRequests = (viewer: Viewer): boolean =>
  isMemberAdmin(viewer);
