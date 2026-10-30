import { z } from "zod";

import { connectorEventActions } from "./connect.ts";
import { connectionIdSchema, identifierSchema } from "./ids.ts";
import { jsonPointerPattern } from "./json.ts";
import type { Json } from "./json.ts";

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
   * Whether a schedule trigger stopped after its starts kept failing
   * (`maxFailedStarts` in a row): it starts nothing until its owner
   * enables it again, which starts its schedule afresh.
   */
  stopped: boolean;
}

/**
 * An independent workflow's triggers over `/rpc`
 * (`workflowResources.triggers`). A trigger starts nothing until an admin
 * grants it `start` on its workflow, a permission of its own.
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
   * caller, who must build the workflow; audited.
   */
  create: (input: unknown) => Promise<WorkflowTrigger>;
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
}
