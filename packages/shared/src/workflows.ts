import { Cron } from "croner";
import { z } from "zod";

import type { ProviderTrouble } from "./ai-providers.ts";
import { defineErrorFamily } from "./errors.ts";
import { connectionIdSchema, identifierSchema } from "./ids.ts";
import type { AppId, RunId, WorkflowId, WorkflowResourceId } from "./ids.ts";
import type { Json } from "./json.ts";
import { isRetryableCode } from "./operations.ts";
import { permissionActionSchema } from "./permissions.ts";
import { platformLimits } from "./platform-limits.ts";
import type { RunFilterStatus } from "./run-filter.ts";
import type { WorkflowRunStatus } from "./workflow-resources.ts";

export { runFilterStatuses } from "./run-filter.ts";
export type { RunFilterStatus } from "./run-filter.ts";

// A workflow is code in an App (`workflows/<id>.ts`), written with the
// workflow SDK. Each run is pinned to the App version it started on, and
// acts for one person: the one who started it, or the App's owner for a
// run a trigger started. A workflow also has an owner, who answers for
// it: shown with it and told when a run a trigger started fails. Its App's
// owner unless someone set another; it never changes whom a run acts for.

/** A workflow parameter's value: a number, or text. */
export type ParamValue = string | number;

/**
 * Why a call of a run's code was refused for the execution it came from,
 * named as the engine's contract names them (`execution.*`), whatever
 * workflow the run is of.
 */
export const executionErrors = defineErrorFamily({
  "execution.stale_attempt":
    "This step's attempt has ended (it ran out of time, or the run was paused or cancelled): what its code still does acts no more.",
});

/** Why a workflow call was refused. */
export const workflowErrors = defineErrorFamily({
  "workflow.invalid": "That isn't a valid request for a workflow.",
  "workflow.not_found": "The App's current version has no such workflow.",
  "workflow.run_not_found": "There's no such workflow run.",
  "workflow.run_details_removed":
    "This run's details were removed when its retention ended, so there is nothing left to work out a fix from.",
  "workflow.build_failed": "The App's workflows don't build.",
  "workflow.model_undeclared":
    "A workflow's AI step goes through an `ai` permission this version doesn't declare, so it can't be made current.",
  "workflow.tests_failed":
    "A workflow's tests fail, or it has none, so this version can't be made current.",
  "workflow.outside_step":
    "A workflow calls its connections only inside a step: code between steps runs again on every replay.",
  "workflow.control_conflict":
    "Another pause, resume or cancel of this run is still being applied, or the run is being cancelled: wait for it, then try again.",
  "workflow.control_refused":
    "The run has ended, so it can't be paused, resumed or cancelled.",
  "workflow.control_rolling_back":
    "The run is rolling back what it did, so it can't be paused, resumed or cancelled until that's done.",
  "workflow.too_many_steps":
    "This run has taken as many steps as a workflow run may: split the work over more runs.",
  "workflow.too_many_attempts":
    "This step has been tried as many times as a step may be, its first attempt included.",
  "workflow.lineage_limit":
    "This workflow run, with the runs it started, has reached a limit it may have: how many steps a run takes, how deep its runs nest, how many runs it starts, how long its steps run in all, how many calls its steps make, or how old it is. No more of it can be admitted.",
  "workflow.between_steps_limit":
    "This workflow run's code spent as long outside its steps as it may: wait with a step's sleep, not a timer, and do the work inside steps.",
  "workflow.lineage_busy":
    "Steps still running in this workflow run, or in runs it started, hold what's left of its run time. Try again once they finish.",
  "workflow.queued":
    "As many workflow steps as may run at once, in this App or in the organization, are already running. This one waits and runs once one finishes.",
  "workflow.queue_timeout":
    "This workflow step waited to run for as long as a step may wait, so it was stopped. Steps already running kept the organization or this App busy throughout: try again later.",
  "workflow.idempotency_key_invalid":
    "A workflow's connection calls take their step's own idempotency key (the `idempotencyKey` a side-effect step gets), or none: the platform keeps side effects to once per step and run.",
  "workflow.param_not_found":
    "The workflow has no such parameter in the App's current version.",
  "workflow.param_invalid": "That isn't a valid value for this parameter.",
  "workflow.param_conflict":
    "The App's current version changed while the value was set. Try again.",
  "workflow.trigger_gone":
    "The trigger belongs to a version of the App that is no longer current.",
  "workflow.owner_invalid":
    "Only a current member of the organization who can open the App can own its workflow.",
  "workflow.owner_conflict":
    "Someone changed the workflow's owner meanwhile. Try again.",
  "workflow.team_invalid": "That isn't one of the organization's teams.",
  "workflow.email_taken":
    "Another workflow already receives mail at this address.",
  "workflow.attachment_not_found":
    "This App has no such attachment: the message isn't kept for it, or its 30 days have passed.",
  "workflow.attachment_unreadable":
    "The kept message can't be read any more, so none of its attachments can.",
  "workflow.call_not_reviewed":
    "A step called a binding its version's review doesn't show it calling: call each binding only in the step's own function.",
  "workflow.step_not_reviewed":
    "A step ran that its version's review doesn't show: run steps only as the workflow's function writes them.",
  "workflow.calls_not_kept":
    "This version keeps no reading of what the workflow calls, so it doesn't run: commit the workflow again.",
  // What a step or run failed with when its error named no code of its
  // own: the audit log and failure reports carry these instead.
  "workflow.step_failed": "A step of the workflow failed.",
  "workflow.run_failed": "The workflow run failed.",
  "workflow.compensation_failed":
    "The workflow run failed, and undoing what it had done failed too.",
});

/**
 * A parameter as a workflow's code declares it (the SDK's
 * `ParamMetadata`), within the bounds core keeps and shows: the SDK
 * refuses a definition outside them, so a version whose declarations core
 * would refuse never passes its tests. Kinds, and whether a default fits
 * its kind, are the SDK's to check (`paramValueSchemas`).
 */
