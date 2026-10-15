import type { AuditActor } from "@grasp-os/shared/audit";
import type { Authority } from "@grasp-os/shared/permissions";
import type { QuotaPolicy } from "@grasp-os/shared/quota-policy";
import { z } from "zod";

// Fair admission of model requests (spec 18.3, 40.5): how many of the
// client's provider requests to models are in flight at once, in all, for
// one person and of one App, each against its share in the quota policy
// (`modelClientRequests`, `modelPersonRequests`, `modelAppRequests`), and
// in what order the calls waiting get a share. The same design as fair
// admission of workflow attempts (workflows/admission.ts), applied where
// model requests are already ordered: the model ledger (model-ledger.ts),
// one Durable Object per deployment, whose storage admits one request at
// a time. A request's lease is its receipt in the ledger (`requests`),
// taken in the same transaction that checks its shares and its budgets,
// and the calls waiting are a persistent queue there (`queue`). The
// client is the tenant: core runs once per client.
//
// From the threat model, each way a request could get more than its
// share, keep another from its own, or get round what limits it, and what
// closes it:
//
// - Starving others: an App's and a person's shares are each below the
//   client's (one less, at least, `modelSharesOf`), so one App's burst, or
//   one person's, always leaves room for another App and another person.
//   Several Apps or people together can fill the client's share: then the
//   next waits its turn.
// - One person's backlog in an App keeping another person from it: places
//   are served by turn first (one past the latest turn of the same
//   person's places waiting in the same App as it joined), so within an
//   App people take turns, round-robin; within a turn, first come, first
//   served.
// - Head-of-line blocking and queue jumping: a request is admitted only if
//   serving the queue in order now would admit it (`servedInOrder`): each
//   place ahead takes a lease if its person, its App and the client have
//   room after those before it, and is passed over if not. One queued
//   behind a saturated App doesn't wait for that App, and a newcomer never
//   takes a share a call ahead of it would.
// - Two admissions racing for the last share: the ledger checks the shares
//   and takes the lease in one synchronous transaction of its storage,
//   which runs one at a time. Nothing is counted outside it.
// - Double leases: a provider request holds one lease, its receipt's ID; a
//   repeated admission under the same ID answers the first and takes no
//   second (model-ledger.ts). A call's provider requests go one at a time,
//   each settled before the next is admitted.
// - A lease never released after a crash or a cancel: a request holds its
//   shares only while it is in flight (`dispatched`) and before its lease
//   ends (`leaseEndsAt`): its call's deadline, which cuts the call off, and
//   at most {@link maxLeaseMs} after it was admitted, whatever the deadline
//   says. A request that ends, is cancelled, fails or whose usage is lost
//   settles and gives its shares back at once; one whose isolate died
//   holds them until its lease ends, never longer.
// - A dead waiter holding its place for ever: a place lasts only while its
//   call asks again (`queueLiveMs`, as for workflow steps), which a waiting
//   call does every few seconds; a call that stopped asking loses it. A
//   call that stops waiting gives its place up (`ModelLedger.leaveQueue`).
// - A forged retry-after: core computes every wait it passes on, from the
//   leases the ledger holds (a person's own share) or a fixed wait (a share
//   others hold, which would otherwise tell when their calls were sent);
//   neither a caller nor an App sets it, and asking sooner moves no one up
//   the queue. A provider's own `retry-after` is read as a hint only, and
//   held between bounds core sets (models.ts, `rateLimitedSeconds`).
// - Budget bypass through the queue: a queued request is admitted only
//   through the same transaction as any other, every budget and request
//   limit checked again then. A request whose budget has no room, used up
//   for good or held by requests under way, is refused as that before any
//   share is looked at, and takes no place: waiting for a share would never
//   help it, and a full share never tells the two apart.
// - A place abandoned: however a call's wait ends unadmitted (out of time,
//   cancelled, stopped by its caller, a policy or a ledger that fails), the
//   gateway gives its place up on its one way out (models.ts,
//   `admitWaiting`), and a call cancelled while it waits asks nothing more.
// - A fake identity for an extra share: who a request counts for and its
//   App come from the call's trigger and work context, which core's host
//   sets (models.ts), never from what an App or a workflow passes. A call
//   nobody makes for a person takes its App's share of its own
//   (`app:<id>`), held to a person's, or core's own (`system`).
// - A guest taking the member's share, or learning of the member's calls:
//   a guest's chat takes a share and places of its own (`guest:<chatId>`,
//   `shareIdentity`), never the member's who invited them, though it spends
//   the member's budgets. A guest is never told which person's share is
//   full, nor a wait taken from leases, and is told the same whether the
//   member's budget is held by calls under way or used up.
// - A queue so long admission overloads the ledger: a person, and an App,
//   may have so many places at once (`modelQueuedPerPerson`,
//   `modelQueuedPerApp`), and the whole client {@link placesPerClientShare}
//   times its share in backlogs (places past a person's first in an App);
//   past them a call is refused as queued without a place, at once, and
//   the gateway asks the ledger nothing more for it. The client's cap
//   never takes a person's first place in an App, so Apps' backlogs that
//   fill it never keep a new App or person from a place, and its turn:
//   first places are bounded by the per-person cap instead.
// - A policy change missed: shares are read from the policy for every
//   provider request (models.ts, `scopesNow`), as the run lineage's
//   request limit is. A policy that can't be read is the last one read in
//   that isolate, else the platform's own ceilings: a policy only lowers.
//
// What a waiting call shows: `model.queued`, with the share it waits for
// and when to ask again, to whoever made it; for a workflow run, `queued`
// in its summary while its step's call waits (workflows/model-waits.ts).

