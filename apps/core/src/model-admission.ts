import type { AuditActor } from "@grasp-os/shared/audit";
import type { Authority } from "@grasp-os/shared/permissions";
import { z } from "zod";

import type { QuotaLimits } from "./workflows/quotas.ts";

// How many of the client's provider requests to models are in flight at
// once: in all (`modelClientRequests`), and for one person
// (`modelPersonRequests`), so one person's burst always leaves room for
// others. Fixed limits, nothing fairer: core runs once per client, so the
// client's share is just the deployment's concurrency. The model ledger
// (model-ledger.ts), one Durable Object per deployment whose storage
// admits one request at a time, counts a request's receipt (`requests`)
// as its lease, checked and taken in one transaction.
//
// What keeps it holding:
//
// - Two admissions racing for the last slot: the ledger counts the leases
//   and takes one in one synchronous transaction of its storage. Nothing
//   is counted outside it.
// - Double leases: a provider request holds one lease, its receipt's ID; a
//   repeated admission under the same ID answers the first and takes no
//   second (model-ledger.ts).
// - A lease never released after a crash or a cancel: a request holds its
//   slot only while it is in flight (`dispatched`) and before its lease
//   ends (`leaseEndsAt`): its call's deadline, and at most
//   {@link maxLeaseMs} after it was admitted. A request that ends, fails or
//   whose usage is lost settles and gives its slot back at once; one whose
//   isolate died holds it until its lease ends, never longer.
// - A fake identity for an extra slot: who a request counts for comes
//   from the call's trigger and work context, which core's host sets
//   (models.ts), never from what an App or a workflow passes.
//
// When every slot is taken, the call waits in the gateway, asking again
// every {@link maxAskAgainSeconds} for as long as it may wait, then is
// refused as `model.queued` (models.ts). A workflow run shows `queued`
// while its step's call waits (workflows/model-waits.ts).

/** The limit a call waits for: the client's, or its person's. */
export type ModelShare = "client" | "person";

/** The model requests in flight at once: in all, and for one person. */
export interface ModelShares {
  client: number;
  person: number;
}

/** The shares of `limits`: a person's below the client's. */
export const modelSharesOf = (limits: QuotaLimits): ModelShares => {
  const client = limits.modelClientRequests;
  // With one request at once for the whole client there is nothing to
  // leave over: that one is anyone's.
  const most = Math.max(1, client - 1);
  return { client, person: Math.min(limits.modelPersonRequests, most) };
};

/**
 * The longest a lease lasts after its request was admitted: the longest a
 * model call may take (models.ts, `maxTimeoutMs`), whatever deadline its
 * admission names.
 */
export const maxLeaseMs = 15 * 60_000;

/** How long a call waits before it asks again, in seconds. */
export const maxAskAgainSeconds = 5;

const shareSchema = z.int().positive().max(100_000);

/** Who a provider request counts for, and the limits it is held to. */
export const fairnessSchema = z.strictObject({
  subject: z.string().min(1).max(512),
  shares: z.strictObject({ client: shareSchema, person: shareSchema }),
});

export type Fairness = z.output<typeof fairnessSchema>;

/** What a call's slot counts it by: its trigger and work, which core's host sets. */
interface FairInput {
  trigger: AuditActor;
  work?:
    | { authority: Authority }
    | { onboarding: true }
    | {
        platform:
          | "brain_upkeep"
          | "dashboard_widgets"
          | "brain_recall"
          | "stephen_requests"
          | "provider_test"
          | "document_conversion";
      };
  binding?: { app: string };
  /** For a workflow run's call: whose slot it takes (models.ts). */
  shareSubject?: string;
}

/** The App a call is made for or through, if any. */
const appOf = ({ trigger, work, binding }: FairInput): string | null => {
  if (
    trigger.type === "workflow" ||
    trigger.type === "app" ||
    trigger.type === "guest"
  ) {
    return trigger.appId;
  }
  if (binding !== undefined) {
    return binding.app;
  }
  if (
    work !== undefined &&
    "authority" in work &&
    work.authority.subject.type === "app"
  ) {
    return work.authority.subject.appId;
  }
  return null;
};

/**
 * The person a call is made by or for, if any, a guest's aside (a guest is
 * no one's person): the one rule its slot and its spend both count by
 * (model-spend.ts adds a guest's member for spend).
 */
export const personOf = ({ trigger, work }: FairInput): string | undefined => {
  if (trigger.type === "person" || trigger.type === "staff") {
    return trigger.userId;
  }
  if (trigger.type === "agent") {
    return trigger.onBehalfOf;
  }
  return work !== undefined && "authority" in work
    ? work.authority.onBehalfOf
    : undefined;
};

/**
 * Whose person slot a call takes: the person its calls count for (who
 * makes it, or whom an agent or a run acts for); for a guest's chat, its
 * own (`guest:<chatId>`), never the member's who invited them, whose
 * spend it still counts in (model-spend.ts); for a workflow run's call,
 * who started the run (`shareSubject`); for a call nobody makes for a
 * person, its App's own (`app:<id>`), so a trigger's or a mail sender's
 * calls never take the App owner's; else core's own (`system`).
 */
export const shareSubjectOf = (call: FairInput): string => {
  if (call.trigger.type === "guest") {
    return `guest:${call.trigger.chatId}`;
  }
  if (call.trigger.type === "workflow") {
    return call.shareSubject ?? `app:${call.trigger.appId}`;
  }
  const person = personOf(call);
  if (person !== undefined) {
    return person;
  }
  const app = appOf(call);
  return app === null ? "system" : `app:${app}`;
};