export const paramDeclarationSchema = z.object({
  name: z.string().regex(/^[A-Za-z_$][\w$]{0,63}$/u),
  kind: z.string(),
  label: z.string().max(200),
  default: z.union([z.string().max(4096), z.number()]),
  sensitive: z.boolean(),
  currency: z.string().max(3).optional(),
});

/** Most parameters one workflow declares. */
const maxParamDeclarations = 100;

/**
 * A workflow's parameter declarations, each as `item` has it: at most
 * {@link maxParamDeclarations}, and each name once: with two declarations
 * of one name, which one a read goes by would be anyone's guess.
 */
export const paramDeclarationsSchema = <
  Item extends z.ZodType<{ name: string }>,
>(
  item: Item
) =>
  z
    .array(item)
    .max(maxParamDeclarations)
    .refine(
      (params) =>
        new Set(params.map(({ name }) => name)).size === params.length,
      { message: "Each name once" }
    );

/** Whether the runtime knows `timeZone`, an IANA name like `Europe/Amsterdam`. */
export const isTimeZone = (timeZone: string): boolean => {
  try {
    // oxlint-disable-next-line no-new -- constructing it is the check
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
};

/**
 * The longest a step's attempt may run (its `timeout`), and what it gets
 * when it declares none: an attempt's active wall time (spec 18.1, a
 * minute), which a declaration may only shorten. The SDK refuses a longer
 * one where the step is written, and the host refuses it at run time.
 * Longer work is split into steps; sleeps and decisions wait durably, so
 * their limits are far longer.
 */
export const maxAttemptTimeoutMs = platformLimits.workflowAttemptWallMs;

/**
 * The most retries a step may declare: its attempts (spec 18.1, five, its
 * first included) less its first. The SDK refuses more where the step is
 * written, and the host at run time; an operator's lower ceiling is held
 * as each attempt is admitted (core's quotas.ts).
 */
export const maxStepRetries = platformLimits.workflowAttemptsPerStep - 1;

/** The time zone of a schedule trigger that names none. */
export const defaultTimeZone = "UTC";

/** A schedule: a five-field cron expression, read in a time zone. */
export interface CronSchedule {
  cron: string;
  timeZone: string;
}

/**
 * How a schedule treats a local time the spring change skips (2:30 on the
 * night clocks go from 2:00 to 3:00): App schedules fire it an hour later,
 * at the same minute of the hour after; independent schedule triggers skip
 * it (platform specification 15.2), so no run starts for a time that
 * never was.
 */
export type SkippedTime = "shift" | "skip";

/** Most skipped times in a row one call steps past before giving up. */
const maxSkippedTimes = 1000;

/**
 * When `schedule` next fires strictly after `after`, to the minute;
 * undefined for an expression that isn't five cron fields, a time zone the
 * runtime doesn't know, or an expression that names no time to come (the
 * 30th of February). A time the autumn change repeats fires once, the
 * first time; one the spring change skips as `skipped` says.
 */
export const nextScheduledRun = (
  { cron, timeZone }: CronSchedule,
  after: Date,
  skipped: SkippedTime = "shift"
): Date | undefined => {
  if (!isTimeZone(timeZone)) {
    return undefined;
  }
  try {
    const schedule = new Cron(cron, { timezone: timeZone, mode: "5-part" });
    let next = schedule.nextRun(after) ?? undefined;
    if (skipped === "shift") {
      return next;
    }
    // croner moves a skipped local time to the hour after; that moved time
    // doesn't match the expression itself, which is how it is told apart.
    for (let step = 0; step < maxSkippedTimes; step += 1) {
      if (next === undefined || schedule.match(next)) {
        return next;
      }
      next = schedule.nextRun(next) ?? undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/**
 * How many starts of a schedule's run may fail in a row before the
 * schedule stops. The tries are spread over about two hours, so a short
 * outage stops nothing.
 */
export const maxFailedStarts = 8;

/** Whether `cron` is five cron fields that name a time to come. */
export const isCronExpression = (cron: string): boolean =>
  nextScheduledRun({ cron, timeZone: defaultTimeZone }, new Date()) !==
  undefined;

/**
 * The part of an address before the `@` that an email trigger receives
 * mail at, an App's or an independent workflow's, e.g. `invoices`: lower
 * case letters, digits, `.`, `_`, `+` and `-`, with no dot first, last or
 * twice in a row. One address on the deployment's mail domain is one
 * workflow's (core's workflows/email-addresses.ts).
 */
export const emailLocalPartSchema = z
  .string()
  .regex(/^[a-z0-9_+-]+(?:\.[a-z0-9_+-]+)*$/u)
  .max(64);

/**
 * Where a message an email trigger received is kept while its attachments
 * can be read: the UTC day it was stored and its ID, `2026-09-29/<id>`. It
 * names no App: a run reads only what its own App received.
 */
export const storedEmailSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}\/[0-9a-f]{64}$/u);

/** The largest message an email trigger takes, in bytes; larger ones bounce. */
export const inboundEmailMaxBytes = 10 * 1024 * 1024;

/**
 * The most of each of To and Cc, and of attachments, a message's run input
 * lists; so the most attachments a run reads by index.
 */
export const inboundEmailMaxListed = 100;

/** An attachment's index in a message's run input. */
export const inboundEmailIndexSchema = z
  .int()
  .min(0)
  .max(inboundEmailMaxListed - 1);

/** A name and address, as a message's headers give them. */
const mailboxSchema = z.object({ name: z.string(), address: z.string() });

/**
 * A message an email trigger received, as its run gets it as input. `id`
 * is the SHA-256 of its bytes. `from` is what the message's header says,
 * which its sender can write anything in: nothing vouches for it. Bounded
 * to fit a run's input (128 KiB of JSON): at most 100 each of `to`, `cc` and
 * `attachments` (listed, their content never included), names, addresses and file names
 * cut at 256 characters and the subject at 1,000, and as much of its
 * plain text as fits (for a message with only HTML, its text),
 * `truncated` when cut.
 *
 * `stored` is where the message is kept for 30 days, so the run can read
 * its attachments (`readAttachment` in `@grasp-os/sdk/workflow`); null
 * when it has none but inline ones, or while keeping messages is switched
 * off.
 */
export const inboundEmailSchema = z.object({
  id: z.string(),
  stored: storedEmailSchema.nullable(),
  from: mailboxSchema,
  to: z.array(mailboxSchema),
  cc: z.array(mailboxSchema),
  subject: z.string(),
  /** ISO 8601, as the message dates itself; null without a date. */
  date: z.string().nullable(),
  text: z.string(),
  truncated: z.boolean(),
  attachments: z.array(
    z.object({
      filename: z.string().nullable(),
      mimeType: z.string(),
      size: z.int(),
      /**
       * The attachment as a file of the run, `{ id }`, read through the
       * workflow's own files binding: given only to an independent
       * workflow's email trigger, and only for an attachment a run file
       * may be (inbound-email.ts in core).
       */
      file: z.object({ id: z.string() }).optional(),
    })
  ),
});

/** A message an email trigger received. */
export type InboundEmail = z.infer<typeof inboundEmailSchema>;

/** An event's type, e.g. `m365.mail.received`. */
export const eventTypeSchema = z.string().min(1).max(200);

/** Most fields an event trigger's filter names. */
const maxFilterFields = 20;

/**
 * An event trigger's filter: each field it names must hold that value at
 * the top of the event's payload, compared as is.
 */
export const eventFilterSchema = z
  .record(
    z.string().min(1).max(64),
    z.union([z.string().max(200), z.number(), z.boolean(), z.null()])
  )
  .refine((filter) => Object.keys(filter).length <= maxFilterFields, {
    message: `At most ${maxFilterFields} fields`,
  });

/** An event trigger's filter. */
export type EventFilter = z.infer<typeof eventFilterSchema>;

/** Whether `payload` holds every value `filter` names, at its top. */
export const matchesFilter = (
  filter: EventFilter | null | undefined,
  payload: Json
): boolean => {
  const isObject =
    typeof payload === "object" && payload !== null && !Array.isArray(payload);
  const fields = new Map(isObject ? Object.entries(payload) : []);
  return Object.entries(filter ?? {}).every(
    ([field, value]) => fields.has(field) && fields.get(field) === value
  );
};

/** The most JSON text an event's payload takes. */
const maxEventPayloadLength = 64 * 1024;

/**
 * An event a connection reported, as core takes it from connect and
 * delivers it, and as the run an event trigger starts gets it as input (the SDK's
 * `connectorEvent`). `id` is the source's own ID of the event, the same
 * for the same event delivered again; for an ID longer than 200
 * characters it is `sha256:` and the ID's SHA-256 instead, and the payload
 * has the ID in full. `resource` narrows it to a part of
 * the connection (a mailbox, a drive), when the source says. `action` is
 * the connector's read action whose data the event carries (such as
 * `mail.list`): an App hears the event only through a permission that
 * allows it, as it could only read the data with one. `owner` is a
 * personal connection's owner (their user ID), whom only their own Apps
 * hear from; null for a shared connection.
 */
export const connectorEventSchema = z.object({
  id: z.string().min(1).max(200),
  connection: connectionIdSchema,
  owner: identifierSchema.nullable(),
  resource: identifierSchema.optional(),
  action: permissionActionSchema,
  type: eventTypeSchema,
  payload: z
    .json()
    .refine(
      (payload) => JSON.stringify(payload).length <= maxEventPayloadLength,
      { message: `At most ${maxEventPayloadLength} characters of JSON` }
    ),
});

/** An event a connection reported. */
export type ConnectorEvent = z.infer<typeof connectorEventSchema>;

/**
 * An event as connect hands it to core: with the stamp a message carries,
 * if it carries one. What its sender wrote, so core believes it only as
 * its own record of a run's mail says (its workflows/mail-stamps.ts), and
 * never hands it to the run, which gets the event without it.
 */
export const deliveredConnectorEventSchema = connectorEventSchema.extend({
  stamp: z
    .string()
    .regex(/^[0-9a-f]{32}$/u)
    .optional(),
});

/** An event as connect hands it to core, with its stamp if any. */
export type DeliveredConnectorEvent = z.infer<
  typeof deliveredConnectorEventSchema
>;

/** Most triggers one workflow declares. */
const maxTriggerDeclarations = 20;

/**
 * A trigger as a workflow's code declares it (the SDK's `Trigger`), within
 * the bounds core keeps: the SDK refuses a definition outside them, so a
 * version whose triggers core would refuse never passes its tests. Which
 * parameter a schedule names, and whether it is a schedule, is the SDK's
 * to check.
 */
export const triggerDeclarationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }),
  z.object({
    type: z.literal("schedule"),
    param: paramDeclarationSchema.shape.name,
    timeZone: z
      .string()
      .max(64)
      .refine(isTimeZone, "Not a time zone the runtime knows")
      .optional(),
  }),
  z.object({
    type: z.literal("event"),
    event: eventTypeSchema,
    filter: eventFilterSchema.optional(),
  }),
  z.object({ type: z.literal("email"), address: emailLocalPartSchema }),
]);