/** The share of the requests in flight a call waits for. */
export type ModelShare = "client" | "person" | "app";

/** The shares of model requests in flight at once, and the places a queue keeps. */
export interface ModelShares {
  client: number;
  person: number;
  app: number;
  queuedPerPerson: number;
  queuedPerApp: number;
}

/** The shares of `policy`: an App's and a person's below the client's. */
export const modelSharesOf = (policy: QuotaPolicy): ModelShares => {
  const client = policy.limits.modelClientRequests;
  // With one request at once for the whole client there is nothing to
  // leave over: that one is anyone's.
  const most = Math.max(1, client - 1);
  return {
    client,
    person: Math.min(policy.limits.modelPersonRequests, most),
    app: Math.min(policy.limits.modelAppRequests, most),
    queuedPerPerson: policy.limits.modelQueuedPerPerson,
    queuedPerApp: policy.limits.modelQueuedPerApp,
  };
};

/**
 * The longest a lease lasts after its request was admitted: the longest a
 * model call may take (models.ts, `maxTimeoutMs`), whatever deadline its
 * admission names.
 */
export const maxLeaseMs = 15 * 60_000;

/**
 * The backlog places (past a person's first in an App) the whole client's
 * queue keeps, per request of its share in flight: 128 under the
 * platform's 16. First places don't count, and are never refused by it:
 * each person has one per App at most, within their own cap.
 */
export const placesPerClientShare = 8;

/** The longest a call waits before it asks again, in seconds. */
export const maxAskAgainSeconds = 5;

/** The least wait a refusal for a full share names, in seconds. */
const minRetryAfterSeconds = 1;

const shareSchema = z.int().positive().max(100_000);

/** Who a provider request counts for, and the shares it is held to. */
export const fairnessSchema = z.strictObject({
  /** The call's ID, one per call: its place in the queue while it waits. */
  place: z.uuid(),
  subject: z.string().min(1).max(512),
  /** The call's App; null for a call of no App's. */
  resource: z.string().min(1).max(512).nullable(),
  shares: z.strictObject({
    client: shareSchema,
    person: shareSchema,
    app: shareSchema,
    queuedPerPerson: shareSchema,
    queuedPerApp: shareSchema,
  }),
});

export type Fairness = z.output<typeof fairnessSchema>;

/** A lease held: a request in flight, whose shares it takes, until when. */
export interface Lease {
  subject: string;
  resource: string | null;
  endsAt: number;
}

/** A call waiting in the queue, in the order it is served. */
export interface Waiting {
  subject: string;
  resource: string | null;
}

/** What a call would find of each share, once those ahead took theirs. */
interface Found {
  client: number;
  person: number;
  app: number;
}

/**
 * The queue served in order, `ahead` first, then the call of `me`: each
 * takes a lease if its person, its App (if it has one) and the client have
 * room once those before it took theirs, and is passed over if not. What
 * the call of `me` finds, and whether it would take one. One rule, so what
 * those ahead hold back is exactly what they would take, under every share
 * at once (workflows/admission.ts, `servedInOrder`).
 */
