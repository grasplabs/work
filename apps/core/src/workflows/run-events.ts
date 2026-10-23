import { sha256Hex } from "@grasp-os/shared/encoding";
import { runIdSchema, workflowResourceIdSchema } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { z } from "zod";

import { runEngine } from "./engine.ts";
import { acceptedEventData, pinnedEventDataOf } from "./event-contracts.ts";
import { contentType, eventTypeKey } from "./event-envelopes.ts";
import type { StoredEvent } from "./event-envelopes.ts";
import { quotaPolicy } from "./quotas.ts";
import { callingRunOf, requireCallAuthority } from "./resource-authority.ts";
import { runOf } from "./resource-runs.ts";

// Events into a run's inbox (platform specification 13.5, 10.4.6, 14.3):
// what a JSON workflow's `listen` task takes. Every event is admitted for
// one run, through one of the event bindings its start froze, as the host
// makes it: the run's engine object keeps it, in order, until a wait that
// matches it takes it, once (`waitForMatch`, @grasp-os/workerflow). Who
// may send is the caller's to decide (an App's screen or a committed
// mutation, GRA-420): nothing here is reachable by RPC, and this module
// decides only what the run itself takes.
//
// Threat model, and how each is closed:
//
// - A sender forging provenance. A sender gives a type, its data, an
//   optional subject and its delivery key; the host mints the rest of the
//   envelope (`StoredEvent`): its ID from the run, the binding, the
//   sender's source and key, its source from who the caller is (a URI the
//   caller derives from its own authority, never the sender's input), and
//   its time from when the run accepted it. Nothing a sender gives becomes
//   an ID, a source or a time.
// - An event through a binding the run doesn't have, or of a type it
//   doesn't admit. The binding must be an event binding the run's start
//   froze, and its pinned catalog contract (by its fingerprint) must admit
//   the type; the data must match that type's contract, by the SDK's
//   native validator, before anything is accepted (`workflow.event_invalid`).
// - An event through one binding taken by a listen on another. Each event
//   is kept under a type of the engine's that names its binding and its
//   type together (`eventTypeKey`), so a listen matches only events of
//   its own binding, whatever types two bindings share.
// - An event to a run that may no longer act. The authority behind the
//   binding is read again as the event is admitted, as a call's is
//   (resource-authority.ts, `requireCallAuthority`): the person the run
//   acts for still in the workflow, the workflow live, the binding's
//   approval still active, the start's grant still standing
//   (`workflow.event_denied`). An ended run takes none
//   (`workflow.run_ended`).
// - Another workflow's run. The caller names the workflow and the run:
//   a run of another workflow is no such run (`workflow.run_unavailable`).
// - A run's inbox filled without bound, or by one sender for all the
//   others. The engine refuses an event past its count or byte limit, or
//   past its sender's share of them (every delivery names its sender,
//   from the caller's authority), or too large, before it answers; a run
//   past its lineage's age takes none (`workflow.event_refused`). An event
//   is never accepted and then dropped.
// - The same event delivered twice. Its key is the engine's delivery key:
//   the same key, type, data and attributes again is the same event,
//   accepted once, and answered with the same ID; the same key with
//   another event is refused (`workflow.event_conflict`).

/**
 * The attributes a listen's filter may match an event by, as the engine
 * keeps them beside it: every attribute of its envelope but its type
 * (which `eventTypeKey` keeps), its data and its time.
 */
const attributesOf = (stored: StoredEvent): Record<string, string> => ({
  id: stored.id,
  source: stored.source,
  datacontenttype: stored.datacontenttype,
  ...(stored.subject === undefined ? {} : { subject: stored.subject }),
});

/** Text on one line: no control characters. */
// oxlint-disable-next-line no-control-regex -- control characters are what it refuses
const oneLine = /^[^\u0000-\u001F\u007F]*$/u;

const deliverySchema = z.strictObject({
  workflowId: workflowResourceIdSchema,
  runId: runIdSchema,
  binding: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
  type: z.string().min(1).max(256).regex(oneLine),
  data: z.json(),
  subject: z.string().max(1024).regex(oneLine).optional(),
  key: z.string().min(1).max(200).regex(oneLine),
  source: z
    .string()
    .min(1)
    .max(1024)
    .refine((text) => URL.canParse(text), "An absolute URI"),
  sender: z.string().min(1).max(256),
});