/** A trigger as a workflow's code declares it. */
export type TriggerDeclaration = z.infer<typeof triggerDeclarationSchema>;

/** A workflow's triggers: at most {@link maxTriggerDeclarations}. */
export const triggerDeclarationsSchema = z
  .array(triggerDeclarationSchema)
  .max(maxTriggerDeclarations);

/**
 * What core's own steps of a run start with (core's workflows/), and the
 * keys core derives under a run's: a workflow's own steps never do, so
 * workflow code can neither replay one of core's steps nor name a step
 * whose key is one core derived.
 */
export const coreStepPrefix = "$grasp:";

/**
 * The key of a sensitive parameter's placeholder, `{"$grasp:param": name}`
 * (the SDK's `sensitiveParam`): where a sealed build seals that parameter
 * as a connector call's argument, its run host puts in the value the run's
 * start froze (core's workflows/sealed-run.ts). An App's run may send
 * none (core's workflows/app-run.ts).
 */
export const sensitiveParamKey = "$grasp:param";

/**
 * The parameter `value` is the placeholder of: only an object whose one
 * key is `sensitiveParamKey`, naming it as text. Any other value, one with
 * other `$grasp:` keys included, is data.
 */
export const placeholderOf = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  const name: unknown = Reflect.get(value, sensitiveParamKey);
  return keys.length === 1 &&
    keys[0] === sensitiveParamKey &&
    typeof name === "string"
    ? name
    : undefined;
};

