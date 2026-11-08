import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { workflowEventTypeSchema } from "./workflow-resources.ts";

// Event sources (GRA-1560): where outside systems send events into the
// deployment. An admin creates one per sender ("Stripe", "Shop system")
// and gets one URL and one secret; core checks every delivery's signature
// and turns it into a typed event (`payment.paid`), which triggers start
// workflows on. Who may do what, and why, is in core's event-sources.ts;
// how a delivery is taken, in core's workflows/source-events.ts.

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
  "webhook.busy":
    "A workflow this event starts has started as many runs as it may this hour, or couldn't start one now. Try again later.",
  "webhook.source_invalid": "That isn't a source you can create.",
  "webhook.source_unavailable": "There is no such source.",
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
}

/** A source as it was created or its secret rotated: the secret, this once. */
export interface EventSourceWithSecret {
  source: EventSource;
  secret: string;
}

/**
 * The deployment's event sources over `/rpc` (`workflowResources.sources`).
 * Admins create, rotate, revoke and delete them; builders list them, to
 * start a workflow on one's events.
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
   * trigger on it starts anything; audited.
   */
  delete: (id: string) => Promise<void>;
}
