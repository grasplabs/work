import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import type { Json } from "./json.ts";
import type { PermissionStatus } from "./permissions.ts";
import { workflowEventTypeSchema } from "./workflow-resources.ts";

// Event sources (GRA-1560): where outside systems send events into the
// deployment. An admin creates one per sender ("Stripe", "Shop system")
// and gets one URL and one secret; core checks every delivery's signature
// and turns it into a typed event (`payment.paid`), which triggers start
// workflows on. Who may do what, and why, is in core's event-sources.ts;
// how a delivery is taken, in core's workflows/source-events.ts; what is
// kept of one for its admins to see, and for how long, in core's
// workflows/source-deliveries.ts.

/** A source's name, as its admin gives it: one line, 1 to 80 characters. */
export const eventSourceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  // oxlint-disable-next-line no-control-regex -- control characters are what it refuses
  .regex(/^[^\u0000-\u001F\u007F]*$/u, "One line");

/** A new source: its name. */
export const eventSourceCreateSchema = z.strictObject({
  name: eventSourceNameSchema,
});

/** What a delivery to a source may be, by what it bounds. */
export const eventSourceLimits = {
  /** The most bytes of a delivery's body. */
  bodyBytes: 64 * 1024,
  /**
   * How far a delivery's timestamp may be from now, either way, in
   * seconds: a delivery replayed later than this is refused.
   */
  toleranceSeconds: 5 * 60,
} as const;

/**
 * What a source keeps of its deliveries for its admins to see (core's
 * workflows/source-deliveries.ts), by what it bounds.
 */
export const eventSourceRetention = {
  /** How long an accepted delivery's payload is kept: a day. */
  payloadMs: 24 * 60 * 60 * 1000,
  /**
   * How long an accepted delivery is listed, without its payload once that
   * is gone, and how long a source's counts are kept: a week.
   */
  deliveryMs: 7 * 24 * 60 * 60 * 1000,
  /**
   * The most deliveries one source lists at once, its newest: a sender's
   * volume fills no database. Its counts count every one all the same.
   */
  perSource: 1000,
  /** The deliveries one page of a source's list holds. */
  pageSize: 50,
} as const;

/**
 * Why a source refused a delivery it counts: its secret revoked; its
 * signing headers missing, malformed or more than five minutes from now;
 * signed with another secret, or not at all; its secret rotated, revoked
 * or the source deleted as it was admitted; its body larger than
 * `eventSourceLimits.bodyBytes`; signed, but its body not an event (a
 * JSON object with a `type` and `data`); its `webhook-id` delivered
 * before with another event; or told to try again later (a workflow it
 * starts had no room this hour or couldn't start, or a waiting run
 * couldn't take it). `revoked`, `headers` and `too_large` are counted
 * before the signature is checked; `body`, `conflict`, `busy` and
 * `rotated` only once it is. A delivery to a URL no source has is counted
 * nowhere.
 */
export const eventSourceRefusalReasons = [
  "revoked",
  "headers",
  "signature",
  "rotated",
  "too_large",
  "body",
  "conflict",
  "busy",
] as const;

export type EventSourceRefusalReason =
  (typeof eventSourceRefusalReasons)[number];

/**
 * A test event an admin sends a source (`EventSourcesApi.sendTest`): a
 * type and data as a delivery's body has them, and nothing else.
 */
export const eventSourceTestSchema = z.strictObject({
  type: workflowEventTypeSchema,
  data: z.json(),
});

/**
 * The headers a delivery is signed with, as the Standard Webhooks
 * specification has them (standardwebhooks.com): the delivery's own ID,
 * the same on every retry of it; the Unix time in seconds it was signed
 * at; and one or more signatures, space-separated, each `v1,` and the
 * base64 HMAC-SHA256, with the key of the source's secret (`whsec_` and
 * the key, in base64), of the ID, a dot, the timestamp, a dot and the body
 * exactly as sent.
 */
export const eventSourceHeaders = {
  id: "webhook-id",
  timestamp: "webhook-timestamp",
  signature: "webhook-signature",
} as const;

/**
 * A delivery's body, as Standard Webhooks shapes a payload: the event's
 * `type` (`payment.paid`) and its `data`, any JSON. Anything else in it
 * (its `timestamp`, say) is the sender's and is left out.
 */
export const sourceEventSchema = z.looseObject({
  type: workflowEventTypeSchema,
  data: z.json(),
});

/** Why a source refused a delivery or a change, as whoever asked is told. */
export const eventSourceErrors = defineErrorFamily({
  "webhook.signature_invalid":
    "This delivery isn't signed with the source's secret as Standard Webhooks signs one (webhook-id, webhook-timestamp, webhook-signature), or its timestamp is more than five minutes from now.",
  "webhook.body_invalid":
    'A delivery\'s body is one JSON object of at most 64 KiB, with the event\'s "type" and its "data".',
  "webhook.delivery_conflict":
    "This webhook-id was delivered before with another event. A retry sends the same event; a new event takes a new webhook-id.",
  "webhook.busy":
    "A workflow this event starts has started as many runs as it may this hour, or couldn't start one now. Try again later.",
  "webhook.source_invalid": "That isn't a source you can create.",
  "webhook.source_unavailable": "There is no such source.",
  "webhook.delivery_unavailable": "There is no such delivery.",
  "webhook.page_invalid": "That isn't a page of a source's deliveries.",
  "webhook.test_invalid":
    'A test event has a "type" and "data", of at most 64 KiB together.',
});

/** A source's secret: whether it takes deliveries. */
export type EventSourceSecret = "active" | "revoked";