/** Whether `value` holds a placeholder (`placeholderOf`) at any depth. */
export const holdsPlaceholder = (value: unknown): boolean => {
  const seen = new Set<unknown>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node === "object" && node !== null && !seen.has(node)) {
      if (placeholderOf(node) !== undefined) {
        return true;
      }
      seen.add(node);
      const items: unknown[] = Object.values(node);
      // One at a time: a spread of a large list would overflow the stack.
      for (const item of items) {
        pending.push(item);
      }
    }
  }
  return false;
};

/**
 * What a decision task's waits for its answer, and its looks after them,
 * start with (core's workflows/resource-host.ts): core's steps, so they
 * count against none of the run's steps however long it waits, each named
 * `<prefix><its task's step>:wait:<round>` or `…:woken:<round>`.
 */
export const decisionPollStepPrefix = `${coreStepPrefix}decision:`;

/**
 * The idempotency key of a run's step, as the SDK hands it to the step
 * and core requires it on the step's connection calls: the run ID
 * (encoded, so no run ID and step name make another's key) and the step's
 * engine name. The same on every attempt and replay of the step, and
 * never the same for two runs or two steps.
 */
export const stepIdempotencyKey = (runId: string, step: string): string =>
  `${encodeURIComponent(runId)}:${step}`;

/** The run a step's idempotency key (`stepIdempotencyKey`) belongs to. */
export const runOfStepKey = (key: string): string | undefined => {
  const end = key.indexOf(":");
  if (end <= 0) {
    return undefined;
  }
  try {
    return decodeURIComponent(key.slice(0, end));
  } catch {
    return undefined;
  }
};

/**
 * Codes of the failures trying again may fix, and can't make happen twice,
 * beside every platform code an App's function may answer that is worth
 * trying again unchanged (`isRetryableCode`, operations.ts): one list, so
 * a step retries what a caller of the function would. A connection's
 * server that took nothing (it turned the call away, or its native
 * connector said nothing was done); a call with the same idempotency key
 * still running, whose answer a retry gets; a model call that failed, or
 * that the model budget turned away only while other calls under way hold
 * it, that waited for a share of the model requests in flight, or that its
 * provider's rate limit turned away (nothing was sent, or nothing billed); something unplanned in the platform, where
 * connect's idempotency keys keep a retried side effect to once; and a
 * model's answer that didn't fit, which the SDK asks for again. Any other
 * failure stops the run: a refusal, a tool's own error (it may have
 * acted), a call whose outcome is unknown (an App method that timed out,
 * too), or an error the workflow's code throws.
 */
const workflowRetryableCodes: ReadonlySet<unknown> = new Set([
  "connect.server_unavailable",
  "connect.call_in_progress",
  "model.failed",
  // A provider that didn't answer: what `model.failed` said of it before.
  "model.provider_unavailable",
  // Nothing was sent; a share of the model requests in flight comes back
  // as they end, and a provider's rate as its window passes.
  "model.queued",
  "model.rate_limited",
  // Nothing ran; room comes back as the lineage's attempts under way settle.
  "workflow.lineage_busy",
  // Nothing ran; a slot comes back as attempts running at once settle.
  "workflow.queued",
  "internal.unexpected",
  "workflow.invalid_model_output",
]);

/** Whether `code` is one trying a step again may fix. */
const retryableCode = (code: unknown): boolean =>
  workflowRetryableCodes.has(code) ||
  (typeof code === "string" && isRetryableCode(code));

/**
 * Whether a step that failed with `error` may be tried again, as far as its
 * retries allow: a failure of a class trying again may fix, or an attempt
 * that ran out of time. Engines decide by this alone, so a step is retried
 * the same in tests (`@grasp-os/sdk/testing`) as in a real run.
 */
export const isRetryable = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (("code" in error && retryableCode(error.code)) ||
    ("name" in error && error.name === "TimeoutError"));

/**
 * What a failure report keeps of a step's input: its type, and for an
 * object the names of fields shaped like code's own (letters, `_` and
 * `-`, at most 32) with their types. No values, which can hold anything
 * the run read.
 */
export type InputShape = string | Record<string, string>;

/**
 * Why a run stopped, as its owner sees it: self-contained, so a chat can
 * attach it as it is. It holds nothing the run read, but for what the
 * workflow's code put in the error's message.
 *
 * That message is untrusted text, written by workflow code (which the
 * agent writes, and which may quote what the run read): whatever passes it
 * to an agent must pass it as data, never as instructions.
 */
export interface RunFailure {
  run: RunId;
  app: AppId;
  workflow: WorkflowId;
  /** The App version the run ran. */
  version: number;
  /**
   * The step it stopped at; null when it stopped outside any step
   * (loading its code, say, or in code between steps).
   */
  step: string | null;
  /** The shape of the step's input; null without one. */
  input: InputShape | null;
  error: {
    /** Such as `connect.action_failed`; `workflow.run_failed` without one. */
    code: string;
    message: string;
  };
  /** ISO 8601. */
  failedAt: string;
}

