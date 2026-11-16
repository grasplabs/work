import { z } from "zod";

import { connectorEventActions } from "./connect.ts";
import { connectionIdSchema, identifierSchema } from "./ids.ts";
import { jsonPointerPattern } from "./json.ts";
import type { Json } from "./json.ts";
import type { PermissionRequest, PermissionStatus } from "./permissions.ts";
import { workflowEventTypeSchema } from "./workflow-resources.ts";
import { emailLocalPartSchema } from "./workflows.ts";

// An independent workflow's triggers (platform specification 15, 24), as
// the session's `workflowResources.triggers` serves them: each a resource
// of its own that starts one workflow on its own, at the version live as
// it starts, acting for the person who created it. Who may do what, and why, is in
// core's trigger-resources.ts.

/** The kinds of trigger: what each is started by. */
export const triggerKinds = [
  "connector",
  "webhook",
  "schedule",
  "email",
] as const;

export type TriggerKind = (typeof triggerKinds)[number];

/**
 * A new trigger: its kind, the workflow it starts, and its own
 * configuration, checked against the kind's schema below.
 */
export const workflowTriggerCreateSchema = z.strictObject({
  kind: z.enum(triggerKinds),
  workflowId: z.string().min(1).max(128),
  /** The trigger's own configuration: its schedule, event type, mapping. */
  config: z.json(),
});

export type WorkflowTriggerCreate = z.input<typeof workflowTriggerCreateSchema>;

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
 * in workflows.ts: `/subject`, `/from/address`, `/text`). An attachment a
 * run file may be also carries `file` (`/attachments/0/file`): mapped
 * where the workflow's input takes a file, it is copied into the run as a
 * file of its own.
 */
export const emailTriggerConfigSchema = z.strictObject({
  input: inputMappingSchema,
  /**
   * The part before the `@` of the address it receives mail at, as an
   * App's email trigger names one (`emailLocalPartSchema`, e.g.
   * `invoices`), which no other workflow may have; without one, an
   * address of its own: `trigger-` and 128 random bits.
   */
  address: emailLocalPartSchema.optional(),
});

/**
 * A webhook trigger's configuration (GRA-1560): the event source whose
 * events start it, by its ID, and the event type it starts on. Each such
 * event's `data` is its run's input, as is, checked against the workflow
 * version's input schema as any start's input is.
 */
export const webhookTriggerConfigSchema = z.strictObject({
  source: identifierSchema,
  type: workflowEventTypeSchema,
});

/** A live trigger of a workflow, as `workflowResources.triggers` shows it. */
export interface WorkflowTrigger {
  id: string;
  kind: TriggerKind;
  /** Who created it, and may enable it again. */
  owner: string;
  /** The workflow it starts, at the version live as each run starts. */
  workflowId: string;
  /** The person its runs act for: its creator. */
  principal: string;
  enabled: boolean;
  createdAt: string;
  /**
   * Its configuration as it was created, in its kind's schema (an email
   * trigger's without its address, which is `address`); null for a
   * trigger from before it was kept.
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
   * at, on the deployment's mail domain: the name its builder chose, or
   * `trigger-` and 128 random bits of its own, never derived from its ID;
   * null for any other kind.
   */
  address: string | null;
  /**
   * The event source a webhook trigger starts on (`config.source`), by its
   * ID and its name, and whether it was deleted since, when the trigger
   * starts nothing; null for any other kind.
   */
  source: TriggerSource | null;
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
  /**
   * Where a connector trigger's read of its event on its connection (and
   * part of it) stands, which it asks an admin for beside `start` as it is
   * created (`triggerEventsRequest`): as `start` says. Null for any other
   * kind, and for one holding none.
   */
  events: PermissionStatus | null;
}

/**
 * The binding name a trigger's `start` on its workflow is asked for under,
 * as it is created and whenever it is asked for again.
 */
export const triggerStartBinding = "START";

/**
 * The binding name a connector trigger's read of its connection's events
 * is asked for under, as it is created and whenever it is asked for again.
 */
export const triggerEventsBinding = "EVENTS";

/** The request for trigger `triggerId`'s `start` on `workflowId`, the workflow it pins. */
export const triggerStartRequest = (
  triggerId: string,
  workflowId: string
): PermissionRequest => ({
  subject: { type: "trigger", triggerId },
  object: { type: "workflow", workflowId },
  actions: ["start"],
  binding: triggerStartBinding,
});

/**
 * The request for connector trigger `triggerId` to hear the events of
 * type `event` on `connection` (and the part of it it names): that event's
 * read action there (`connectorEventActions`), and nothing else, as core
 * grants a trigger on a connection. Undefined for an event type no
 * connection reports.
 */
export const triggerEventsRequest = (
  triggerId: string,
  connection: { connectionId: string; resource?: string | undefined },
  event: string
): PermissionRequest | undefined => {
  const action = Object.entries(connectorEventActions).find(
    ([type]) => type === event
  )?.[1];
  if (action === undefined) {
    return undefined;
  }
  return {
    subject: { type: "trigger", triggerId },
    object: {
      type: "connection",
      connectionId: connection.connectionId,
      ...(connection.resource === undefined
        ? {}
        : { resource: connection.resource }),
    },
    actions: [action],
    binding: triggerEventsBinding,
  };
};

/**
 * What a trigger holding a permission is, for whoever decides it (the
 * admin's pending requests): its kind, and what starts it, without its
 * input or mapping. A schedule's expression and time zone; a connector
 * trigger's event type and connection; a webhook trigger's event type
 * and source. An email trigger's address and a source's URL are never in
 * it.
 */
export interface TriggerSummary {
  kind: TriggerKind;
  schedule: { cron: string; timeZone: string } | null;
  event: string | null;
  connection: { connectionId: string; resource: string | null } | null;
  source: TriggerSource | null;
}

/** The event source a webhook trigger starts on, as a trigger names it. */
export interface TriggerSource {
  id: string;
  name: string;
  deleted: boolean;
}

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
   * `start` on the workflow (under `triggerStartBinding`) and, for a
   * connector trigger, for its event's read on its connection (under
   * `triggerEventsBinding`), which wait for an admin; all audited.
   * Deleting the trigger revokes them.
   */
  create: (input: unknown) => Promise<CreatedWorkflowTrigger>;
  /**
   * Disables trigger `id`, for its owner, the workflow's builders and the
   * organization's admins, or enables it again, for its owner while they
   * still build the workflow; audited.
   */
  setEnabled: (id: string, enabled: boolean) => Promise<WorkflowTrigger>;
  /** Deletes trigger `id`, for whoever may disable it; audited. */
  delete: (id: string) => Promise<void>;
}

/** A trigger as it was created. */
export type CreatedWorkflowTrigger = WorkflowTrigger;