/** A live source, as `workflowResources.sources` lists it. */
export interface EventSource {
  id: string;
  name: string;
  createdAt: string;
  /** Who created it. */
  createdBy: string;
  /**
   * The token its URL ends in (`<origin>${eventSourcePath}/<token>`), and
   * whether its secret takes deliveries: for admins, who give the URL to
   * its sender; null for anyone else, who picks it for a trigger by name.
   */
  delivery: { token: string; secret: EventSourceSecret } | null;
  /** What it received lately: for admins; null for anyone else. */
  activity: EventSourceActivity | null;
}

/**
 * What a source received lately, from its counts by the hour, which count
 * every delivery from its sender (never an admin's test events), however
 * many are listed.
 */
export interface EventSourceActivity {
  /** When it last accepted a delivery, in the last seven days; else null. */
  lastEventAt: string | null;
  /** The deliveries it accepted in this hour and the 23 before it. */
  acceptedLastDay: number;
  /** The deliveries it refused, as counted, in this hour and the 23 before it. */
  refusedLastDay: number;
}

/**
 * A delivery a source accepted, or a test event an admin sent it, as its
 * list shows it: never its payload.
 */
export interface EventSourceDelivery {
  id: string;
  receivedAt: string;
  /** The event's type. */
  type: string;
  /** Whether an admin sent it as a test: it started nothing. */
  test: boolean;
  /**
   * How many triggers it started a run for; none for a test. A delivery
   * is listed once by its `webhook-id`: a sender's retry of it isn't
   * listed again, and raises this only when it started a trigger added
   * since.
   */
  triggersStarted: number;
  /** Whether its payload is still held (`eventSourceRetention.payloadMs`). */
  payloadHeld: boolean;
}

/** One page of a source's deliveries, newest first, and the next, if any. */
export interface EventSourceDeliveryPage {
  deliveries: EventSourceDelivery[];
  /** What `EventSourcesApi.deliveries` takes for the page after this one. */
  next: string | null;
}

/** A delivery with its payload: the event's data, or null once it is gone. */
export interface EventSourceDeliveryWithPayload extends EventSourceDelivery {
  payload: Json | null;
}

/** How often a source refused a delivery for one reason, over the last week. */
export interface EventSourceRefusals {
  reason: EventSourceRefusalReason;
  /** In this hour and the 23 before it. */
  lastDay: number;
  /** In the last seven days. */
  lastWeek: number;
  /** When it last did. */
  lastAt: string;
}

/** A live webhook trigger on a source, with the workflow it starts. */
export interface EventSourceTrigger {
  id: string;
  /** The event type it starts on. */
  type: string;
  enabled: boolean;
  /** Where its `start` on its workflow stands (`WorkflowTrigger.start`). */
  start: PermissionStatus | null;
  workflow: { id: string; name: string };
}

/** What came of a test event: how it is listed, and the triggers it matches. */
export interface EventSourceTestResult {
  delivery: EventSourceDelivery;
  /**
   * The enabled triggers on its source and type, as a delivery of it would
   * find them: each would start its workflow only while its `start` is
   * `active`, and the event's data is an input the workflow takes.
   */
  matched: EventSourceTrigger[];
}

/** A source as it was created or its secret rotated: the secret, this once. */
export interface EventSourceWithSecret {
  source: EventSource;
  secret: string;
}

/**
 * The deployment's event sources over `/rpc` (`workflowResources.sources`).
 * Admins create, rotate, revoke and delete them, and see what each
 * received; builders list them, to start a workflow on one's events.
 * Grasp staff do none of it.
 */
export interface EventSourcesApi {
  /** The live sources, oldest first: for admins and builders. */
  list: () => Promise<EventSource[]>;
  /**
   * Creates a source (`eventSourceCreateSchema`), for an admin: its URL and
   * its secret, which is answered this once, never again; audited, never
   * with it.
   */
  create: (input: unknown) => Promise<EventSourceWithSecret>;
  /**
   * Makes source `id` a new secret, for an admin: the old one takes no
   * delivery from then on. The new one is answered this once; audited.
   */
  rotateSecret: (id: string) => Promise<EventSourceWithSecret>;
  /**
   * Revokes source `id`'s secret, for an admin: no delivery is taken until
   * one makes a new one; audited.
   */
  revokeSecret: (id: string) => Promise<EventSource>;
  /**
   * Deletes source `id`, for an admin: its URL takes nothing more, and no
   * trigger on it starts anything, and what it kept of its deliveries goes
   * with it; audited.
   */
  delete: (id: string) => Promise<void>;
  /**
   * Source `id`'s deliveries, newest first, a page at a time (`page`, a
   * page's `next`), without their payloads: for an admin.
   */
  deliveries: (id: string, page?: string) => Promise<EventSourceDeliveryPage>;
  /**
   * Delivery `deliveryId` of source `id` with its payload, for an admin:
   * audited by who read which delivery, never with the payload. One of
   * another source isn't there.
   */
  delivery: (
    id: string,
    deliveryId: string
  ) => Promise<EventSourceDeliveryWithPayload>;
  /**
   * How often source `id` refused a delivery in the last seven days, by
   * reason: for an admin. Counts only: nothing of a refused delivery is
   * kept.
   */
  refusals: (id: string) => Promise<EventSourceRefusals[]>;
  /**
   * The live webhook triggers on source `id`, each with its workflow, for
   * an admin, who may see every workflow and its triggers.
   */
  triggers: (id: string) => Promise<EventSourceTrigger[]>;
  /**
   * Sends source `id` a test event (`eventSourceTestSchema`), for an
   * admin: listed as a delivery marked a test, and answered with the
   * triggers it matches. It starts no run and reaches no waiting run;
   * audited.
   */
  sendTest: (id: string, input: unknown) => Promise<EventSourceTestResult>;
}