/**
 * Where a run is: running (a step, or a sleep), queued for a share of the
 * attempts that run at once (`RunQueue`), waiting for a decision, paused
 * (its engine instance is), or ended.
 */
export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * A run as an App's screens observe it, all of one revision of the run
 * (core's workflows/summary.ts): its status, who it is, its times (Unix
 * milliseconds), the decisions it waits for, a compensation's cause and
 * activity, and what the person asking may do with it now. `revision`
 * orders snapshots: a greater one is newer.
 */
export interface RunSummary {
  revision: number;
  runId: string;
  workflowId: string;
  workflowVersion: number;
  status:
    | "queued"
    | "running"
    | "waiting"
    | "paused"
    | "compensating"
    | "completed"
    | "failed"
    | "cancelled";
  createdAt: number;
  /** When the engine first ran it; null until it has. */
  startedAt: number | null;
  /** Once it has ended; null before. */
  finishedAt: number | null;
  /** While it compensates: why, and what its cleanup is doing. */
  compensation?: {
    cause: "failure" | "cancellation";
    activity: "running" | "waiting" | "paused";
    /**
     * After a failure, what the run failed with, to those who see why a
     * run failed (its person and admins): as `error` once it ends.
     */
    originalError?: { code: string; message: string };
  };
  /** Why it failed, once failed: a code and message, no values. */
  error?: { code: string; message: string };
  /** The decisions it waits for now: none once it has ended. */
  waits: { kind: "decision"; name: string; expiresAt: number }[];
  /**
   * While it is `queued` for a share of the attempts that run at once (its
   * App's, its person's or the organization's): which, and when it asks
   * again at the latest. Throttling, not a fault of the workflow.
   */
  queued?: { waitingFor: "client" | "person" | "app"; retryAt: number };
  /**
   * While it is `queued` because a model call of it failed on the
   * organization's own AI provider key: the provider, what it showed (it
   * refuses the key, isn't answering, or is limiting requests), and since
   * when. It goes on by itself once calls work.
   */
  aiProvider?: { since: number; provider: string; trouble: ProviderTrouble };
  /**
   * What the person asking may do now, as the host would admit it, and a
   * control the host admitted that the engine is still applying.
   */
  control: {
    canPause: boolean;
    canResume: boolean;
    canCancel: boolean;
    pendingControl: {
      kind: "pause" | "resume" | "cancel";
      stage: "applying";
    } | null;
  };
}

/**
 * A step's or a compensation's failure as a run's history shows it. To
 * those who see the run's details (admins, and the person it acts for):
 * its code and message. To anyone else: the code only when it is one the
 * platform defines (`isExpectedCode`), otherwise `workflow.step_failed`,
 * and the code's own words, never the workflow's message.
 */
export interface RunHistoryError {
  code: string;
  message: string;
}

/**
 * One entry of a run's history (core's workflows/history.ts), projected
 * from the engine's journal, never guessed: what happened, in the order
 * it happened (`sequence`, the engine's event ID) and when (`at`, Unix
 * milliseconds). `taskId` is the step's name as the version's reviewed
 * outline has it, and null for the run's own entries and for a step
 * whose name the review doesn't show (it can be made of the App's data).
 * Metadata only: no input, output, parameter, reviewer or review. One
 * logical step's retries are one `stepId`, its attempts numbered from 1,
 * its runs again after a held side effect included; a replay adds
 * nothing.
 *
 * Read while a step is still deciding whether to try again, its failed
 * attempt reads as `retrying`; once the step has failed at it, the same
 * attempt reads as the step's `failed` instead. A restart forgets the
 * history of what it runs again.
 */
export type RunHistoryEntry = {
  id: string;
  sequence: number;
  taskId: string | null;
  at: number;
} & (
  | {
      kind: "lifecycle";
      status: Exclude<RunSummary["status"], "compensating">;
    }
  | {
      kind: "lifecycle";
      status: "compensating";
      cause: "failure" | "cancellation";
      activity: "running" | "waiting" | "paused";
    }
  | {
      kind: "step";
      /** The logical step, the same for each of its attempts. */
      stepId: string;
      state: "started" | "completed" | "retrying";
      attempt: number;
    }
  | {
      kind: "step";
      stepId: string;
      state: "failed";
      attempt: number;
      error: RunHistoryError;
    }
  | {
      kind: "wait";
      /** A decision's ID for a decision; the wait's own otherwise. */
      waitId: string;
      /**
       * `blocked`: a side effect of the step `stepId` is held until the
       * person the run acts for decides. `outcome_unknown`: a side effect
       * of it was sent and its answer lost, so nobody can tell whether it
       * took effect, until that person says (`UnknownOutcomesApi`).
       */
      waitKind: "timer" | "event" | "decision" | "blocked" | "outcome_unknown";
      state: "opened" | "closed";
      deadline: number | null;
    }
  | {
      kind: "compensation";
      stepId: string;
      state: "started" | "completed" | "retrying";
      attempt: number;
    }
  | {
      kind: "compensation";
      stepId: string;
      state: "failed";
      attempt: number;
      error: RunHistoryError;
    }
  | {
      /**
       * An event the engine couldn't read back: told by its place and time
       * alone, so the rest of the history still reads.
       */
      kind: "unreadable";
    }
);

/** Most entries one page of a run's history holds. */
export const runHistoryMaxPageSize = 100;

/** What `WorkflowsApi.history` reads: a page size, and where to go on from. */
export const runHistoryPageSchema = z
  .strictObject({
    pageSize: z.int().min(1).max(runHistoryMaxPageSize).default(50),
    /** The `nextCursor` of the page before; null for the first. */
    cursor: z
      .string()
      .regex(/^[1-9]\d{0,15}$/u)
      .nullable()
      .default(null),
  })
  .default({ pageSize: 50, cursor: null });

