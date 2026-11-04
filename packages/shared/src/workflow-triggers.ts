import { z } from "zod";

import { connectorEventActions } from "./connect.ts";
import { defineErrorFamily } from "./errors.ts";
import { connectionIdSchema, identifierSchema } from "./ids.ts";
import { jsonPointerPattern } from "./json.ts";
import type { Json } from "./json.ts";
import type { PermissionStatus } from "./permissions.ts";

// An independent workflow's triggers (platform specification 15, 24), as
// the session's `workflowResources.triggers` serves them: each a resource
// of its own that starts one exact version of one workflow on its own,
// acting for the person who created it. Who may do what, and why, is in
// core's trigger-resources.ts.

/** The kinds of trigger: what each is started by. */
export const triggerKinds = [
  "system",
  "connector",
  "webhook",
  "schedule",
  "email",
] as const;

export type TriggerKind = (typeof triggerKinds)[number];

/**
 * A new trigger: its kind, the exact published version of the workflow it
 * starts, and its own configuration, checked against the kind's schema
 * below.
 */
export const workflowTriggerCreateSchema = z.strictObject({
  kind: z.enum(triggerKinds),
  workflowId: z.string().min(1).max(128),
  version: z.number().int().positive(),
  /** The trigger's own configuration: its schedule, event type, mapping. */
  config: z.json(),
});

export type WorkflowTriggerCreate = z.input<typeof workflowTriggerCreateSchema>;

/**
 * A system trigger's configuration (spec 15.1: "declared resource/event
 * type"): the catalog event contract, by its key, and the type of it
 * whose emitted events start its workflow, the event's data its input.
 * Nothing else: no expression, no URL.
 */
export const systemTriggerConfigSchema = z.strictObject({
  event: z.strictObject({
    contract: z.string().min(1).max(256),
    type: z.string().min(1).max(256),
  }),
});

/**
 * A schedule trigger's configuration (spec 15.1, 15.2): when it starts its
 * workflow, a five-field cron expression read in an IANA time zone; the
 * literal input each run starts with; and what it does about occurrences
 * missed while nothing ran, which is to start one run for them all
 * (`coalesce`, the only choice).
 */
export const scheduleTriggerConfigSchema = z.strictObject({
  schedule: z.strictObject({
    cron: z.string().min(1).max(256),
    timeZone: z.string().min(1).max(64),
  }),
  input: z.json(),
  missedOccurrences: z.literal("coalesce"),
});

/** Most input fields a connector trigger's mapping names. */
const maxMappedFields = 50;

const inputFieldSchema = z.string().min(1).max(128);

/**
 * How a connector trigger's event becomes its run's input (spec 15.2):
 * each input field from a JSON Pointer into the event (RFC 6901; `/id`,
 * `/payload/subject`), and literal defaults for fields the event lacks.
 * Nothing in it is evaluated.
 */
export const inputMappingSchema = z.strictObject({
  fields: z
    .record(
      inputFieldSchema,
      z.string().max(512).regex(jsonPointerPattern, "Not a JSON Pointer")
    )
    .refine((fields) => Object.keys(fields).length <= maxMappedFields)
    .default({}),
  defaults: z
    .record(inputFieldSchema, z.json())
    .refine((defaults) => Object.keys(defaults).length <= maxMappedFields)
    .default({}),
});

/** A connector trigger's mapping of its event to its run's input. */
export type InputMapping = z.infer<typeof inputMappingSchema>;

/**
 * A connector trigger's configuration (spec 15.1, "Connect verified
 * event"): the connection whose events start it, and the part of it (a
 * mailbox, a drive) or none for the account's own; the event type; and
 * how each event becomes the run's input.
 */
export const connectorTriggerConfigSchema = z.strictObject({
  connection: z.strictObject({
    connectionId: connectionIdSchema,
    resource: identifierSchema.optional(),
  }),
  event: z
    .string()
    .refine((type) => Object.hasOwn(connectorEventActions, type), {
      message: "Not an event type a connection reports",
    }),
  input: inputMappingSchema,
});

/**
 * An email trigger's configuration: how each message to its address
 * becomes the run's input, mapped as a connector trigger's event is, from
 * the message as an App's email trigger hands it over (`inboundEmailSchema`
 * in workflows.ts: `/subject`, `/from/address`, `/text`).
 */
export const emailTriggerConfigSchema = z.strictObject({
  input: inputMappingSchema,
});

/**
 * A webhook trigger's configuration (GRA-1478): nothing. Each delivery's
 * JSON body is its run's input, as is, checked against the workflow
 * version's input schema as any start's input is.
 */
export const webhookTriggerConfigSchema = z.strictObject({});

/** What a webhook trigger's delivery may be, by what it bounds. */
export const workflowWebhookLimits = {
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
 * base64 HMAC-SHA256, with the key of the trigger's secret (`whsec_` and
 * the key, in base64), of the ID, a dot, the timestamp, a dot and the body
 * exactly as sent.
 */
export const workflowWebhookHeaders = {
  id: "webhook-id",
  timestamp: "webhook-timestamp",
  signature: "webhook-signature",
} as const;