export const servedInOrder = (
  leases: readonly Lease[],
  ahead: readonly Waiting[],
  me: Waiting,
  shares: ModelShares
): { fits: boolean; found: Found } => {
  let client = leases.length;
  const persons = new Map<string, number>();
  const apps = new Map<string, number>();
  for (const { subject, resource } of leases) {
    persons.set(subject, (persons.get(subject) ?? 0) + 1);
    if (resource !== null) {
      apps.set(resource, (apps.get(resource) ?? 0) + 1);
    }
  }
  const findOf = ({ subject, resource }: Waiting): Found => ({
    client,
    person: persons.get(subject) ?? 0,
    app: resource === null ? 0 : (apps.get(resource) ?? 0),
  });
  const fitsIn = (found: Found, { resource }: Waiting): boolean =>
    found.client < shares.client &&
    found.person < shares.person &&
    (resource === null || found.app < shares.app);
  for (const waiting of ahead) {
    if (fitsIn(findOf(waiting), waiting)) {
      client += 1;
      persons.set(waiting.subject, (persons.get(waiting.subject) ?? 0) + 1);
      if (waiting.resource !== null) {
        apps.set(waiting.resource, (apps.get(waiting.resource) ?? 0) + 1);
      }
    }
  }
  const found = findOf(me);
  return { fits: fitsIn(found, me), found };
};

/**
 * The share a refused call waits for, as `found` (`servedInOrder`'s) and
 * the leases held at `now` show: the narrowest that was full (the
 * client's, should none be), and the seconds until it asks again. Only
 * for its person's share, its own calls', is the wait derived from the
 * leases: until the first of them ends (at least a second, at most
 * {@link maxAskAgainSeconds}). A share others hold, or one with room left
 * only for those ahead, answers a fixed wait: a derived one would tell
 * when other people's calls were sent.
 */
export const waitOf = (
  found: Found,
  me: Waiting,
  leases: readonly Lease[],
  shares: ModelShares,
  now: number
): { waitingFor: ModelShare; retryAfterSeconds: number } => {
  const full = (share: ModelShare): boolean =>
    (share !== "app" || me.resource !== null) && found[share] >= shares[share];
  let waitingFor: ModelShare = "client";
  if (full("app")) {
    waitingFor = "app";
  } else if (full("person")) {
    waitingFor = "person";
  }
  if (waitingFor !== "person") {
    return { waitingFor, retryAfterSeconds: maxAskAgainSeconds };
  }
  const own = leases.filter(({ subject }) => subject === me.subject);
  if (own.length < shares.person) {
    return { waitingFor, retryAfterSeconds: maxAskAgainSeconds };
  }
  const first = Math.min(...own.map(({ endsAt }) => endsAt));
  return {
    waitingFor,
    retryAfterSeconds: Math.min(
      maxAskAgainSeconds,
      Math.max(minRetryAfterSeconds, Math.ceil((first - now) / 1000))
    ),
  };
};

/** What a call's shares count it by: its trigger and work, which core's host sets. */
interface FairInput {
  trigger: AuditActor;
  work?: { authority: Authority } | { onboarding: true };
  binding?: { app: string };
}

/** The App a call is made for or through, if any. */
const resourceOf = ({ trigger, work, binding }: FairInput): string | null => {
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

/** The person a call is made by or for, if any, a guest's aside. */
const personOf = ({ trigger, work }: FairInput): string | undefined => {
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
 * Whose shares a call takes, and what its refusals may tell it:
 *
 * - `subject`: the person its calls count for (who makes it, or whom an
 *   agent or a run acts for); for a guest's chat, its own
 *   (`guest:<chatId>`), never the member who invited them, whose budgets it
 *   still spends (model-budgets.ts) but whose share and places it never
 *   takes; for a call nobody makes for a person, its App's own
 *   (`app:<id>`), held to a person's share, so a trigger's or a mail
 *   sender's calls never take the App owner's; else core's own (`system`).
 * - `resource`: its App, if any.
 * - `disclose`: `own` when what its refusals say may come from its own
 *   calls; `fixed` for a guest, who is told nothing shaped by anyone
 *   else's calls: never which person's share is full, never a wait taken
 *   from leases, and the same answer whether the member's budget is busy
 *   or used up (models.ts, `heldBecause`).
 */
export interface ShareIdentity {
  subject: string;
  resource: string | null;
  disclose: "own" | "fixed";
}

/** The one place a call's share identity, and every guest rule of it, is decided. */
export const shareIdentity = (call: FairInput): ShareIdentity => {
  const resource = resourceOf(call);
  if (call.trigger.type === "guest") {
    return {
      subject: `guest:${call.trigger.chatId}`,
      resource,
      disclose: "fixed",
    };
  }
  const person = personOf(call);
  if (person !== undefined) {
    return { subject: person, resource, disclose: "own" };
  }
  return {
    subject: resource === null ? "system" : `app:${resource}`,
    resource,
    disclose: "own",
  };
};