/** What `WorkflowsApi.history` reads. */
export type RunHistoryPageQuery = z.input<typeof runHistoryPageSchema>;

/**
 * One page of a run's history, oldest first; the last page has no cursor.
 * Empty once the run's details are removed.
 */
export type RunHistoryPage =
  | { items: RunHistoryEntry[]; nextCursor: null; hasMore: false }
  | { items: RunHistoryEntry[]; nextCursor: string; hasMore: true };

/**
 * The receipt of a pause, resume or cancel of a run the host admitted:
 * `admitted` until the engine confirms it, then `applied`; `superseded`
 * when a cancel overtook it first.
 */
export interface RunControl {
  id: string;
  kind: "pause" | "resume" | "cancel";
  state: "admitted" | "applied" | "superseded";
}

/**
 * What a `queued` run waits for: a share of the attempts that run at once
 * of its App (`app`), of the person it counts for (`person`) or of the
 * whole organization (`client`), and when it asks again at the latest
 * (ISO 8601). Throttling, not a fault of the workflow. It names the share
 * only: never who else holds it, nor their runs.
 */
export interface RunQueue {
  waitingFor: "client" | "person";
  retryAt: string;
}

/**
 * What a `queued` run waits for when a model call of it failed on the
 * organization's own AI provider key: the provider, what it showed, by
 * the HTTP class seen (it refuses the key, isn't answering, or is limiting
 * requests), and since when (ISO 8601). It goes on by itself once calls
 * work; an admin can replace a key.
 */
export interface RunAiProviderWait {
  since: string;
  provider: string;
  trouble: ProviderTrouble;
}

/** One run of a workflow. */
export interface WorkflowRun {
  id: RunId;
  app: AppId;
  workflow: WorkflowId;
  /** The App version it runs, whatever version is current now. */
  version: number;
  /** A person started it (and it acts for them), or a trigger did. */
  startedBy: { type: "person"; userId: string } | { type: "trigger" };
  status: RunStatus;
  /** While it is `queued`: the share it waits for, and when it asks again. */
  queued?: RunQueue;
  /** While it is `queued` for its AI provider: which, what it showed, and since when. */
  aiProvider?: RunAiProviderWait;
  createdAt: string;
  endedAt: string | null;
  /**
   * What it returned, once completed; only from `status`, and gone once
   * its details are removed.
   */
  output?: Json;
  /**
   * Why it failed; only from `status`, and gone once its details are
   * removed.
   */
  error?: { name: string; message: string };
  /**
   * Why it stopped, once failed: for admins and the person the run acts
   * for (who started it, or the App's owner for a triggered run). Once
   * its details are removed, its message says only that, and its step is
   * named without its key.
   */
  failure?: RunFailure;
  /**
   * Set once its details are removed, its retention over: an ended run
   * keeps them for 30 days, counted from when it ended. The same wherever
   * the run is read. The run itself stays: what it was, how it ended, when
   * and for whom.
   */
  detailsRemoved?: true;
}

/**
 * How a step works: `exact` is plain code, `ai` asks a model for output of a
 * fixed shape, `decision` waits for a person, `wait` waits for time or an
 * event.
 */
export type StepKind = "exact" | "ai" | "decision" | "wait";

/** The SDK's own step, which reads the run's parameters and calls nothing. */
export const paramsStep = "$params";

/**
 * How the host is asked to run a step, by the SDK only in these ways for
 * each kind (workflow.ts): `do` its function (an exact step, an AI step,
 * a decision's opening, and its parts `name#…`); `sleep` (a wait);
 * `waitForDecision` (a decision's `name#answer…`); and, inside a step's
 * attempt, `model` (an AI step), `decision` (opening one) and
 * `recipients` (who a decision asks, in its `#ask` or `#remind` part).
 */
export type StepUse =
  | "do"
  | "sleep"
  | "waitForDecision"
  | "model"
  | "decision"
  | "recipients";

/** Which runs `WorkflowsApi.runs` lists; each field narrows it. */
export interface RunFilter {
  app?: string;
  workflow?: string;
  status?: RunFilterStatus;
}

/**
 * The workflow a run, a summary or a count is of: an App's, by its App and
 * ID, or an independent one (platform specification 13), by its ID and
 * name. The run lists, the overview and the activity read both alike.
 */
export type RunWorkflowRef =
  | { type: "app"; app: AppId; appName: string; workflow: WorkflowId }
  | { type: "resource"; workflowId: WorkflowResourceId; name: string };

/**
 * A run of an App's workflow as the Runs list has it, with its App's
 * name. While it waits for a decision its `status` is `waiting`.
 */
export interface AppListedRun extends WorkflowRun {
  type: "app";
  appName: string;
  /**
   * An open decision it waits for that the person may answer now (the
   * latest such), answered on its own page (`/decisions/<id>`); none when
   * they may answer none of them.
   */
  decision?: string;
}

/**
 * A run of an independent workflow as the Runs list has it: what its
 * workflow's page lists of it, for the same people (every run for the
 * workflow's builders, their own for its users). What it returned or why
 * it failed stays on the run itself.
 */
export interface ResourceListedRun {
  type: "resource";
  id: RunId;
  workflowId: WorkflowResourceId;
  name: string;
  /** The workflow version it runs, whatever version is current now. */
  version: number;
  /** The person it acts for: who started it, or whom its start named. */
  startedBy: { type: "person"; userId: string };
  status: RunStatus;
  /** While it is `queued`: the share it waits for, and when it asks again. */
  queued?: RunQueue;
  /** While it is `queued` for an AI provider: which, and what's wrong. */
  aiProvider?: RunAiProviderWait;
  /**
   * An open decision it waits for that the person may answer now (the
   * latest such), answered on its own page (`/decisions/<id>`); none when
   * they may answer none of them.
   */
  decision?: string;
  createdAt: string;
  endedAt: string | null;
}

/** A run as the Runs list has it, of an App's workflow or an independent one. */
export type ListedRun = AppListedRun | ResourceListedRun;

