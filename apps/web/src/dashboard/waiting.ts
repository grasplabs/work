import type { Gap } from "@grasp-os/shared/brain";
import type { PendingAction, UnknownOutcome } from "@grasp-os/shared/connect";
import type { DecisionView } from "@grasp-os/shared/decisions";
import type { HeldStart } from "@grasp-os/shared/held-starts";
import type {
  LinkToSend,
  OnboardingView,
  Programme,
} from "@grasp-os/shared/onboarding";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type {
  BindingApprovalItem,
  SignInAgainItem,
  WorkflowGoLiveItem,
} from "@grasp-os/shared/waiting";

import type { PendingRequests } from "../activity/pending.tsx";
import type { Outcomes } from "../inbox/everyones-outcomes.ts";
import type { Loaded } from "../load-from-core.tsx";
import type { NotificationsPage } from "./notifications-page.ts";

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
  /** The latest page of the person's notifications. */
  notifications: Loaded<NotificationsPage>;
  /** Connections whose access ran out, among those the person may sign in to again. */
  reconnect: Loaded<SignInAgainItem[]>;
  /** Admins only. */
  requests: Loaded<PendingRequests> | undefined;
  /** Decisions of workflows' runs that wait for the person's answer. */
  decisions: Loaded<DecisionView[]>;
  /** Versions of workflows asked to go live that the person may approve or send back. */
  workflowGoLives: Loaded<WorkflowGoLiveItem[]>;
  /** Starts of workflows the person's chats' agents asked for, held for them to confirm. */
  heldStarts: Loaded<HeldStart[]>;
  /** Versions of workflows whose bindings no admin approved, so their starts are refused. Admins only. */
  bindings?: Loaded<BindingApprovalItem[]>;
  /** Every question the Brain still has open, asked of someone or not. Admins only. */
  gaps?: Loaded<Gap[]>;
  /** Where the onboarding's interviews stand, and the links to send. Admins, Grasp's staff included. */
  interviews?: Loaded<Interviews>;
  /** Everyone's open calls of unknown outcome, to follow up. The organization's own admins only. */
  everyonesOutcomes?: Loaded<Outcomes>;
}

/** The onboarding as the inbox's Interviews item reads it, as Settings, Onboarding did. */
export interface Interviews {
  view: OnboardingView;
  links: LinkToSend[];
  /** Where the onboarding stands: the item goes once Grasp opens it. */
  stage: Programme["stage"];
}

/** Who counts what waits: what they may act on follows from their role. */
export type Viewer = Pick<Identity, "role" | "staff">;

/** Whether permission requests wait on this person: admins decide them; staff can't, and don't get them. */
export const decidesRequests = (viewer: Viewer): boolean =>
  isMemberAdmin(viewer);