/** Why a webhook trigger refused a delivery, as its sender is told. */
export const workflowWebhookErrors = defineErrorFamily({
  "webhook.signature_invalid":
    "This delivery isn't signed with the trigger's secret as Standard Webhooks signs one (webhook-id, webhook-timestamp, webhook-signature), or its timestamp is more than five minutes from now.",
  "webhook.body_invalid":
    "A delivery's body is one JSON value, of at most 64 KiB.",
  "webhook.input_refused":
    "The workflow didn't take this delivery: its body isn't an input the workflow takes, or the trigger may not start it now.",
  "webhook.busy":
    "The trigger has started as many runs as it may this hour, or couldn't start one now. Try again later.",
});

/** A live trigger of a workflow, as `workflowResources.triggers` shows it. */
export interface WorkflowTrigger {
  id: string;
  kind: TriggerKind;
  /** Who created it, and may move it to another version or enable it. */
  owner: string;
  /** Its own version: one more each time it moves to another workflow version. */
  version: number;
  workflowId: string;
  /** The exact workflow version it starts, never "the latest". */
  workflowVersion: number;
  /** The person its runs act for: its creator. */
  principal: string;
  enabled: boolean;
  createdAt: string;
  /**
   * Its configuration as it was created, in its kind's schema; null for a
   * kind that keeps none (a webhook) or a trigger from before it was kept.
   */
  config: Json | null;
  /**
   * When a schedule trigger next starts a run; null for any other kind,
   * and for one whose schedule names no time to come or stopped after its
   * starts kept failing (enabling it again starts it afresh).
   */
  nextAt: string | null;
  /**
   * The part before the `@` of the address an email trigger receives mail
   * at, on the deployment's mail domain: `trigger-` and 128 random bits
   * of its own, never derived from its ID; null for any other kind.
   */
  address: string | null;
  /**
   * A webhook trigger's token, which its URL ends in
   * (`<origin>${workflowWebhookPath}/<token>`), shown only to whoever may
   * see the trigger, and whether its secret takes deliveries (`revoked`
   * once revoked, until a new one is made); null for any other kind.
   */
  webhook: { token: string; secret: "active" | "revoked" } | null;
  /**
   * Whether a schedule trigger stopped after its starts kept failing
   * (`maxFailedStarts` in a row): it starts nothing until its owner
   * enables it again, which starts its schedule afresh.
   */
  stopped: boolean;
  /**
   * Where its `start` on its workflow stands, which it asks an admin for
   * as it is created (under `triggerStartBinding`): `active` once
   * granted, `requested` while it waits, `revoked` once refused or taken
   * back, when its builders ask again with a new request
   * (`PermissionsApi.request`, under the same binding). Null only if it
   * holds none, as no trigger made since it asks does.
   */
  start: PermissionStatus | null;
}

/**
 * The binding name a trigger's `start` on its workflow is asked for under,
 * as it is created and whenever it is asked for again.
 */
export const triggerStartBinding = "START";

/**
 * An independent workflow's triggers over `/rpc`
 * (`workflowResources.triggers`). A trigger starts nothing until an admin
 * grants it `start` on its workflow, a permission of its own, which it
 * asks for as it is created.
 */
export interface WorkflowTriggersApi {
  /**
   * The live triggers of workflow `workflowId`, oldest first: every one
   * for its builders and the organization's admins, the caller's own for
   * anyone else.
   */
  list: (workflowId: string) => Promise<WorkflowTrigger[]>;
  /**
   * Creates a trigger (`workflowTriggerCreateSchema`) that acts for the
   * caller, who must build the workflow, and with it the request for its
   * `start` on the workflow (under `triggerStartBinding`), which waits for
   * an admin; both audited. Deleting the trigger revokes it.
   */
  create: (input: unknown) => Promise<CreatedWorkflowTrigger>;
  /**
   * Moves trigger `id` to another published version of its workflow; for
   * its owner while they still build the workflow, audited.
   */
  setVersion: (id: string, version: number) => Promise<WorkflowTrigger>;
  /**
   * Disables trigger `id`, for its owner, the workflow's builders and the
   * organization's admins, or enables it again, for its owner while they
   * still build the workflow; audited.
   */
  setEnabled: (id: string, enabled: boolean) => Promise<WorkflowTrigger>;
  /** Deletes trigger `id`, for whoever may disable it; audited. */
  delete: (id: string) => Promise<void>;
  /**
   * Makes webhook trigger `id` a new secret, for its owner while they still
   * build the workflow: the old one takes no delivery from then on. The
   * new one is answered this once, never again; audited, never with it.
   */
  rotateWebhookSecret: (id: string) => Promise<{ secret: string }>;
  /**
   * Revokes webhook trigger `id`'s secret, for whoever may disable it: no
   * delivery is taken until its owner makes a new one; audited.
   */
  revokeWebhookSecret: (id: string) => Promise<WorkflowTrigger>;
}

/**
 * A trigger as it was created: a webhook trigger's with its secret, this
 * once (`secret`), never shown again.
 */
export type CreatedWorkflowTrigger = WorkflowTrigger & { secret?: string };