/** Most runs one `runs` call returns. */
export const runsPageSize = 100;

/** A page of runs, and whether more matched than it holds. */
export interface RunsPage {
  runs: ListedRun[];
  more: boolean;
}

/** How many days back a workflow's failed runs are counted. */
export const failedRunDays = 7;

/**
 * How many days back the runs a workflow handled are counted: a week, so
 * its count reads as what it handles a week.
 */
export const handledRunDays = 7;

/** A workflow's latest run, as the Workflows page shows it. */
export interface LatestRun {
  id: RunId;
  status: RunStatus;
  /** While it is `queued`: the share it waits for. */
  queued?: RunQueue;
  /** While it is `queued` for its AI provider: which, what it showed, and since when. */
  aiProvider?: RunAiProviderWait;
  createdAt: string;
}

/** What the Workflows page shows of any workflow, an App's or independent. */
interface WorkflowRunCounts {
  /**
   * Who owns it: the person who answers for it. For an App's workflow, and
   * told when a run a trigger started fails, its App's owner unless
   * someone set another; for an independent one, who created it. Not whom
   * its runs act for: a run of an App no person started acts for the
   * App's owner.
   */
  owner: { userId: string; name: string | null };
  /**
   * Its latest run, of any version, `waiting` while it waits for a
   * decision; null before its first.
   */
  lastRun: LatestRun | null;
  /** Its runs waiting for a decision now. */
  waiting: number;
  /** Its runs that failed in the last {@link failedRunDays} days. */
  failed: number;
  /**
   * The items it handled a week: its runs, of any version, that completed
   * in the last {@link handledRunDays} days.
   */
  handled: number;
}

/** A workflow of an App's current version, as the Workflows page lists it. */
export interface AppWorkflowSummary extends WorkflowRunCounts {
  type: "app";
  app: AppId;
  appName: string;
  workflow: WorkflowId;
  /** The App's current version, which new runs run. */
  version: number;
  /**
   * Whether the person may change its owner (`setOwner`) and its team
   * (`setTeam`): an admin, or a builder of the App; never Grasp staff.
   */
  changesOwner: boolean;
  /** The organization's team that owns it (`setTeam`); null for none. */
  team: { id: string; name: string } | null;
  /**
   * A schedule of it stopped: its run failed to start
   * {@link maxFailedStarts} times in a row. It starts again once its
   * schedule parameter is set, or a new version is made current.
   */
  scheduleStopped: boolean;
}

/**
 * An independent workflow the person has a role in, as the Workflows page
 * lists it. Its counts are of the runs its page lists them: every run for
 * its builders, their own for its users.
 */
export interface ResourceWorkflowSummary extends WorkflowRunCounts {
  type: "resource";
  workflowId: WorkflowResourceId;
  name: string;
  /** The version published last, which new runs run; null before the first. */
  version: number | null;
}

/** A workflow as the Workflows page lists it. */
export type WorkflowSummary = AppWorkflowSummary | ResourceWorkflowSummary;

/** Most UTC days one `activity` read looks back over, today included. */
export const runActivityMaxDays = 90;

/** The UTC days an `activity` read looks back over when it names none. */
export const runActivityDefaultDays = 7;

/**
 * What `WorkflowsApi.activity` reads: `days` UTC days up to `to`, both
 * included, {@link runActivityDefaultDays} unless given. `to` is today
 * unless given, and never after it (`workflow.invalid`): a week that
 * closed is read as it was, not with the days after it.
 */
export const runActivityQuerySchema = z
  .strictObject({
    days: z
      .int()
      .min(1)
      .max(runActivityMaxDays)
      .default(runActivityDefaultDays),
    /** The window's last UTC day, `YYYY-MM-DD`. */
    to: z.iso.date().optional(),
  })
  .default({ days: runActivityDefaultDays });

/** What `WorkflowsApi.activity` reads. */
export type RunActivityQuery = z.input<typeof runActivityQuerySchema>;

/**
 * How runs started on one UTC day stand now: completed, failed, waiting
 * for a decision, or otherwise (running, paused or cancelled).
 */
export interface RunActivityDay {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  completed: number;
  failed: number;
  waiting: number;
  other: number;
  /** Of all of them, those that asked a person for a decision. */
  withPerson: number;
}

/** A workflow's runs started in the window, and how many of them ended how. */
export type RunActivityWorkflow = (
  | {
      type: "app";
      app: AppId;
      appName: string;
      workflow: WorkflowId;
      /**
       * It is a workflow of its App's current version, so its page opens; a
       * workflow a later version removed or renamed has runs here but no
       * page.
       */
      current: boolean;
    }
  | { type: "resource"; workflowId: WorkflowResourceId; name: string }
) & {
  started: number;
  completed: number;
  failed: number;
  /**
   * Of those completed, the runs that asked no one for a decision: items
   * it handled without a person.
   */
  completedAlone: number;
};

/**
 * The runs a person can list (`WorkflowsApi.runs`), started over the last
 * days, and the people they needed. Everything counts the runs started in the
 * window, by the UTC day they started, and stands as they are now.
 */
export interface RunActivity {
  /** The first day of the window, `YYYY-MM-DD` (UTC). */
  from: string;
  /** Its last day, today. */
  to: string;
  /** Each day of the window, oldest first, days without runs too. */
  days: RunActivityDay[];
  runs: {
    total: number;
    /** Runs that asked a person for a decision, at least once. */
    withPerson: number;
    /** Runs that asked no one. */
    withoutPerson: number;
  };
  /**
   * The decisions those runs asked for: answered, timed out, or open now
   * (one someone can still answer, of a run that hasn't ended).
   */
  decisions: {
    approved: number;
    rejected: number;
    timedOut: number;
    open: number;
  };
  /** Each workflow that ran, by App name, then workflow. */
  workflows: RunActivityWorkflow[];
}