/** An event a caller admits to a run: everything but what the host mints. */
export interface RunEventDelivery {
  readonly workflowId: string;
  readonly runId: string;
  /** The run's event binding it comes through, by its alias. */
  readonly binding: string;
  /** Its CloudEvents type, one the binding's contract admits. */
  readonly type: string;
  readonly data: unknown;
  readonly subject?: string;
  /** The sender's delivery key: the same key again is the same event. */
  readonly key: string;
  /**
   * Who sends it, as a URI the caller derives from its own authority
   * (say, the App and person a screen's send acts for): never the
   * sender's input.
   */
  readonly source: string;
  /**
   * Who sends it, for its share of the run's inbox: the same for every
   * delivery of one sender (say, the App and person a screen's send acts
   * for, whatever release), derived as `source` is, never from the input.
   */
  readonly sender: string;
}

/** An admitted event: its ID, and whether this delivery was the first. */
export interface AdmittedEvent {
  readonly id: string;
  readonly accepted: boolean;
}

/**
 * Admits `delivery` to its run's inbox, as the header says: its ID, and
 * whether this delivery was the first of it. Refused before anything is
 * accepted: `workflow.run_unavailable` for no such run of the workflow,
 * `workflow.run_ended` for one that ended, `workflow.event_invalid` for
 * an event its binding doesn't take, `workflow.event_denied` when the
 * authority behind the binding no longer holds, `workflow.event_refused`
 * when the run can't take it now, `workflow.event_conflict` for a key
 * used for another event.
 */
export const admitRunEvent = async (
  env: Env,
  delivery: RunEventDelivery
): Promise<AdmittedEvent> => {
  const parsed = deliverySchema.safeParse(delivery);
  if (!parsed.success) {
    throw workflowResourceErrors.create("workflow.event_invalid");
  }
  const event = parsed.data;
  const row = await runOf(env, event.runId);
  if (row === undefined || row.workflowResourceId !== event.workflowId) {
    throw workflowResourceErrors.create("workflow.run_unavailable");
  }
  const run = await callingRunOf(env, event.workflowId, event.runId);
  if (run === undefined) {
    throw workflowResourceErrors.create("workflow.run_ended");
  }
  const binding = run.bindings.get(event.binding);
  const descriptor =
    binding?.kind === "event"
      ? await pinnedEventDataOf(env, binding, event.type)
      : undefined;
  if (binding === undefined || descriptor === undefined) {
    throw workflowResourceErrors.create("workflow.event_invalid");
  }
  try {
    await requireCallAuthority(env, run, binding);
  } catch (error) {
    if (workflowResourceErrors.codeOf(error) === "workflow.call_denied") {
      throw workflowResourceErrors.create("workflow.event_denied");
    }
    throw error;
  }
  const data = acceptedEventData(descriptor, event.data);
  // A run its lineage's age has passed can take no more steps: an event
  // it would never take isn't accepted. An independent run is its
  // lineage's root.
  const policy = await quotaPolicy(env);
  if (Date.now() - row.createdAt.getTime() >= policy.limits.workflowAgeMs) {
    throw workflowResourceErrors.create("workflow.event_refused");
  }
  const digest = await sha256Hex(
    canonicalJson([event.runId, event.binding, event.source, event.key])
  );
  const id = `evt_${digest.slice(0, 48)}`;
  const stored: StoredEvent = {
    id,
    source: event.source,
    type: event.type,
    ...(event.subject === undefined ? {} : { subject: event.subject }),
    datacontenttype: contentType,
    data,
  };
  const outcome = await runEngine(env).admitEvent(event.runId, {
    type: await eventTypeKey(event.binding, event.type),
    payload: stored,
    // Its ID names the delivery: a sender's key is its own, never another's.
    key: id,
    attributes: attributesOf(stored),
    sender: event.sender,
  });
  switch (outcome) {
    case "accepted":
    case "duplicate": {
      return { id, accepted: outcome === "accepted" };
    }
    case "conflict": {
      throw workflowResourceErrors.create("workflow.event_conflict");
    }
    case "ended": {
      throw workflowResourceErrors.create("workflow.run_ended");
    }
    case "too_large":
    case "full":
    case "missing": {
      // Full: the inbox, or its sender's share of it.
      // Missing: the engine has no record of the run yet (its start isn't
      // confirmed); a delivery later may find it.
      throw workflowResourceErrors.create("workflow.event_refused");
    }
    default: {
      return outcome satisfies never;
    }
  }
};