/** A workflow that uses a connection, as Integrations names and links it. */
export interface ConnectionWorkflow {
  id: string;
  name: string;
}

/**
 * The workflows a person can open that use one connection: each whose
 * current version declares a connector binding an active approval serves
 * through the workflow's own active permission on it, by name.
 */
export interface ConnectionWorkflows {
  connectionId: string;
  workflows: ConnectionWorkflow[];
}

/**
 * Who a run waits on, as its open decision names them: a role, a team, or
 * the reader themselves (`you`). Only for a wait that is the reader's own.
 */
export type TodayWaitsOn =
  | { kind: "role"; role: string }
  | { kind: "team"; team: string }
  | { kind: "you" };

/** One run of a workflow on the company's day (`WorkflowsApi.today`). */
export interface TodayRun {
  id: string;
  /** When it started and ended (ISO 8601); `endedAt` null while it goes on. */
  startedAt: string;
  endedAt: string | null;
  status: WorkflowRunStatus;
  /**
   * Whether it went by itself (`alone`) or a person came in (`people`): it
   * asked someone for a decision, as the handled-versus-alone counts have
   * it.
   */
  went: "alone" | "people";
  /**
   * What it waits on now, if it waits on the reader: whom its decision
   * names, since when, and the decision to answer. A wait on anyone else
   * shows only as `waitsOnOthers`, with neither whom nor since when.
   */
  waits: {
    decision: string;
    on: TodayWaitsOn;
    since: string;
    asks: string;
  } | null;
  /** It waits on someone other than the reader. */
  waitsOnOthers: boolean;
  /**
   * The run it came from, by its lineage: an App run's root, an
   * independent run's parent; only a run of today the reader sees, null
   * otherwise.
   */
  from: string | null;
}

/** A workflow that worked today, with its runs of the day, oldest first. */
export type TodayLane = (
  | { kind: "app"; app: AppId; appName: string; workflow: WorkflowId }
  | { kind: "independent"; id: string; name: string }
) & { runs: TodayRun[] };

/**
 * The runs of the company's day across the workflows the reader may see,
 * a lane per workflow that worked: the day in the organization's time
 * zone, from its midnight to now. A run the reader may not see is counted
 * (`unseen`), never named, nor its workflow.
 */
export interface WorkflowsToday {
  /** The day's start, and now (ISO 8601). */
  from: string;
  now: string;
  timeZone: string;
  lanes: TodayLane[];
  /**
   * The day's oldest runs the reader may see that the lanes leave out, on
   * a day with more runs than one read takes; the newest are on the lanes.
   */
  cutOff: number;
  /** Runs of the day in workflows, or of people, the reader may not see. */
  unseen: number;
}

/**
 * A signed-in person's workflows. Anyone with a role in the App
 * (`AppsApi`) starts and follows its runs, and its builders cancel them;
 * every call checks the session and the person's role again.
 */
export interface WorkflowsApi {
  /**
   * Starts a run of an App's workflow on the App's current version, acting
   * for the person who starts it.
   */
  start: (
    app: string,
    workflow: string,
    input?: unknown
  ) => Promise<WorkflowRun>;
  /** A run as it is now. */
  status: (run: string) => Promise<WorkflowRun>;
  /**
   * A page of a run's history, oldest first, for anyone `status` shows the
   * run to: what its engine journaled, step by step and attempt by attempt.
   */
  history: (run: string, page?: RunHistoryPageQuery) => Promise<RunHistoryPage>;
  /**
   * An App's runs, newest first; a failed one with its report for those
   * `status` shows it to.
   */
  list: (app: string) => Promise<WorkflowRun[]>;
  /** Stops a run for good; a run that ended stays as it ended. */
  cancel: (run: string) => Promise<WorkflowRun>;
  /**
   * Every workflow of the current version of every App the person can
   * open, by App name and workflow, then every independent workflow they
   * have a role in, by name: each with its latest run and its waiting and
   * failed runs.
   */
  overview: () => Promise<WorkflowSummary[]>;
  /**
   * Every connection some workflow the person can open uses, with those
   * workflows (`ConnectionWorkflows`); a connection none of them uses
   * isn't listed.
   */
  byConnection: () => Promise<ConnectionWorkflows[]>;
  /**
   * Runs of the Apps the person can open, and of the independent workflows
   * they have a role in (every run for a builder, their own for a user),
   * as `filter` narrows them (an App or its workflow: that App's runs
   * alone):
   * waiting first (latest to wait first), then failed (latest ended
   * first), then the rest, newest first; at most {@link runsPageSize},
   * with `more` when more matched.
   */
  runs: (filter?: RunFilter) => Promise<RunsPage>;
  /**
   * The runs `runs` lists started over the last days
   * (`runActivityQuerySchema`), by day and how they stand, and the
   * decisions they asked people for.
   */
  activity: (query?: RunActivityQuery) => Promise<RunActivity>;
  /**
   * The runs of the company's day across the workflows the person may
   * see, App and independent alike, a lane per workflow that worked; runs
   * they may not see only counted.
   */
  today: () => Promise<WorkflowsToday>;
  /**
   * Makes `owner`, a member of the organization who can open the App,
   * the owner of an App's workflow; for admins and the App's builders,
   * audited. Returns the workflow's summary as it is now.
   */
  setOwner: (
    app: string,
    workflow: string,
    owner: string
  ) => Promise<AppWorkflowSummary>;
  /**
   * Makes one of the organization's teams (by ID) the team that owns an
   * App's workflow, or none with `null`; for admins and the App's
   * builders, audited. Returns the workflow's summary as it is now.
   */
  setTeam: (
    app: string,
    workflow: string,
    team: string | null
  ) => Promise<AppWorkflowSummary>;
  /**
   * The organization's teams, by name, that a workflow's team may be set
   * to (`setTeam`); for admins and builders, never Grasp staff.
   */
  teams: () => Promise<{ id: string; name: string }[]>;
}
