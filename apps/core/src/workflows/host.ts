import { runActorOf } from "@grasp-os/shared/audit";
import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { connectErrors } from "@grasp-os/shared/connect";
import { decidersSchema } from "@grasp-os/shared/decisions";
import { sha256Hex, toHex } from "@grasp-os/shared/encoding";
import { errorPayloadSchema, isExpectedError } from "@grasp-os/shared/errors";
import type { ErrorPayload } from "@grasp-os/shared/errors";
import { identifierSchema } from "@grasp-os/shared/ids";
import type { AppId, RunId, WorkflowId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";
import { resourceAliasPattern } from "@grasp-os/shared/operation-limits";
import type { OperationResult } from "@grasp-os/shared/operations";
import type { Authority } from "@grasp-os/shared/permissions";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import {
  callReviewed,
  coreStepPrefix,
  executionErrors,
  stepReviewed,
  isRetryable,
  paramsStep,
  maxAttemptTimeoutMs,
  maxStepRetries,
  stepIdempotencyKey,
  inboundEmailIndexSchema,
  storedEmailSchema,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import type { InputShape, WorkflowCalls } from "@grasp-os/shared/workflows";
import type {
  WorkflowDuration,
  WorkflowStepConfig,
} from "@grasp-os/workerflow/contracts";
import { namedError } from "@grasp-os/workerflow/errors";
import type { AttemptLease } from "@grasp-os/workerflow/run";
import { RpcTarget } from "cloudflare:workers";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Email } from "postal-mime";
import { z } from "zod";

import { callExport } from "../app-calls.ts";
import type { RunCaller } from "../app-functions.ts";
import type { AppAnswer, AppCallerInput } from "../app.ts";
import { auditedBatch, outboxed, outboxedWhere } from "../audit-outbox.ts";
import { forSandbox, requireStepKey, runStubCall } from "../bindings.ts";
import type { ConnectionGrant, ExportGrant } from "../bindings.ts";
import { workflowRuns } from "../db/core/schema.ts";
import {
  decisionDeadline,
  decisionEventType,
  decisionOutcome,
  decisionRecipients,
  openDecision,
} from "../decisions/decisions.ts";
import type {
  DecisionOutcome,
  DecisionRecipient,
} from "../decisions/decisions.ts";
import type { CollectionBinding } from "../knowledge/binding.ts";
import { models } from "../models.ts";
import { requireActivePerson, requireApprovedVersion } from "../permissions.ts";
import type { StepModel } from "../resource-bindings.ts";
import { tokensOfBound } from "../resource-model.ts";
import { commitStepStatistics } from "../statistic-steps.ts";
import { askAgainMs } from "./admission.ts";
import type { Share } from "./admission.ts";
import type { AttemptFence } from "./attempt-fence.ts";
import { AttemptHost } from "./attempt-host.ts";
import type { Settled, StepError } from "./code.ts";
import { attachmentOf, keptMessage } from "./kept-email.ts";
import { modelWaitRecorded } from "./model-waits.ts";
import { quotaPolicy } from "./quotas.ts";
import type { AttemptAdmission, QuotaAttempt } from "./quotas.ts";
import { heldWakeType } from "./wakes.ts";

// The engine a run's workflow code runs on, as core's side of it: the SDK's
// `WorkflowEngine` (`@grasp-os/sdk/engine`) on the engine's `step` API
// (Workerflow, engine.ts). The
// run's main module (code.ts) sends each engine call here over RPC. The
// isolate is untrusted, so everything it sends is checked, and what it can
// do is only this run's: steps, waits and model calls, all as this
// run and this workflow, for the person it acts for while they are there.
//
// Errors cross as plain data both ways (`Settled`). The engine keeps only
// a failed step's name, message and a well-formed code, and RPC carries
// errors' fields as the runtime sees fit; the SDK recovers its error codes from the
// name, so the name must come back as it was sent. Core's own errors reach
// the isolate as the sandbox sees them: expected ones as they are, anything
// else as `internal.unexpected`.

/**
 * What a run may call of a collection it may read (`CollectionBinding`):
 * the isolate's stub of each has these methods, each a call through the
 * host (`callCollection`).
 */
export const collectionMethods = [
  "listDocuments",
  "getDocument",
  "history",
  "backlinks",
  "search",
  "read",
  "follow",
] as const satisfies readonly (keyof CollectionBinding)[];

const collectionMethodSchema = z.enum(collectionMethods);

/** The run a host serves, as the dispatcher loaded it. */
export interface HostedRun {
  app: AppId;
  workflow: WorkflowId;
  version: number;
  runId: RunId;
  /**
   * The root of its lineage, for a run another run started: from its
   * row, read on every load, so a restart or replay keeps it. None for a
   * run that is its own root.
   */
  rootRunId?: RunId;
  /** Who the run acts for in this execution. */
  authority: Authority;
  /**
   * Whose person share its workflow attempts and model requests take, from
   * its row (dispatcher.ts, `admissionSubjectOf`): who started it, its
   * lineage root's, or its App's triggers' (`trigger:<app>`). Not who it
   * acts for, which is the App's owner for a run nobody started.
   */
  shareSubject: string;
  /** Its collections' stubs, by binding name (`runBindingsFor`). */
  collections: Record<string, Fetcher<CollectionBinding>>;
  /** Its connection permissions, by binding name (`runBindingsFor`). */
  connections: Record<string, ConnectionGrant>;
  /** Its permissions on other Apps' exports, by binding name. */
  apps: Record<string, ExportGrant>;
  /**
   * The bindings its workflow calls, by step, as the review of its version
   * shows them (`app_versions.workflow_calls`).
   */
  calls: WorkflowCalls;
}

/**
 * The engine's `step`, as far as core uses it. Values are `unknown` here,
 * and checked as JSON where they are used.
 */
export interface RunStep {
  do: (
    name: string,
    config: WorkflowStepConfig,
    fn: (context?: unknown) => Promise<unknown>
  ) => Promise<unknown>;
  sleep: (name: string, duration: number) => Promise<void>;
  waitForEvent: (
    name: string,
    options: { type: string; timeout: WorkflowDuration }
  ) => Promise<{ payload: unknown }>;
}

/**
 * One attempt of a step, from when the engine claims it: who it is (its
 * number, its step's key in the engine, the generation of the activation
 * that claimed it, its deadline and a lease ID of core's own), whether
 * connect held a side effect of it (`held`), whether it called its App's
 * methods, and the kept messages it read attachments of, parsed, by their
 * name (`readAttachment`): each parsed once per attempt. Its code reaches
 * core only through the host minted for it (`AttemptHost`), whose every
 * call acts as this attempt, and only while it holds (`RunHost.#holds`).
 */
interface StepAttempt {
  /**
   * Its lease ID, drawn here and never sent to the isolate: the statistics
   * points the App calls of the attempt's code record are kept by it, and
   * added up only if this attempt completes the step.
   */
  leaseId: string;
  /** Its number, from 1, as the engine counts the step's attempts. */
  number: number;
  /** Its step's place among the run's steps (`countedStep`), if counted. */
  ordinal?: number;
  /** Its step's idempotency key in the engine, which names its lease. */
  key: string;
  /** The generation of the activation that claimed it. */
  generation: number;
  /**
   * When the engine gives up on it, by the step's timeout: an App call it
   * makes waits for the App no longer (`callApp`), and none of its calls
   * acts after it.
   */
  deadline: number;
  /** Whether its function has returned: its host acts no more. */
  over: boolean;
  /** Whether a call of it was refused as stale, and audited so, already. */
  staleAudited?: boolean;
  step: string;
  held: boolean;
  /**
   * Whether it was held because a call of it under the step's key came
   * back of unknown outcome, for its person to resolve (`heldNoted`): its
   * wait sleeps before its first check and ends by a deadline.
   */
  unknown: boolean;
  /**
   * The keys of the side effects its App's functions asked for through
   * their resource bindings that connect held (`BindingCaller.held`): the
   * step waits while any of them, or one under its own key, does. At most
   * `heldKeysKept`.
   */
  heldKeys: string[];
  /**
   * How many of its App's functions its code has called so far: each
   * call's place, which its key is derived from (`#callFunction`).
   */
  functionCalls: number;
  calledApp: boolean;
  /**
   * The first of its calls refused as one its review doesn't show, or
   * made from another attempt's code that had one refused: the attempt
   * fails with it, whatever its code made of the refusal.
   */
  refused?: Error;
  /** Whether a call of it was refused past its lineage's host calls, and audited so. */
  hostCallsAudited?: boolean;
  keptMessages?: Map<string, Email>;
  /** Whether the step has no retry left after it, as far as core can tell. */
  last: boolean;
}

/**
 * Why a run waits before running a step again: a side effect held for its
 * person (`held`); a side effect of unknown outcome, until its person says
 * what became of it (`outcome_unknown`, listed for them with their held
 * actions); or its step queued for a share of the client's attempts
 * running at once (admission.ts), with the share and the seconds until it
 * asks again at the latest.
 */
export type WaitReason =
  | { reason: "held" }
  | { reason: "outcome_unknown" }
  | { reason: "queued"; waitingFor: Share; retryAfterSeconds: number };

/** The code a held side effect answers a run's call with (connect). */
const heldCode = "connect.held";

/** The code a side effect of unknown outcome answers a run's call with. */
const unknownCode = "connect.outcome_unknown";

/** The field of a held marker (`heldMarkerOf`). */
const heldField = `${coreStepPrefix}held`;

/** The field of a held marker that says it waits on an unknown outcome. */
const unknownField = `${coreStepPrefix}unknown`;

/**
 * What an attempt of a step answers when a side effect of it was held:
 * recorded as the step's result, so every execution replays it and waits
 * again, with the keys of the held side effects its App's functions asked
 * for (`StepAttempt.heldKeys`), which a wait after a restart still checks.
 * Workflow code can't return it (`do` refuses it).
 */
const heldMarkerOf = (keys: readonly string[], unknown: boolean) => ({
  [heldField]: [...keys].toSorted(),
  ...(unknown ? { [unknownField]: true } : {}),
});

const isHeldMarker = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  Object.hasOwn(value, heldField);

/**
 * The most held keys of one attempt a held marker keeps. Past it, the
 * step waits for those it kept; run again, it is held again by any still
 * waiting, and waits for those: never runs on while one waits.
 */
const heldKeysKept = 32;

/** The field of a step's result that says its lineage was busy (`busyMarker`). */
const busyField = `${coreStepPrefix}busy`;

/** The field of a busy step's result that says it was queued, for which share. */
const queuedField = `${coreStepPrefix}queued`;

/** The field of a busy step's result that says how long a step may wait. */
const busyMaxField = `${coreStepPrefix}busyMaxMs`;

/** The field of a busy step's result that says it joined the queue then. */
const joinedField = `${coreStepPrefix}joined`;

/**
 * What an attempt of a step answers when its run lineage's active time is
 * all held by attempts under way (quotas.ts, `workflow.lineage_busy`), or
 * the client's shares of attempts running at once are full for it
 * (admission.ts, `workflow.queued`): recorded as the step's result, with
 * the seconds to wait, so the run waits durably, holding no compute, and
 * runs the step again under a step of its own, as a held step does. The
 * refusal spends none of the step's attempts, and its wait none of the
 * run's steps (`uncountedWaitStep`): the load is others' as much as the
 * run's. Its rounds wait a day in all at most (`workflowQueuedStepMs`,
 * `LoadWait`), then fail (`workflow.queue_timeout`). Workflow code can't
 * return it (`do` refuses it).
 */
const busyMarker = ({ busyFor, queuedFor, maxWaitMs, joined }: Busy) => ({
  [busyField]: busyFor,
  [busyMaxField]: maxWaitMs,
  ...(queuedFor === undefined ? {} : { [queuedField]: queuedFor }),
  ...(joined === true ? { [joinedField]: true } : {}),
});

/**
 * An attempt refused for now: the seconds to wait, the share it was
 * queued for, when it was (`workflow.queued`), not its lineage busy, and
 * how long a step may wait in all, as the quota policy said then.
 */
interface Busy {
  busyFor: number;
  queuedFor?: Share;
  maxWaitMs: number;
  /** Whether the refusal took it a place in the queue (admission.ts). */
  joined?: boolean;
}

const shareSchema = z.enum(["client", "person", "app"]);

/** Whether `value` is one of core's markers, which workflow code can't return. */
const isCoreMarker = (value: unknown): boolean =>
  isHeldMarker(value) ||
  (typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, busyField));

const busyRecordSchema = z.object({
  busyFor: z.number(),
  maxWaitMs: z.number(),
  queuedFor: shareSchema.optional(),
  joined: z.boolean(),
});

/**
 * One of core's markers, as a step's recorded result says it: a step held
 * for its person (`heldMarkerOf`), on an unknown outcome or not, with the
 * keys it waits on; or refused for load (`busyMarker`), with the seconds
 * to wait, when it was refused, how long a step may wait in all, and the
 * share it was queued for and whether it joined the queue then.
 */
type CoreMarker =
  | { kind: "held"; keys: string[]; unknown: boolean }
  | ({ kind: "busy" } & z.infer<typeof busyRecordSchema>);

/**
 * The marker `value` is, as recorded; none when it is a step's own result.
 * A marker core recorded always reads: one that doesn't is refused.
 */
const markerOf = (value: unknown): CoreMarker | undefined => {
  if (!isCoreMarker(value) || typeof value !== "object" || value === null) {
    return undefined;
  }
  const field = (name: string): unknown => Reflect.get(value, name);
  if (isHeldMarker(value)) {
    const keys = field(heldField);
    return {
      kind: "held",
      keys: Array.isArray(keys)
        ? keys.filter((key): key is string => typeof key === "string")
        : [],
      unknown: field(unknownField) === true,
    };
  }
  return {
    kind: "busy",
    ...busyRecordSchema.parse({
      busyFor: field(busyField),
      maxWaitMs: field(busyMaxField),
      queuedFor: field(queuedField),
      joined: field(joinedField) === true,
    }),
  };
};

/** A test's host of its own admits every attempt, with nothing to settle. */
const unadmitted: AttemptAdmission = {
  attemptsAllowed: platformLimits.workflowAttemptsPerStep,
  hostCall: async () => {
    // Nothing is counted.
  },
  settle: async () => {
    // Nothing was held.
  },
};

/**
 * What a `workflow.lineage_busy` or `workflow.queued` refusal says: the
 * seconds to wait, at least one, and the share a queued one waits for.
 */
const busyOf = (error: unknown): Busy | undefined => {
  if (
    !isExpectedError(error) ||
    (error.code !== "workflow.lineage_busy" && error.code !== "workflow.queued")
  ) {
    return undefined;
  }
  const seconds = error.details?.retryAfterSeconds;
  const busyFor = typeof seconds === "number" && seconds >= 1 ? seconds : 1;
  const most = error.details?.maxWaitMs;
  const maxWaitMs =
    typeof most === "number" ? most : platformLimits.workflowQueuedStepMs;
  if (error.code === "workflow.lineage_busy") {
    return { busyFor, maxWaitMs };
  }
  return {
    busyFor,
    maxWaitMs,
    queuedFor:
      shareSchema.safeParse(error.details?.waitingFor).data ?? "client",
    joined: error.details?.joined === true,
  };
};

/** What a step waited for load before an attempt (`#admit`). */
interface WaitedSoFar {
  /** The rounds it waited in a row. */
  waited: number;
  /**
   * How long its rounds waited since it was last admitted: none if it
   * wasn't refused for load since (`LoadWait`).
   */
  waitedMs: number | undefined;
  /** How long a step may wait in all, in ms. */
  maxWaitMs: number;
}

/**
 * A step's wait for load since its last admission: the rounds it was
 * refused for load in a row, what they wait in all (their sleeps, this
 * round's included, never the time between them), how long a step may
 * wait in all as the last refusal said, and how long this round sleeps.
 * A pause, a restart or a wait for its person between rounds counts for
 * none of it. A held marker means an attempt was admitted: the wait
 * starts over (`loadWaitAfter`).
 *
 * Only an admission that ended in a hold is journaled as one. An attempt
 * admitted that then fails, whose retry by the engine in the same round is
 * refused for load, keeps counting from before its admission. That errs
 * safe: such a step times out sooner, never later.
 */
interface LoadWait {
  rounds: number;
  waitedMs: number;
  maxWaitMs: number;
  sleepMs: number;
}

/** No wait for load yet. */
const loadWaitStart: LoadWait = {
  rounds: 0,
  waitedMs: 0,
  maxWaitMs: 0,
  sleepMs: 0,
};

/**
 * The step's wait for load once its attempt answered `marker`: after a
 * hold, none (an attempt was admitted); after a refusal for load, one
 * round more, sleeping as long as `askAgainMs` says, added to what its
 * rounds wait in all. A round left nothing to sleep (`sleepMs` 0) has
 * waited as long as a step may.
 */
const loadWaitAfter = (wait: LoadWait, marker: CoreMarker): LoadWait => {
  if (marker.kind === "held") {
    return loadWaitStart;
  }
  const sleepMs = askAgainMs({
    waited: wait.rounds,
    retryAfterSeconds: marker.busyFor,
    waitedMs: wait.waitedMs,
    maxWaitMs: marker.maxWaitMs,
  });
  return {
    rounds: wait.rounds + 1,
    waitedMs: wait.waitedMs + sleepMs,
    maxWaitMs: marker.maxWaitMs,
    sleepMs,
  };
};

/** A round of a step's wait (`#waitBefore`). */
interface WaitRound {
  round: number;
  /** How long a busy step sleeps this round (admission.ts, `askAgainMs`). */
  sleepMs: number;
}

/**
 * The failure of step `step`, which waited for load as long as a step may
 * (`maxWaitMs`, the quota policy's `workflowQueuedStepMs`): no retry of
 * its own is spent, and none tried.
 */
const queueTimedOut = (step: string, maxWaitMs: number): StepError => ({
  name: "Error",
  code: "workflow.queue_timeout",
  message: `Step "${step}" waited its turn to run for ${String(Math.round(maxWaitMs / 1000))} seconds, as long as a step may wait`,
});

/** Longest step name taken: a key and a decision's part fit well within. */
const maxStepName = 256;

/** Control characters, which the engine refuses in a step's name. */
const controlCharacter = /\p{Cc}/u;

const stepNameSchema = z
  .string()
  .min(1)
  .max(maxStepName)
  .refine((name) => !name.startsWith(coreStepPrefix), {
    message: `Step names starting with "${coreStepPrefix}" are core's`,
  })
  .refine((name) => !controlCharacter.test(name), {
    message: "Step names can't hold control characters",
  });

/**
 * The most a step may return, as JSON in UTF-8: a step's result limit
 * (spec 18.1), which is also what the engine records at most, failing the
 * whole run past it.
 */
const maxStepResultBytes = platformLimits.stepPayloadBytes;

const milliseconds = z
  .int()
  .positive()
  .max(365 * 86_400_000);

// What a step may declare: no more retries, and no longer an attempt,
// than the platform allows (spec 18.1). The SDK refuses wider ones where
// the step is written; code that gets past it is refused here, never
// held to less without saying so.
const doOptionsSchema = z.object({
  retries: z
    .object({
      limit: z.int().min(0).max(maxStepRetries),
      delay: milliseconds.optional(),
      backoff: z.enum(["constant", "linear", "exponential"]).optional(),
    })
    .optional(),
  timeout: z.int().positive().max(maxAttemptTimeoutMs).optional(),
  sideEffect: z.boolean().optional(),
  input: z.json().optional(),
});

/**
 * The largest output schema a model call takes, as JSON text. Its regular
 * expressions (Zod writes them for `z.email()`, `z.iso.date()` and the
 * like) run on the model's answer; one that backtracks badly is bounded by
 * the Worker's CPU limit, like any other expensive request.
 */
const maxSchemaLength = 32 * 1024;

/** What the host takes from the gateway's answer to an AI step. */
const modelAnswerSchema = z.object({ output: z.unknown() });

const modelRequestSchema = z.object({
  step: stepNameSchema,
  binding: z.string().regex(resourceAliasPattern),
  instructions: z.string(),
  input: z.json(),
  outputSchema: z
    .record(z.string(), z.unknown())
    .refine((schema) => JSON.stringify(schema).length <= maxSchemaLength),
});

const decisionSchema = z.object({
  step: stepNameSchema,
  from: decidersSchema,
  description: z.string().min(1),
  timeout: milliseconds,
});

/** What a decision wait recorded when it was first reached. */
const reachedSchema = z.object({ at: z.number(), answered: z.boolean() });

/** How a decision wait ended, as recorded (`DecisionOutcome`). */
const outcomeSchema = z.discriminatedUnion("answered", [
  z.object({
    answered: z.literal(true),
    approved: z.boolean(),
    by: z.string(),
    payload: z.json().nullable(),
  }),
  z.object({ answered: z.literal(false) }),
]);

const decisionWaitSchema = z.object({
  decision: identifierSchema,
  timeout: z
    .int()
    .min(0)
    .max(365 * 86_400_000),
  last: z.boolean(),
});

/**
 * An error code the audit log may name: shaped like the platform's
 * (`permission.denied`), and short. Workflow code can put anything in an
 * error's `code`, and the log keeps no free text.
 */
const codePattern = /^[a-z][a-z_]*(?:\.[a-z][a-z_]*)+$/u;
const maxCodeLength = 64;
export const auditableCode = (code: unknown): string | undefined =>
  typeof code === "string" &&
  code.length <= maxCodeLength &&
  codePattern.test(code)
    ? code
    : undefined;

/** The most of an isolate's error that is kept. */
const maxErrorName = 100;
const maxErrorMessage = 2000;

/** An error the isolate sent, cut to size, with only a well-formed code. */
const isolateErrorSchema = z
  .object({
    name: z.string(),
    message: z.string(),
    code: z.unknown().optional(),
  })
  .transform(({ name, message, code }): StepError => {
    const kept = auditableCode(code);
    return {
      name: name.slice(0, maxErrorName),
      message: message.slice(0, maxErrorMessage),
      ...(kept === undefined ? {} : { code: kept }),
    };
  });

/** How a step's function ended, as the isolate reports it. */
const settledSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: isolateErrorSchema }),
]);

/**
 * What the isolate sent, as `schema` has it; `workflow.invalid` when it
 * doesn't fit (a step name of core's, say).
 */
const checked = <Schema extends z.ZodType>(
  schema: Schema,
  value: unknown
): z.output<Schema> => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw workflowErrors.create("workflow.invalid");
  }
  return parsed.data;
};

/**
 * How a call into the isolate ended, as it reports it; a report that isn't
 * one is a failure.
 */
export const fromIsolate = (value: unknown): Settled<unknown> => {
  const parsed = settledSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : {
        ok: false,
        error: {
          name: "Error",
          message: workflowErrors.create("workflow.invalid").message,
          code: "workflow.invalid",
        },
      };
};

/** The delay before a step's first retry when the SDK names none. */
const defaultRetryDelayMs = 10_000;

/**
 * A step's retries when the SDK names none: the platform's, never the
 * engine's own default (5, one attempt more than a step may have, which
 * its admission would refuse after minutes of backoff, failing the step
 * with that refusal instead of its own error).
 */
const defaultRetryLimit = maxStepRetries;

/**
 * The step config the engine takes: what the SDK gave, its defaults
 * where it gave none, as the engine journals it.
 *
 * An attempt always runs under a timeout of the platform's, a minute when
 * the step declares none (spec 18.1's active wall time): the engine's own
 * default is ten minutes, and the engine ends an attempt at its timeout,
 * whatever its code still does. The engine journals a step's config, and
 * a replay must give it the same, so any change to what this returns for
 * a step (a clamp, another default, another `defaultRetryDelayMs`) halts
 * the runs in flight that journaled the old one on replay.
 *
 * Its retries are always given too: what the step declared, at most
 * `maxStepRetries` (`doOptionsSchema`), or `defaultRetryLimit`. The
 * ceiling on its attempts (spec 18.1's five, all counted, or the
 * operator's lower one) is enforced as each attempt is admitted
 * (quotas.ts, `admitAttempt`), which refuses an attempt past it, and
 * `isLastAttempt` takes it into account. A step whose side effect is held
 * runs again in steps of core's own (`#waitBefore`), each with these
 * retries afresh: the ceiling is per round, and every round is still held
 * to its lineage's active time.
 */
const stepConfig = ({
  retries,
  timeout,
}: z.output<typeof doOptionsSchema>): WorkflowStepConfig => ({
  retries: {
    limit: retries?.limit ?? defaultRetryLimit,
    delay: retries?.delay ?? defaultRetryDelayMs,
    backoff: retries?.backoff ?? "exponential",
  },
  timeout: timeout ?? maxAttemptTimeoutMs,
});

/**
 * How a wait or an attempt that ran out of time ends in the engine: a
 * `WorkflowTimeoutError` ("Execution timed out after 500ms"), recognised
 * by its message too, which survives every way to core.
 */
const timedOut = /^(?:WorkflowTimeoutError: )?Execution timed out\b/u;
const isTimeout = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === "WorkflowTimeoutError" || timedOut.test(error.message));

/**
 * The steps a run waits in while a side effect is held. They are core's
 * (workflow code can't name one), but count as the run's own against the
 * reserve, so waiting can't use up the steps core's end needs.
 */
export const waitStepPrefix = `${coreStepPrefix}wait:`;

/**
 * How long a run first waits before it checks a held side effect again;
 * each wait after doubles, up to {@link maxWaits} times this.
 */
const defaultWaitMs = 60_000;

/** The longest wait between checks, in first waits: 15 minutes. */
const maxWaits = 15;

/**
 * The longest wait between checks of a call of unknown outcome, in first
 * waits: an hour, so its 7 days take some 180 checks, a bounded journal.
 */
const maxUnknownWaits = 60;

/** What a round of a step's wait waits for (`#waitBefore`). */
type WaitKind = "busy" | "held" | "unknown";

/**
 * The prefix of the steps of round `round` of the wait of the step keyed
 * `key` (`waitKeyOf`) for `kind`: the one builder of a wait's step names,
 * which `uncountedWaitStep` reads back.
 */
const waitStep = (key: string, kind: WaitKind, round: number): string =>
  `${waitStepPrefix}${key}:${kind}:${round}`;

/**
 * The steps of a wait (`waitStep`) that are not the run's own:
 *
 * - a wait for load (`busy`): its sleep, its record of waiting and the
 *   step's run again. Others' load causes it, so it counts against no
 *   allowance, or a run queued long enough behind other Apps' work would
 *   fail for it; `workflowQueuedStepMs` bounds how long it waits
 *   (quotas.ts, admission.ts);
 * - a held wait's record of waiting (`held:<round>:waiting:`);
 * - a hold on an unknown outcome (`unknown`): its checks, sleeps and the
 *   step's run again, bounded by its deadline (`unknownHoldMsOf`) and the
 *   run lineage's age, not by the steps the run's code takes, as a run
 *   waits on its person;
 * - a decision's wait again, and its look, after a wake that answered
 *   nothing (`again:<round>`, `woken:<round>`, `waitForDecision`): an
 *   event of its type sent by someone else causes them, not the run's
 *   code, bounded by the engine's inbox (`maxInboxEvents`).
 */
const uncountedWaitStep =
  /^\$grasp:wait:[0-9a-f]{16}:(?:busy:\d+(?::|$)|held:\d+:waiting:|unknown:[1-9]\d*:|again:[1-9]\d*$|woken:\d+$)/u;

/**
 * Tries of one check whether a held side effect still waits, after the
 * first: a connect that fails that often in a row fails the step.
 */
const heldCheckRetries = 5;

/**
 * A short, stable key for the step `name` a wait holds, as the wait's own
 * step names take it: a step's name can be as long as a step name may be.
 */
export const waitKeyOf = async (name: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(name))
  );
  return toHex(new Uint8Array(digest)).slice(0, 16);
};

/** The first wait between checks for this deployment; tests shorten it. */
const waitMsOf = (env: Env): number => {
  const set = Number(env.WORKFLOW_OFF_WAIT_MS);
  return Number.isInteger(set) && set > 0 && set < defaultWaitMs
    ? set
    : defaultWaitMs;
};

/**
 * How long a step waits, from when it was first held on an unknown outcome,
 * for its person to resolve it: 7 days, then it fails with
 * `connect.outcome_unknown_unresolved`. Tests shorten it.
 */
const unknownHoldMs = 7 * 24 * 60 * 60 * 1000;

const unknownHoldMsOf = (env: Env): number => {
  const set = Number(env.WORKFLOW_UNKNOWN_HOLD_MS);
  return Number.isInteger(set) && set > 0 && set < unknownHoldMs
    ? set
    : unknownHoldMs;
};

/**
 * The least an AI step waits after the model budget turned it away while
 * other calls under way hold it (`model.budget_busy`), before its attempt
 * fails and the engine retries it at the step's own delay: so a step with
 * a tight retry config can't loop on the ledger. The refusal's
 * `retryAfterSeconds` is advisory, and steps don't wait it out: their
 * retries are theirs to set.
 */
const budgetBusyWaitMs = 15_000;

/** What core reads of the context the engine gives a step's attempt. */
const attemptContextSchema = z.object({
  attempt: z.int().positive(),
  idempotencyKey: z.string().min(1),
  /** Its step's place among the run's steps, as `countedStep` counts them. */
  stepOrdinal: z.int().positive().optional(),
  config: z
    .object({
      retries: z.object({ limit: z.int().min(0) }).optional(),
    })
    .optional(),
});

/**
 * Whether an attempt has no retry after it: its number as the engine's
 * `context` says, else `tries`, the attempts this execution made (fewer,
 * if an earlier execution made some: never the last too soon), against
 * its retries as the engine says, else `configured`, else the default.
 * The attempts the quota policy admits are its admission's to say
 * (`RunHost.#admit`).
 */
const isLastAttempt = (
  context: unknown,
  tries: number,
  configured: number | undefined
): boolean => {
  const told = attemptContextSchema.safeParse(context).data;
  const retries =
    told?.config?.retries?.limit ?? configured ?? defaultRetryLimit;
  return (told?.attempt ?? tries) > retries;
};

/**
 * Whether an App call failed only because the attempt it came from ran out
 * of time (`StepAttempt.deadline`): it timed out, or gave up
 * waiting for its turn, once that time had come. The engine gives up on the
 * attempt at that same moment, by a timer of its own, and whichever lands
 * first must not decide the step's fate: the attempt timed out either way.
 */
const cutOffByAttempt = (attempt: StepAttempt, error: unknown): boolean =>
  Date.now() >= attempt.deadline &&
  isExpectedError(error) &&
  (error.code === "app.timed_out" || error.code === "app.busy");

/**
 * The attempt's own timeout, as the engine ends an attempt that ran out of
 * time (`isTimeout`): a step tried again as far as its retries allow,
 * rather than one that stops the run.
 */
const attemptTimedOut = (): Error => {
  const error = new Error("Execution timed out: the step's attempt ran out");
  error.name = "WorkflowTimeoutError";
  return error;
};

/** Waits `ms`, or until `attempt`'s timeout ends, if that comes first. */
const waitWithin = async (attempt: StepAttempt, ms: number): Promise<void> => {
  const timeLeft = attempt.deadline - Date.now();
  await scheduler.wait(Math.max(0, Math.min(ms, timeLeft)));
};

/**
 * The refusal `known` again, for an attempt answered without asking the
 * gateway: its suggested wait less the time gone by since, at least a
 * second.
 */
const busyAgain = (known: BusyBudget) => {
  const wait = known.details?.retryAfterSeconds;
  const gone = Math.floor((Date.now() - known.at) / 1000);
  return modelErrors.create(
    "model.budget_busy",
    typeof wait === "number"
      ? { ...known.details, retryAfterSeconds: Math.max(1, wait - gone) }
      : known.details
  );
};

/** The last refusal of a step's AI call for a budget held by calls under way. */
export interface BusyBudget {
  at: number;
  details: ErrorPayload["details"];
}

/**
 * Where a run keeps each step's last busy-budget refusal, by step name:
 * durably, with the run (run-object.ts), as each retry of a step may run
 * in an activation of its own. A `Map` will do where nothing outlives one
 * host.
 */
export interface BusyRefusals {
  get: (step: string) => BusyBudget | undefined;
  set: (step: string, refusal: BusyBudget) => unknown;
}

/**
 * A run's AI calls, by step name, kept in memory by the run's object
 * across its activations, as a step's next attempt may run in another
 * activation while an earlier attempt's call is still out:
 * - `asking`: the call in flight, which a later attempt of the step waits
 *   for rather than ask the gateway beside it;
 * - `unclaimed`: an answer that landed after the attempt that asked for
 *   it was given up on (it timed out while the gateway answered), which
 *   the step's next attempt asking the same takes instead of asking, and
 *   paying, again.
 *
 * This is how an AI step whose model takes longer than an attempt's
 * minute is served, rather than by an exception to that minute. Only the
 * one provider request already sent runs on past the attempt that asked
 * for it, as long as the gateway lets a call run (`models.ts`, its
 * timeout); no other is sent for it, as `beforeSend` refuses the
 * gateway's retries once the attempt no longer holds. The step's next
 * attempts wait for that answer, each within its own minute. The handoff
 * lives in the run's object's memory only: an object evicted meanwhile
 * loses it, and the next attempt asks, and pays, again. A step that runs
 * out of attempts first fails as timed out; one whose model is that slow
 * is split into smaller calls.
 */
export interface AiCalls {
  asking: Map<string, Promise<unknown>>;
  unclaimed: Map<string, { request: string; answer: unknown }>;
}

/** An empty `AiCalls`, for a run's object to keep. */
export const newAiCalls = (): AiCalls => ({
  asking: new Map(),
  unclaimed: new Map(),
});

/** The step limit this isolate last read from the quota policy. */
let lastStepLimit: number | undefined;

/**
 * The steps a run may take (spec 18.1's logical steps, 1000 a run), as
 * the deployment's quota policy has it now: so a run whose code loops on
 * steps without end can't journal without bound. Counted over each
 * activation's replay of the run's journal (`countedStep`), so a restart,
 * a retry or a new activation counts every step the run took before.
 *
 * Read before any of the run's steps, where a throw would end the run for
 * good, so a policy that can't be read (the database failing for a
 * moment) is logged, and the limit this isolate last read applies, else
 * the platform's: the run goes on. It admits nothing more: every attempt
 * of a step reads the policy again as it is admitted (quotas.ts,
 * `admitAttempt`), and one that can't is refused as the platform's
 * unexpected error, which the engine retries. The limit only bounds what
 * the run journals, and the next activation reads it again.
 */
export const stepLimitOf = async (env: Env): Promise<number> => {
  try {
    const { limits } = await quotaPolicy(env);
    lastStepLimit = limits.workflowSteps;
    return lastStepLimit;
  } catch (error) {
    log.warn("workflow.quota_policy_unread", errorFields(error));
    return lastStepLimit ?? platformLimits.workflowSteps;
  }
};

/**
 * `step`, counting the run's own steps (`stepLimit` is the operator's
 * allowance of them) and refusing one past it, as a failure of that step.
 * Core's own steps (`$grasp:…`, but for a wait's, which the run's code
 * causes without bound: {@link waitStepPrefix}) and the SDK's first
 * `$params` step are outside the allowance: a run of one step fits an
 * allowance of one. So are the steps of a wait that aren't the run's own
 * (`uncountedWaitStep`),
 * and a step run again after one has no place of its own: it is the step
 * that already took its place. Counted over every replay, so each step
 * keeps its place.
 */
export const countedStep = (step: RunStep, stepLimit: number): RunStep => {
  let own = 0;
  let params = false;
  /** The step's place among the run's own steps; none for core's own. */
  const take = (name: string): number | undefined => {
    const core =
      (name.startsWith(coreStepPrefix) && !name.startsWith(waitStepPrefix)) ||
      uncountedWaitStep.test(name);
    const sdk = name === paramsStep && !params;
    params ||= sdk;
    if (core || sdk) {
      return undefined;
    }
    own += 1;
    if (own > stepLimit) {
      throw workflowErrors.create("workflow.too_many_steps");
    }
    return own;
  };
  return {
    do: async (name, config, fn) => {
      const ordinal = take(name);
      if (ordinal === undefined) {
        return await step.do(name, config, fn);
      }
      // Each attempt is told its step's place, for its admission against
      // the policy as it is then (quotas.ts, `admitAttempt`): the limit
      // this activation counts by may be a fallback (`stepLimitOf`).
      return await step.do(
        name,
        config,
        async (context) =>
          await fn(
            typeof context === "object" && context !== null
              ? { ...context, stepOrdinal: ordinal }
              : context
          )
      );
    },
    sleep: async (name, duration) => {
      take(name);
      await step.sleep(name, duration);
    },
    waitForEvent: async (name, options) => {
      take(name);
      return await step.waitForEvent(name, options);
    },
  };
};

/**
 * How the Loader stops an isolate past its `limits.cpuMs`: it throws, as
 * Cloudflare documents, "Worker exceeded CPU time limit." to whoever
 * called into it. Known by its message, which is all that survives RPC.
 * The run's own code can't make a call into its isolate reject so: every
 * entrypoint and step function settles what its code threw into a report
 * (code.ts, `settled`).
 */
const cpuLimit = /\bCPU time limit\b/u;
export const isCpuLimitKill = (error: unknown): boolean =>
  error instanceof Error && cpuLimit.test(error.message);

/**
 * One of core's errors as the isolate, and the run's own record, may see
 * it: an expected error as it is, a timeout as one (the Loader's CPU limit
 * too), anything else as `internal.unexpected`, with the cause only in
 * the log.
 */
export const forIsolate = (error: unknown): StepError => {
  if (isTimeout(error)) {
    return { name: "TimeoutError", message: "The step ran out of time." };
  }
  if (isCpuLimitKill(error)) {
    return { name: "TimeoutError", message: "The step ran out of CPU time." };
  }
  const seen = forSandbox(error);
  return {
    name: "Error",
    message: seen.message,
    ...(isExpectedError(seen) ? { code: seen.code } : {}),
  };
};

/** How `run` ended, as plain data. */
export const settle = async <T>(run: () => Promise<T>): Promise<Settled<T>> => {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: forIsolate(error) };
  }
};

/**
 * A step's error as the engine gets it: retried, with the step's retry
 * settings, only when trying again may fix it (`isRetryable`: a rate
 * limit, a server that took nothing, a timeout); anything else is
 * non-retryable, and stops the run. The engine knows a non-retryable error
 * by its name, so it keeps that name; the step's own error is reported
 * from what the isolate sent (`do`). Either keeps the error's code, which
 * the engine journals with its attempt, so a run's history tells what
 * failed by the same code the run's report does.
 */
const toStepError = (error: StepError): Error =>
  namedError(
    isRetryable(error) ? error.name : "NonRetryableError",
    error.message,
    error.code
  );

/**
 * Fails a call of an attempt that had a call refused, with that refusal:
 * every later call of a refused attempt fails at once, whatever it calls.
 */
const requireUnrefused = (attempt: StepAttempt): void => {
  if (attempt.refused !== undefined) {
    throw attempt.refused;
  }
};

/**
 * Whether connect said an unknown outcome waits for its person's word
 * (`awaitsResolution`): a native connector's lost answer. A Composio
 * tool's error, which its person can't yet see, fails the step instead.
 */
const awaitsResolution = (error: object): boolean => {
  const details: unknown = Reflect.get(error, "details");
  return (
    typeof details === "object" &&
    details !== null &&
    Reflect.get(details, "awaitsResolution") === true
  );
};

/**
 * Runs `call` for the step attempt `attempt`, noting when it answered that
 * a side effect was held, whatever the workflow code does with the error.
 * With `unknownHolds`, for a call under the step's own key, an outcome
 * nobody can tell (`connect.outcome_unknown`) that connect says waits for
 * its person (`awaitsResolution`) holds the step too: it waits until
 * connect can recover the call or its person resolved it (connect's
 * `anyPending` says so), then runs again under the same key, rather than
 * spend its retries on the same answer or fail the run.
 */
const heldNoted = async <T>(
  attempt: { held: boolean; unknown?: boolean },
  call: () => Promise<T>,
  unknownHolds = false
): Promise<T> => {
  try {
    return await call();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      if (error.code === heldCode) {
        attempt.held = true;
      } else if (
        unknownHolds &&
        error.code === unknownCode &&
        awaitsResolution(error)
      ) {
        attempt.held = true;
        attempt.unknown = true;
      }
    }
    throw error;
  }
};

/** Most fields of a step's input a failure report names. */
const maxShapeFields = 20;

/**
 * A field name a failure report may show: letters, `_` and `-` only, and
 * short, like the names code gives fields; so never an email address, an
 * ID or other data used as a key.
 */
const fieldNamePattern = /^[A-Za-z_][A-Za-z_-]{0,31}$/u;

const typeOf = (value: Json | undefined): string => {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "array" : typeof value;
};

/**
 * What a failure report keeps of a step's input (`InputShape`): its type,
 * and for an object the names and types of the fields `fieldNamePattern`
 * lets through, no values. The input can hold anything the run read (a
 * message's text, a person's details), and the report outlives the run.
 */
const inputShape = (input: Json | undefined): InputShape | null => {
  if (input === undefined) {
    return null;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return typeOf(input);
  }
  const shape: Record<string, string> = {};
  let shown = 0;
  let others = 0;
  for (const [field, value] of Object.entries(input)) {
    if (shown < maxShapeFields && fieldNamePattern.test(field)) {
      shape[field] = typeOf(value);
      shown += 1;
    } else {
      others += 1;
    }
  }
  // No field name takes this form, so it can't stand for a field.
  if (others > 0) {
    shape["…"] = `${others} more`;
  }
  return shape;
};

/** A step that failed in an execution, as its failure report names it. */
export interface FailedStep {
  step: string;
  input: InputShape | null;
  error: StepError;
}

/** How a host reaches back into the dispatcher (dispatcher.ts). */
export interface HostHooks {
  /** Hears of each step that failed, with the error it failed with. */
  stepFailed: (failure: FailedStep) => void;
  /**
   * Hears of each call of an attempt's function into the run's isolate as
   * it starts, with a promise that settles once the attempt's step ends in
   * this activation (done, or failed for good): so the run can tell, once
   * the Loader stops the isolate past its CPU time, whether an attempt was
   * cut off, and whether its step is to be retried (dispatcher.ts).
   */
  attemptCall?: (call: Promise<unknown>, stepDone: Promise<unknown>) => void;
  /** Each step's last refusal for a busy budget (`#untilAsking`). */
  busyRefusals: BusyRefusals;
  /**
   * The run's AI calls in flight, and answers no attempt took, kept by
   * its object across its activations (`AiCalls`); a host of its own
   * when absent.
   */
  aiCalls?: AiCalls;
  /**
   * The engine's lease of a step's attempt, while it holds, as the journal
   * says now (run-object.ts): none once the attempt has ended, a newer one
   * was claimed, or its activation is over.
   */
  leaseOf: (key: string, attempt: number) => AttemptLease | undefined;
  /**
   * Hears that an attempt's function (`fence`) has returned, once it
   * called an App: the run's object holds it no more, and revokes in the
   * Apps the calls it started there (run-object.ts, `#attemptReturned`),
   * without the run waiting. None for a host of its own.
   */
  revokeAttempt?: (fence: AttemptFence) => void;
  /**
   * Hears, once, that the run's isolate asked for what only code that
   * gets past the SDK could (a step its review doesn't show): the run
   * fails with `error`, whatever its code makes of the refusal.
   */
  tampered: (error: StepError) => void;
  /**
   * Records that the run waits while a side effect of a step is held for
   * the person it acts for.
   */
  waiting: (why: WaitReason) => Promise<void>;
  /**
   * Calls a method of the run's App for `caller` (`callApp`), giving up
   * at `ends`, when the step's attempt does.
   */
  callApp: (
    caller: AppCallerInput,
    method: string,
    args: unknown[],
    ends: number | undefined
  ) => Promise<AppAnswer>;
  /**
   * The App's model binding of `alias` an AI step goes through, as it
   * serves now (`stepModelBinding`): `resource.unavailable` when none
   * does.
   */
  modelBinding: (alias: string) => Promise<StepModel>;
  /**
   * Calls a public function of the run's App's release, for `caller`, a
   * step of the run, under `idempotencyKey` (`callRunFunction`).
   */
  callFunction: (
    caller: RunCaller,
    reference: unknown,
    input: unknown,
    idempotencyKey: string
  ) => Promise<OperationResult>;
  /**
   * Admits a step's attempt against its run lineage's quotas before its
   * code runs (quotas.ts, `admitAttempt`), throwing the refusal, or
   * answering what settles the attempt once its function has returned.
   * The dispatcher's always does; none only for a test's host of its own.
   */
  admitAttempt?: (attempt: QuotaAttempt) => Promise<AttemptAdmission>;
}

/**
 * One execution of a run, as its workflow code's engine. Every method
 * answers `Settled`, never throws, so the error the isolate sees is the
 * one sent.
 */
export class RunHost extends RpcTarget {
  readonly #env: Env;
  readonly #step: RunStep;
  readonly #run: HostedRun;
  readonly #hooks: HostHooks;
  /**
   * Each step's AI call in flight, by step name: a later attempt of the
   * step waits for it rather than ask the gateway beside it.
   */
  readonly #asking: AiCalls["asking"];
  /**
   * Answers no attempt took, by step name (`AiCalls.unclaimed`).
   */
  readonly #unclaimed: AiCalls["unclaimed"];
  /**
   * The refusal that caught the run's isolate tampering
   * (`#refuseTampering`): once set, every later call of this execution
   * fails with it at once.
   */
  #tampered: Error | undefined;
  /**
   * The attempts whose functions run now, in the order they began: the
   * last is the step running now, which every reviewed call is checked
   * against as well as the step whose host it came through
   * (`#requireReviewed`).
   */
  readonly #live: StepAttempt[] = [];
  /**
   * Whether the Loader stopped the run's isolate past its CPU time: no
   * later attempt of this execution calls into it (`do`).
   */
  #isolateStopped = false;

  constructor(env: Env, step: RunStep, run: HostedRun, hooks: HostHooks) {
    super();
    this.#env = env;
    this.#step = step;
    this.#run = run;
    this.#hooks = hooks;
    const aiCalls = hooks.aiCalls ?? newAiCalls();
    this.#asking = aiCalls.asking;
    this.#unclaimed = aiCalls.unclaimed;
  }

  get #actor(): AuditActor {
    return runActorOf(this.#run);
  }

  /**
   * Records how a step went, through the outbox. Every step the host ran
   * is recorded, the SDK's own (`$params`) too: the isolate
   * names them, so a name is no reason to leave one out. A record that
   * can't be stored is logged, and the run goes on: the step happened.
   */
  async #audited(
    step: string,
    outcome: "completed" | "failed",
    detail: { sideEffect: boolean; errorCode?: string }
  ): Promise<void> {
    const { app, workflow, version, runId } = this.#run;
    const db = drizzle(this.#env.DB);
    try {
      await auditedBatch(this.#env, db, [
        outboxed(db, {
          actor: this.#actor,
          action: `workflow.step.${outcome}`,
          target: { type: "workflow_run", id: runId },
          detail: {
            app,
            workflow,
            version,
            step,
            sideEffect: detail.sideEffect,
            ...(detail.errorCode === undefined
              ? {}
              : { errorCode: detail.errorCode }),
          },
        }),
      ]);
    } catch (error) {
      log.error("workflow.step.audit_failed", {
        runId,
        step,
        ...errorFields(error),
      });
    }
  }

  /**
   * Waits, before running the step `step` again, while a side effect it
   * asked for is held for the person the run acts for: each check a step
   * of its own (retried, and replayed without asking connect again), then
   * a durable wait that the person's decision ends (`heldWakeType`,
   * wakes.ts), or else the next check: a minute first (`waitMsOf`),
   * doubling up to 15 minutes, in steps named after `prefix`, for holds
   * connect ends by itself. A wake only makes the step check again: what
   * connect says decides. The wait is recorded once, in a step of its
   * own. Each check and wait is a step of the run's budget, so a run waits
   * about five days at the platform's limit. A decline or a drop ends the
   * wait too: the step's next run fails with `connect.declined`.
   */
  async #waitWhileHeld(
    step: string,
    prefix: string,
    keys: readonly string[],
    unknownSince?: number
  ): Promise<boolean> {
    const first = waitMsOf(this.#env);
    if (unknownSince !== undefined) {
      // Never run again at once on an unknown outcome: should connect
      // and the step's call disagree on whether it may be recovered now,
      // the step would come back held at once, again and again.
      await this.#step.sleep(`${prefix}:first`, first);
    }
    const deadline =
      unknownSince === undefined
        ? undefined
        : unknownSince + unknownHoldMsOf(this.#env);
    const wakeType = await heldWakeType(step);
    for (let checks = 0; ; checks += 1) {
      // Its answer is recorded, so a replay asks connect nothing, and a
      // failing connect is tried again rather than failing the step.
      // oxlint-disable-next-line no-await-in-loop -- one check at a time
      const held = await this.#step.do(
        `${prefix}:${checks}:check`,
        {
          retries: {
            limit: heldCheckRetries,
            delay: first,
            backoff: "exponential",
          },
        },
        async (): Promise<boolean | "expired"> => {
          // Past its deadline the hold ends, unless its person resolved
          // it meanwhile (the step then runs again, as they said): a call
          // still of unknown outcome is theirs to resolve, with no run
          // waiting on it, and never recovered on its own after it, so
          // one connect could recover counts as unresolved here.
          if (deadline !== undefined && Date.now() >= deadline) {
            return (await this.#stillHeld(step, keys, true))
              ? "expired"
              : false;
          }
          return await this.#stillHeld(step, keys);
        }
      );
      if (held === "expired") {
        // Nobody resolved it in time: the step fails, saying so, rather
        // than wait out the run's steps.
        throw connectErrors.create("connect.outcome_unknown_unresolved");
      }
      if (held !== true) {
        // Whether a check found it held before it cleared (`#waitBefore`).
        return checks > 0;
      }
      if (checks === 0) {
        // The step's name stays as it was for either reason: a replay
        // finds it recorded, whatever reason it was recorded with.
        // oxlint-disable-next-line no-await-in-loop -- once per wait
        await this.#recordWaiting(`${prefix}:waiting:held`, {
          reason: unknownSince === undefined ? "held" : "outcome_unknown",
        });
      }
      // Until its person decides, which wakes the step (wakes.ts), or the
      // next check is due: the backstop for holds connect ends by itself.
      try {
        // oxlint-disable-next-line no-await-in-loop -- one wait at a time
        await this.#step.waitForEvent(`${prefix}:${checks}`, {
          type: wakeType,
          timeout: Math.min(
            first * 2 ** checks,
            first * (unknownSince === undefined ? maxWaits : maxUnknownWaits)
          ),
        });
      } catch (error) {
        if (!isTimeout(error)) {
          throw error;
        }
      }
    }
  }

  /**
   * `#stillHeld`, or `true` when connect can't say: the step then waits,
   * and the wait's own checks, which retry, ask again.
   */
  async #stillHeldOrUnknown(step: string): Promise<boolean> {
    try {
      return await this.#stillHeld(step);
    } catch (error) {
      log.warn("workflow.held_check_failed", {
        runId: this.#run.runId,
        step,
        ...errorFields(error),
      });
      return true;
    }
  }

  /**
   * Whether a side effect of the step `step` waits for the run's person:
   * one under the step's own key (its connection calls, its App's
   * methods'), or one of `keys`, those its App's functions asked for
   * through their resource bindings.
   */
  async #stillHeld(
    step: string,
    keys: readonly string[] = [],
    orRecoverable = false
  ): Promise<boolean> {
    const { onBehalfOf } = this.#run.authority;
    const waiting = await Promise.all(
      [stepIdempotencyKey(this.#run.runId, step), ...keys].map(
        async (idempotencyKey) =>
          await this.#env.CONNECT.anyPending({
            onBehalfOf,
            idempotencyKey,
            ...(orRecoverable ? { orRecoverable } : {}),
          })
      )
    );
    return waiting.includes(true);
  }

  /** Records, once in step `step`, that the run waits, and why. */
  async #recordWaiting(step: string, why: WaitReason): Promise<void> {
    try {
      await this.#step.do(step, {}, async () => {
        await this.#hooks.waiting(why);
        return null;
      });
    } catch (error) {
      log.error("workflow.waiting.audit_failed", {
        runId: this.#run.runId,
        ...why,
        ...errorFields(error),
      });
    }
  }

  /**
   * Admits `attempt` against its run lineage's quotas (`admitAttempt`),
   * throwing the refusal; nothing to settle for a host of its own. A step
   * that has waited for load as long as a step may is refused
   * (`workflow.queue_timeout`): by the admission, against the policy as
   * it is now, or, with none, before it asks.
   */
  async #admit(
    attempt: StepAttempt,
    { waited, waitedMs, maxWaitMs }: WaitedSoFar
  ): Promise<AttemptAdmission | Busy> {
    if (this.#hooks.admitAttempt === undefined) {
      // Waited as long as a step may: it fails, though a share came free
      // as it slept, and none of its code runs. With an admission, the
      // admission decides (quotas.ts), by the cap as it is now, not the
      // one the step's last refusal named: an operator may have raised it
      // as the step slept.
      if (waitedMs !== undefined && waitedMs >= maxWaitMs) {
        throw workflowErrors.create("workflow.queue_timeout", { maxWaitMs });
      }
      return unadmitted;
    }
    try {
      const admission = await this.#hooks.admitAttempt({
        key: attempt.key,
        waited,
        ...(waitedMs === undefined ? {} : { waitedMs }),
        step: attempt.step,
        number: attempt.number,
        ...(attempt.ordinal === undefined ? {} : { ordinal: attempt.ordinal }),
        generation: attempt.generation,
        deadline: attempt.deadline,
      });
      // No attempt after it is admitted: it is the step's last.
      if (attempt.number >= admission.attemptsAllowed) {
        attempt.last = true;
      }
      return admission;
    } catch (error) {
      const busy = busyOf(error);
      if (busy === undefined) {
        throw error;
      }
      return busy;
    }
  }

  /**
   * Waits durably before the step `step` runs again, its attempt having
   * answered `marker`, in round `round`: until the person decided on its
   * held side effect (`#waitWhileHeld`), or the seconds its busy lineage
   * said, as long as `sleepMs` (a sleep, which holds no attempt). A step
   * queued for a share of the client's attempts running at once records
   * that the run waits each time it joins the queue: when its refusal
   * took it a place (`joined`), as after a pause gave its place up.
   * `unknown` carries when the step was first held on its current unknown
   * outcome across rounds. Answers the prefix of the steps it waited in,
   * which the step's next run is named after.
   */
  async #waitBefore(
    step: string,
    marker: CoreMarker,
    { round, sleepMs }: WaitRound,
    unknown: { since?: number }
  ): Promise<string> {
    const key = await waitKeyOf(step);
    if (marker.kind === "held") {
      // A hold on an unknown outcome waits in steps of its own kind,
      // outside the run's step allowance (`uncountedWaitStep`).
      const prefix = waitStep(key, marker.unknown ? "unknown" : "held", round);
      if (marker.unknown) {
        // When the step was first held on this unknown outcome, recorded
        // once, so its deadline holds across rounds and replays.
        unknown.since ??= z
          .number()
          .parse(
            await this.#step.do(
              `${prefix}:since`,
              {},
              async () => await Promise.resolve(Date.now())
            )
          );
      }
      const decided = await this.#waitWhileHeld(
        step,
        prefix,
        marker.keys,
        marker.unknown ? unknown.since : undefined
      );
      // A check found it held, and it cleared since: its person
      // resolved it, or connect may now recover the call (its claim past
      // the claim timeout). An unknown outcome the step comes back with
      // after starts 7 days of its own. One that cleared before any check
      // ran (connect and the step's call disagree) keeps its deadline.
      // So a call connect keeps failing to recover restarts the window at
      // most until connect's recovery horizon (a day from its first
      // claim, apps/connect/src/idempotency.ts), past which it is never
      // recoverable: a hold ends a day and 7 days after its first claim
      // at the latest. A person who resolves before the first check
      // leaves the next outcome on the old deadline, a minute shorter.
      if (decided) {
        unknown.since = undefined;
      }
      return prefix;
    }
    const prefix = waitStep(key, "busy", round);
    if (marker.queuedFor !== undefined && marker.joined) {
      await this.#recordWaiting(`${prefix}:waiting:queued`, {
        reason: "queued",
        waitingFor: marker.queuedFor,
        retryAfterSeconds: marker.busyFor,
      });
    }
    await this.#step.sleep(prefix, sleepMs);
    return prefix;
  }

  /**
   * The person the run acts for must still be there: checked before every
   * step, and inside one (a model call, an App call). One who has
   * left fails the step, and with it the run.
   */
  async #requirePerson(): Promise<void> {
    await requireActivePerson(this.#env, this.#run.authority);
  }

  /**
   * Runs `fn` (in the isolate) as a durable step, with the SDK's retries
   * and timeout. A replay answers the recorded result, or throws the
   * recorded error, without calling it. Its outcome is audited, and a
   * failure reported (`stepFailed`), only when it was attempted in this
   * activation: a failure workflow code caught is replayed on every later
   * activation, and was recorded when it happened. A step the engine
   * fenced (a pause, a cancel, a newer activation) never settles here, so
   * nothing is recorded for it in an activation that is over. A step that fails
   * before it starts (options that don't parse, a person who has left) is
   * neither: the run's own failure records it. When a side effect of the
   * step is held for the person the run acts for, the step ends as held,
   * not failed, uses no retries, and the run waits until the person
   * decided, then runs the step again under the same key
   * (`#waitWhileHeld`): confirmed, it gets the answer; declined or
   * dropped, it fails with `connect.declined`.
   */
  async do(
    name: unknown,
    options: unknown,
    fn: (attempt: AttemptHost) => Promise<unknown>
  ): Promise<Settled<unknown>> {
    let failed: StepError | undefined;
    let attempted = false;
    let step = "";
    let sideEffect = false;
    let input: InputShape | null = null;
    const stepDone = Promise.withResolvers<null>();
    try {
      this.#requireUntampered();
      step = checked(stepNameSchema, name);
      await this.#requireStepReviewed(step);
      const parsed = checked(doOptionsSchema, options);
      sideEffect = parsed.sideEffect === true;
      input = inputShape(parsed.input);
      await this.#requirePerson();
      // The attempts of this `do` this execution made, for an engine that
      // doesn't say which attempt it runs.
      let tries = 0;
      // The step's wait for load since its last admission (`LoadWait`).
      let load = loadWaitStart;
      const attemptStep = async (context?: unknown): Promise<unknown> => {
        attempted = true;
        tries += 1;
        // Only the last attempt's error counts: an earlier one was retried.
        failed = undefined;
        // Who this attempt is, as the engine claimed it: its number, its
        // step's key and its lease, which an activation that is over no
        // longer has. Its code acts only through the host minted for it.
        const told = attemptContextSchema.parse(context);
        const lease = this.#hooks.leaseOf(told.idempotencyKey, told.attempt);
        if (lease === undefined) {
          throw new Error(`Step "${step}"'s attempt holds no lease`);
        }
        const attempt: StepAttempt = {
          leaseId: crypto.randomUUID(),
          number: told.attempt,
          ...(told.stepOrdinal === undefined
            ? {}
            : { ordinal: told.stepOrdinal }),
          key: told.idempotencyKey,
          generation: lease.generation,
          deadline: lease.deadline,
          over: false,
          step,
          held: false,
          unknown: false,
          heldKeys: [],
          functionCalls: 0,
          calledApp: false,
          last: isLastAttempt(context, tries, parsed.retries?.limit),
        };
        // Admitted before its code runs, or failed with the refusal: a
        // limit reached fails the step; a lineage whose time attempts
        // under way hold ends the step as busy, and the run waits
        // (`busyMarker`).
        const admitted = await settle(
          async () =>
            await this.#admit(attempt, {
              waited: load.rounds,
              waitedMs: load.rounds === 0 ? undefined : load.waitedMs,
              maxWaitMs: load.maxWaitMs,
            })
        );
        if (!admitted.ok) {
          failed = admitted.error;
          throw toStepError(failed);
        }
        const { value: admission } = admitted;
        if ("busyFor" in admission) {
          return busyMarker(admission);
        }
        let result: Settled<unknown>;
        // Whether the attempt still held its lease as its function
        // returned: one the engine gave up on (it timed out, or its
        // activation is over) answers for nothing.
        let current = false;
        this.#live.push(attempt);
        try {
          result = await this.#callAttempt(
            attempt,
            admission,
            fn,
            stepDone.promise
          );
        } finally {
          current = this.#holds(attempt);
          // Its function has returned: its host acts no more, whatever
          // the attempt's code still has out.
          attempt.over = true;
          this.#live.splice(this.#live.indexOf(attempt), 1);
          if (attempt.calledApp) {
            this.#hooks.revokeAttempt?.(this.#fenceOf(attempt));
          }
          // What it held of its lineage's time turns into what it used.
          await admission.settle();
        }
        // Connect held a side effect of it for the person the run acts
        // for: the step ends as held, not failed, whatever the workflow
        // code made of the answer, and runs again once they decided. The
        // run's own calls say so; for its App's methods, which may keep
        // the answer to themselves, connect is asked about the step's key.
        // (Core can't see whether an App method called out: its calls run
        // in the App's own object.) Once decided, the rerun's call answers
        // for good: a decline (`connect.declined`) is an error like any
        // other, which workflow or App code may catch and carry on from;
        // it is audited in connect whatever the code does with it.
        const held =
          current &&
          (attempt.held ||
            (attempt.calledApp && (await this.#stillHeldOrUnknown(step))));
        // A call its review doesn't show fails the step for good, even
        // when its code caught the refusal and carried on.
        if (attempt.refused !== undefined) {
          failed = forIsolate(attempt.refused);
          throw toStepError(failed);
        }
        if (held) {
          return heldMarkerOf(attempt.heldKeys, attempt.unknown);
        }
        if (!result.ok) {
          failed = result.error;
          throw toStepError(result.error);
        }
        if (isCoreMarker(result.value)) {
          failed = {
            name: "Error",
            message: `Step "${step}" returned a value core keeps for itself`,
          };
          throw toStepError(failed);
        }
        if (!z.json().optional().safeParse(result.value).success) {
          failed = {
            name: "Error",
            message: `Step "${step}" returned something that isn't JSON`,
          };
          throw toStepError(failed);
        }
        const recorded = JSON.stringify(result.value) ?? "";
        if (
          new TextEncoder().encode(recorded).byteLength > maxStepResultBytes
        ) {
          failed = {
            name: "Error",
            message: `Step "${step}" returned more than 1 MiB`,
          };
          throw toStepError(failed);
        }
        // Recorded here, before the engine stores the result, so a stop
        // between the two can't lose it: at least once, as a stop before
        // the result is stored runs the step, and records it, again.
        if (current) {
          // The step completes with this attempt: the statistics points
          // its App calls recorded are added up, once (a step run again
          // after this adds nothing), and no other attempt's.
          if (attempt.calledApp) {
            await commitStepStatistics(
              this.#env,
              this.#run.runId,
              stepIdempotencyKey(this.#run.runId, step),
              attempt.leaseId
            );
          }
          await this.#audited(step, "completed", { sideEffect });
        }
        return result.value;
      };
      let value = await this.#step.do(step, stepConfig(parsed), attemptStep);
      // Held, or its lineage busy: wait until the person decided, or the
      // seconds the lineage said, then run the step again under the same
      // key, in a step of its own each time, so every execution replays the
      // same steps.
      // When the step was first held on its current unknown outcome.
      const unknown: { since?: number } = {};
      let round = 0;
      for (
        let marker = markerOf(value);
        marker !== undefined;
        marker = markerOf(value)
      ) {
        round += 1;
        // Read off the markers alone, journaled as the step's results, so
        // every replay counts the same.
        load = loadWaitAfter(load, marker);
        if (marker.kind === "busy" && load.sleepMs <= 0) {
          failed = queueTimedOut(step, marker.maxWaitMs);
          throw toStepError(failed);
        }
        // oxlint-disable-next-line no-await-in-loop -- one round at a time
        const prefix = await this.#waitBefore(
          step,
          marker,
          { round, sleepMs: load.sleepMs },
          unknown
        );
        tries = 0;
        // oxlint-disable-next-line no-await-in-loop -- one round at a time
        value = await this.#step.do(
          `${prefix}:run`,
          stepConfig(parsed),
          attemptStep
        );
      }
      return { ok: true, value };
    } catch (error) {
      const reported = failed ?? forIsolate(error);
      if (attempted) {
        this.#hooks.stepFailed({ step, input, error: reported });
        await this.#audited(step, "failed", {
          sideEffect,
          errorCode: reported.code ?? "workflow.step_failed",
        });
      }
      return { ok: false, error: reported };
    } finally {
      stepDone.resolve(null);
    }
  }

  /**
   * Calls `attempt`'s function in the run's isolate, through a host whose
   * every call `admission` admits as one of its lineage's host calls,
   * `stepDone` settling
   * once its step ends in this activation: what it settled with, or, once
   * the Loader stopped the isolate past its CPU time while it ran, a
   * timeout, which its step's retries retry in a fresh activation with a
   * fresh isolate (dispatcher.ts, `afterCpuKill`). An isolate so stopped
   * runs nothing more: an attempt that comes after it in this activation
   * (a retry due at once) times out as the one cut off did.
   */
  async #callAttempt(
    attempt: StepAttempt,
    admission: AttemptAdmission,
    fn: (attempt: AttemptHost) => Promise<unknown>,
    stepDone: Promise<unknown>
  ): Promise<Settled<unknown>> {
    const call = this.#isolateStopped
      ? Promise.reject(new Error("Worker exceeded CPU time limit."))
      : fn(this.#attemptHost(attempt, admission));
    this.#hooks.attemptCall?.(call, stepDone);
    try {
      return fromIsolate(await call);
    } catch (error) {
      if (!isCpuLimitKill(error)) {
        throw error;
      }
      this.#isolateStopped = true;
      return { ok: false, error: forIsolate(error) };
    }
  }

  async sleep(name: unknown, duration: unknown): Promise<Settled<null>> {
    return await settle(async () => {
      this.#requireUntampered();
      const step = checked(stepNameSchema, name);
      await this.#requireStepReviewed(step);
      const ms = checked(milliseconds, duration);
      await this.#step.sleep(step, ms);
      return null;
    });
  }

  /**
   * `call`'s answer, asked of the gateway once {@link #untilAsking} lets
   * `attempt` ask. When the budget turns it away while other calls under
   * way hold it, the refusal is kept, and the attempt waits out
   * {@link budgetBusyWaitMs} (as long as its timeout lets it) before it
   * fails, unless it is the last: nothing comes after it.
   */
  async #waitingOutBusyBudget(
    attempt: StepAttempt,
    request: string,
    call: () => Promise<unknown>,
    /**
     * What must still hold before an answer an earlier attempt left is
     * taken, as it would before asking: its binding still serving.
     */
    stillServed: () => Promise<void>
  ): Promise<unknown> {
    await this.#untilAsking(attempt);
    // Out of time while it waited: the engine has given up on it, and
    // the next attempt takes what it waited for. It asks nothing.
    if (this.#givenUp(attempt)) {
      throw attemptTimedOut();
    }
    const left = this.#unclaimed.get(attempt.step);
    if (left?.request === request) {
      // Revoked since it was asked: the answer it left serves nothing.
      await stillServed();
      this.#unclaimed.delete(attempt.step);
      return left.answer;
    }
    const asking = call();
    this.#asking.set(attempt.step, asking);
    try {
      const answer = await asking;
      if (this.#givenUp(attempt)) {
        // Given up on while the gateway answered: kept for the next
        // attempt, which would otherwise ask, and pay, again.
        this.#unclaimed.set(attempt.step, { request, answer });
      }
      return answer;
    } catch (error) {
      // Settled: stop holding later attempts on it before this one waits,
      // or they would await the same settled promise again and again.
      this.#stopAsking(attempt.step, asking);
      if (modelErrors.codeOf(error) === "model.budget_busy") {
        const details =
          typeof error === "object" && error !== null && "details" in error
            ? errorPayloadSchema.shape.details.safeParse(error.details).data
            : undefined;
        this.#hooks.busyRefusals.set(attempt.step, { at: Date.now(), details });
        if (!attempt.last) {
          await waitWithin(attempt, budgetBusyWaitMs);
        }
      }
      // A full share of the model requests in flight (the gateway already
      // waited its turn for as long as a call may), or the provider's
      // rate: the attempt waits the wait core computed, as long as its
      // timeout lets it and no longer than a busy budget's, before it
      // fails, unless it is the last.
      const throttled = modelErrors.codeOf(error);
      if (
        (throttled === "model.queued" || throttled === "model.rate_limited") &&
        !attempt.last
      ) {
        const wait = isExpectedError(error)
          ? error.details?.retryAfterSeconds
          : undefined;
        await waitWithin(
          attempt,
          Math.min(
            budgetBusyWaitMs,
            typeof wait === "number" ? wait * 1000 : budgetBusyWaitMs
          )
        );
      }
      throw error;
    } finally {
      this.#stopAsking(attempt.step, asking);
    }
  }

  /**
   * Whether the engine gave up on `attempt` (`#holds`): its timeout
   * passed, or its lease is gone; its next attempt may run in another
   * activation, which this host doesn't see.
   */
  #givenUp(attempt: StepAttempt): boolean {
    return !this.#holds(attempt);
  }

  #stopAsking(step: string, asking: Promise<unknown>): void {
    if (this.#asking.get(step) === asking) {
      this.#asking.delete(step);
    }
  }

  /**
   * Returns once `attempt` may ask the gateway for its step's AI call, so
   * a step asks the ledger, and audits a refusal, at most once every
   * {@link budgetBusyWaitMs}, however tightly its attempts are retried or
   * time out. It waits for a call of the step still in flight, and while
   * the step's last refusal for a busy budget is that recent, for that
   * while to end. An attempt whose timeout ends first, or that a newer
   * attempt took over meanwhile, is answered with that refusal instead,
   * its wait shortened by the time gone by.
   */
  async #untilAsking(attempt: StepAttempt): Promise<void> {
    for (;;) {
      const asking = this.#asking.get(attempt.step);
      const known = this.#hooks.busyRefusals.get(attempt.step);
      const left =
        known === undefined ? 0 : known.at + budgetBusyWaitMs - Date.now();
      if (asking === undefined && left <= 0) {
        return;
      }
      if (asking !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- then look again
        await asking.then(
          () => null,
          () => null
        );
      } else if (known !== undefined) {
        const timeLeft = attempt.deadline - Date.now();
        if (timeLeft < left) {
          // oxlint-disable-next-line no-await-in-loop -- once, then answered
          await scheduler.wait(Math.max(0, timeLeft));
          throw busyAgain(known);
        }
        // oxlint-disable-next-line no-await-in-loop -- then look again
        await scheduler.wait(left);
      }
      if (!this.#holds(attempt)) {
        const latest = this.#hooks.busyRefusals.get(attempt.step);
        throw latest === undefined
          ? modelErrors.create("model.failed")
          : busyAgain(latest);
      }
    }
  }

  /**
   * Asks the model gateway for an AI step, from inside the step only: the
   * model must be one the deployment allows and its rules let this call
   * use (model-rules.ts), and its answer must match the step's schema (a JSON Schema from the SDK, checked here as Zod, and
   * again by the SDK). The audit log records the call under this run.
   */
  async #callModel(
    attempt: StepAttempt,
    request: unknown
  ): Promise<Settled<unknown>> {
    return await settle(async () => {
      this.#requireUntampered();
      await this.#requireCurrent(attempt, "model");
      requireUnrefused(attempt);
      await this.#requirePerson();
      const { binding, instructions, input, outputSchema } = checked(
        modelRequestSchema,
        request
      );
      let schema: z.ZodType;
      try {
        schema = z.fromJSONSchema(outputSchema);
      } catch {
        throw modelErrors.create("model.invalid_call");
      }
      const { output } = modelAnswerSchema.parse(
        await this.#waitingOutBusyBudget(
          attempt,
          JSON.stringify([binding, instructions, input, outputSchema]),
          async () => {
            // The App's binding of the alias, as it serves now: read again
            // for every attempt, so one revoked or changed meanwhile stops
            // the next.
            const bound = await this.#hooks.modelBinding(binding);
            // This call of the step, whose notes of its wait are its own.
            const owner = crypto.randomUUID();
            // Last, after every read: an attempt the engine gave up on
            // meanwhile asks the gateway nothing.
            await this.#requireCurrent(attempt, "model");
            try {
              return await models(this.#env).call({
                model: bound.model,
                // Its caps count each attempt as a request of its own.
                binding: bound.binding,
                ...tokensOfBound(bound.maxOutputTokens, true),
                system: instructions,
                input,
                schema,
                purpose: "workflow.step",
                trigger: this.#actor,
                // Whose share it takes: who started the run, never the
                // owner it acts for when nobody did.
                shareSubject: this.#run.shareSubject,
                // The step may have read any of them into its input.
                connections: [
                  ...new Set(
                    Object.values(this.#run.connections).map(
                      ({ connection }) => connection.connectionId
                    )
                  ),
                ],
                // The run's restricted mode, which is its App's.
                work: {
                  authority: this.#run.authority,
                  context: {
                    type: "run",
                    appId: this.#run.app,
                    runId: this.#run.runId,
                  },
                },
                // After the ledger admitted each provider request, with
                // nothing awaited before it is sent.
                beforeSend: () => {
                  if (!this.#holds(attempt)) {
                    throw executionErrors.create("execution.stale_attempt");
                  }
                },
                // While its call waits for a share of the model requests
                // in flight, the run shows queued (model-waits.ts).
                onQueued: async (queued) => {
                  await modelWaitRecorded(
                    drizzle(this.#env.DB),
                    this.#run.runId,
                    attempt.step,
                    owner,
                    queued
                  );
                },
              });
            } catch (error) {
              // Stopped before it was sent, as the engine gave up on the
              // attempt: said so, whatever the gateway made of the stop.
              await this.#requireCurrent(attempt, "model");
              throw error;
            }
          },
          async () => {
            await this.#hooks.modelBinding(binding);
          }
        )
      );
      return output;
    });
  }

  /**
   * The idempotency key of `attempt`'s step. Core holds the key to a run's
   * side effects: its connection calls, and those of its App's methods it
   * calls, take this key or none (`requireStepKey`).
   */
  #stepKeyOf(attempt: StepAttempt): string {
    return stepIdempotencyKey(this.#run.runId, attempt.step);
  }

  /**
   * Who `attempt` is, for the calls it starts beyond this host (its App's
   * methods, other Apps' exports), whose every stub call checks it still
   * holds before it acts (attempt-fence.ts).
   */
  #fenceOf(attempt: StepAttempt): AttemptFence {
    return {
      run: this.#run.runId,
      key: attempt.key,
      number: attempt.number,
      generation: attempt.generation,
    };
  }

  /**
   * Whether `attempt` may still act: its function hasn't returned, its
   * deadline hasn't passed, and the engine's journal still has it holding
   * its lease, under the generation that claimed it. Read at every call,
   * so a call that lands late is judged as its own attempt is now.
   */
  #holds(attempt: StepAttempt): boolean {
    if (attempt.over || Date.now() >= attempt.deadline) {
      return false;
    }
    const lease = this.#hooks.leaseOf(attempt.key, attempt.number);
    return lease?.generation === attempt.generation;
  }

  /**
   * Refuses a call of `attempt` that no longer holds (`#holds`) with
   * `execution.stale_attempt`: the engine gave up on it (it timed out, or
   * its activation is over) while its code went on. The call does
   * nothing, whatever it asked; the first refusal of each attempt is
   * audited.
   */
  async #requireCurrent(attempt: StepAttempt, call: string): Promise<void> {
    if (this.#holds(attempt)) {
      return;
    }
    if (attempt.staleAudited !== true) {
      attempt.staleAudited = true;
      await this.#auditRefusal({
        step: attempt.step,
        call,
        errorCode: "execution.stale_attempt",
      });
    }
    throw executionErrors.create("execution.stale_attempt");
  }

  /**
   * The host `attempt`'s code reaches core through, every call as it, and
   * each admitted against its lineage's host calls (`admission`).
   */
  #attemptHost(attempt: StepAttempt, admission: AttemptAdmission): AttemptHost {
    return new AttemptHost(
      {
        callModel: async (request) => await this.#callModel(attempt, request),
        callCollection: async (binding, method, args) =>
          await this.#callCollection(attempt, binding, method, args),
        callConnection: async (binding, call) =>
          await this.#callConnection(attempt, binding, call),
        callApp: async (method, args) =>
          await this.#callApp(attempt, method, args),
        callFunction: async (reference, input) =>
          await this.#callFunction(attempt, reference, input),
        callExport: async (binding, method, input) =>
          await this.#callExport(attempt, binding, method, input),
        openDecision: async (request) =>
          await this.#openDecision(attempt, request),
        decisionRecipients: async (decision, reminder) =>
          await this.#decisionRecipients(attempt, decision, reminder),
        readAttachment: async (stored, index) =>
          await this.#readAttachment(attempt, stored, index),
      },
      async (call) => await this.#leaseRefusal(attempt, call),
      async (call) => await this.#hostCallRefusal(attempt, admission, call)
    );
  }

  /**
   * The refusal of a call of `attempt` past its lineage's host calls
   * (quotas.ts, `hostCallsOf`), or nothing once it is admitted: the
   * check `AttemptHost` makes once before each call. The first refusal
   * for the limit of each attempt is audited: its code may catch it and
   * carry on, though nothing it calls is admitted any more.
   */
  async #hostCallRefusal(
    attempt: StepAttempt,
    admission: AttemptAdmission,
    call: string
  ): Promise<Settled<never> | undefined> {
    try {
      await admission.hostCall();
      return undefined;
    } catch (error) {
      if (
        isExpectedError(error) &&
        error.code === "workflow.lineage_limit" &&
        attempt.hostCallsAudited !== true
      ) {
        attempt.hostCallsAudited = true;
        await this.#auditRefusal({
          step: attempt.step,
          call,
          errorCode: error.code,
        });
      }
      return { ok: false, error: forIsolate(error) };
    }
  }

  /**
   * The refusal of a call of `attempt` once it no longer holds
   * (`#requireCurrent`, audited once), or nothing while it holds: the one
   * check `AttemptHost` makes before each call and again as it returns.
   */
  async #leaseRefusal(
    attempt: StepAttempt,
    call: string
  ): Promise<Settled<never> | undefined> {
    if (this.#holds(attempt)) {
      return undefined;
    }
    return await settle(async (): Promise<never> => {
      await this.#requireCurrent(attempt, call);
      throw executionErrors.create("execution.stale_attempt");
    });
  }

  /**
   * Fails every call once the run's isolate was caught tampering
   * (`#refuseTampering`).
   */
  #requireUntampered(): void {
    if (this.#tampered !== undefined) {
      throw this.#tampered;
    }
  }

  /**
   * Refuses what only code that gets past the SDK in the run's isolate
   * asks for: a step its review doesn't show. The SDK never sends one for
   * a workflow whose review reads its steps (one whose steps can't be read
   * runs any step name, held to all its calls), so code that does has got
   * past it, or past what the review read, and may catch the refusal and
   * carry on. So it ends the run, whatever its code makes of it: the step
   * fails, every later call of this activation fails at once
   * (`#requireUntampered`), and the run fails with it (`tampered`).
   * Audited once per activation, which the run's failure ends.
   */
  /**
   * Refuses a step whose name the version's review doesn't show: a `do`,
   * a sleep or a decision's wait alike. The name is the isolate's to say,
   * so no code runs, and no wait is journaled, under a name of its own
   * making (one made of what the run read, which its history would show).
   * Caught or not, it ends the run (`#refuseTampering`). When the review
   * couldn't read the steps, every name may run (`stepReviewed`), and the
   * run's history names none of them.
   */
  async #requireStepReviewed(step: string): Promise<void> {
    if (!stepReviewed(this.#run.calls, step)) {
      const error = workflowErrors.create("workflow.step_not_reviewed");
      error.message = `Step "${step}" isn't one the review of this version shows: run steps only as the workflow's function writes them.`;
      await this.#refuseTampering(error, { step, call: null });
    }
  }

  async #refuseTampering(
    error: Error,
    { step, call }: { step: string | null; call: string | null }
  ): Promise<never> {
    if (this.#tampered === undefined) {
      this.#tampered = error;
      const refusal = forIsolate(error);
      this.#hooks.tampered(refusal);
      await this.#auditRefusal({
        step,
        call,
        errorCode: refusal.code ?? "workflow.invalid",
      });
    }
    throw error;
  }

  /**
   * Records a refusal of a run's call, or of its step, through the outbox.
   * One that can't be recorded is logged: refused all the same, and the
   * step or run fails with it, which is audited.
   */
  async #auditRefusal(refusal: {
    step: string | null;
    call: string | null;
    errorCode: string;
  }): Promise<void> {
    const { app, workflow, version, runId } = this.#run;
    const db = drizzle(this.#env.DB);
    try {
      await auditedBatch(this.#env, db, [
        outboxed(db, {
          actor: this.#actor,
          action: "workflow.call.refused",
          target: { type: "workflow_run", id: runId },
          detail: { app, workflow, version, ...refusal },
        }),
      ]);
    } catch (auditError) {
      log.error("workflow.call.audit_failed", {
        runId,
        step: refusal.step ?? undefined,
        call: refusal.call ?? undefined,
        errorCode: refusal.errorCode,
        ...errorFields(auditError),
      });
    }
  }

  /**
   * Refuses a call of `binding` (`APP` for the App's own server) that the
   * review of the run's version doesn't show: the step running now, and
   * the step whose attempt's host the call came through, must both be
   * ones whose code, as the review reads it, calls that binding. What the
   * review reads is only what the source says, and code can move a call
   * as it runs: a binding kept when a module loads, or a stub made in one
   * step and called in another, or code one step hands another. Each
   * refusal is audited, and fails both attempts (`StepAttempt.refused`).
   */
  async #requireReviewed(attempt: StepAttempt, binding: string): Promise<void> {
    const running = this.#live.at(-1) ?? attempt;
    // Once an attempt had a call refused, every later call of it fails
    // at once, allowed or not, and none is audited again: a loop of
    // refused calls can't flood the audit log.
    requireUnrefused(running);
    requireUnrefused(attempt);
    const unreviewed = [running, attempt].find(
      ({ step }) => !callReviewed(this.#run.calls, step, binding)
    );
    if (unreviewed === undefined) {
      return;
    }
    const error = workflowErrors.create("workflow.call_not_reviewed");
    error.message = `Step "${unreviewed.step}" called ${binding}, which the review of this version doesn't show it calling: call each binding only in the step's own function, where the review shows it.`;
    running.refused = error;
    attempt.refused = error;
    await this.#auditRefusal({
      step: unreviewed.step,
      call: binding,
      errorCode: "workflow.call_not_reviewed",
    });
    throw error;
  }

  /**
   * Calls `method` of a collection the run may read (`binding`, e.g.
   * `env.HANDBOOK.search(query)`) with `args`, only inside a step whose
   * code its review shows calling it (`#requireReviewed`). The collection's
   * stub checks and records the read as it does for any reader.
   */
  async #callCollection(
    attempt: StepAttempt,
    binding: unknown,
    method: unknown,
    args: unknown
  ): Promise<Settled<unknown>> {
    return await settle(async () => {
      this.#requireUntampered();
      await this.#requireCurrent(attempt, "collection");
      const { collections } = this.#run;
      const name = checked(z.string(), binding);
      const stub = Object.hasOwn(collections, name)
        ? collections[name]
        : undefined;
      if (stub === undefined) {
        throw workflowErrors.create("workflow.invalid");
      }
      const read = checked(collectionMethodSchema, method);
      const [first, second] = checked(z.array(z.unknown()).max(2), args);
      await this.#requireReviewed(attempt, name);
      await this.#requireCurrent(attempt, name);
      // The stub checks every argument, as it does one from an App.
      switch (read) {
        case "listDocuments": {
          return await stub.listDocuments(first);
        }
        case "getDocument": {
          return await stub.getDocument(first, second);
        }
        case "history": {
          return await stub.history(first, second);
        }
        case "backlinks": {
          return await stub.backlinks(first, second);
        }
        case "search": {
          return await stub.search(first, second);
        }
        case "read": {
          return await stub.read(first, second);
        }
        case "follow": {
          return await stub.follow(first);
        }
        default: {
          throw workflowErrors.create("workflow.invalid");
        }
      }
    });
  }

  /**
   * Calls an action on one of the run's connections (`binding`), with
   * `call` as a connection stub takes it: `[action, input, options]`, for
   * `attempt`'s step, with that step's key or none, from a step whose code
   * its review shows calling it (`#requireReviewed`).
   */
  async #callConnection(
    attempt: StepAttempt,
    binding: unknown,
    call: unknown
  ): Promise<Settled<unknown>> {
    return await settle(async () => {
      this.#requireUntampered();
      await this.#requireCurrent(attempt, "connection");
      const stepKey = this.#stepKeyOf(attempt);
      const { connections, authority } = this.#run;
      const name = checked(z.string(), binding);
      const grant = Object.hasOwn(connections, name)
        ? connections[name]
        : undefined;
      if (grant === undefined) {
        throw workflowErrors.create("workflow.invalid");
      }
      await this.#requireReviewed(attempt, name);
      await this.#requireCurrent(attempt, name);
      return await heldNoted(
        attempt,
        async () =>
          await runStubCall(
            this.#env,
            async (key) => {
              requireStepKey(key, stepKey);
              return await Promise.resolve({
                authority,
                // The capability expires with the attempt, and the call
                // goes to connect only if the attempt still holds then,
                // after the permission check and the signing.
                notAfter: attempt.deadline,
                stillAllowed: async () => {
                  await this.#requireCurrent(attempt, name);
                },
                // Its mail to the deployment's domain is stamped with
                // this run (mail-stamps.ts).
                stamping: { run: this.#run.runId, stepKey },
              });
            },
            grant,
            checked(z.array(z.unknown()), call)
          ),
        // Its key is the step's: an unknown outcome holds the step.
        true
      );
    });
  }

  /**
   * Calls a method of the run's own App (`env.APP.call(method, ...args)`)
   * for the person the run acts for, in workflow mode, only inside a step
   * whose code its review shows calling it (`#requireReviewed`, as `APP`).
   * The caller the method gets carries the step's key, the only one its
   * connection calls take (app-bindings.ts). Within one App no permission
   * is needed, but the person must still be there, and the run's version
   * must be one an admin approved: the method runs the App's current
   * version, as the person, whatever version the run is on
   * (`requireApprovedVersion`). The answer is plain
   * data (`callApp`), and whatever it holds of the App's data is covered by
   * the run's restricted mode, which is the App's (restricted.ts). The call
   * waits for its turn in the App, and its answer, no longer than the
   * attempt it comes from runs (`StepAttempt.deadline`); cut off then, it fails
   * as that attempt's timeout (`cutOffByAttempt`).
   */
  async #callApp(
    attempt: StepAttempt,
    method: unknown,
    args: unknown
  ): Promise<Settled<unknown>> {
    return await settle(async () => {
      this.#requireUntampered();
      await this.#requireCurrent(attempt, "APP");
      await this.#requireReviewed(attempt, "APP");
      attempt.calledApp = true;
      const idempotencyKey = this.#stepKeyOf(attempt);
      const caller: AppCallerInput = {
        userId: this.#run.authority.onBehalfOf,
        mode: "workflow",
        idempotencyKey,
        attempt: attempt.leaseId,
        fence: this.#fenceOf(attempt),
      };
      await this.#requirePerson();
      await requireApprovedVersion(this.#env, this.#run.app, this.#run.version);
      await this.#requireCurrent(attempt, "APP");
      // The App's own connection calls take the step's key: held, they
      // hold the step as the run's own do (`do` asks connect too).
      try {
        return await heldNoted(
          attempt,
          async () =>
            await this.#hooks.callApp(
              caller,
              String(method),
              checked(z.array(z.unknown()), args),
              attempt.deadline
            )
        );
      } catch (error) {
        throw cutOffByAttempt(attempt, error) ? attemptTimedOut() : error;
      }
    });
  }

  /**
   * Calls a public function of the run's own App's sealed release
   * (`env.APP.callFunction(reference, input)`), at the version the run is
   * pinned to, for the person the run acts for, as the run, only inside a
   * step whose code its review shows calling `APP` (`#requireReviewed`).
   * Its key is the step's key and the call's place among the attempt's
   * function calls (`StepAttempt.functionCalls`), counted as each call
   * comes in: two calls of one step never share a key, and a rerun of the
   * step (a retry, a replay, the run after a held side effect was
   * decided) whose code calls in the same order makes the same calls, so
   * its mutations' receipts and its resource requests' keys are the same.
   * As for an action's own requests (`runAction`), calls made at once
   * count in the order they come. Its every protected step (its start,
   * each commit, each resource request) is admitted only while `attempt`
   * still holds its lease (`runInvocationFor`). A side effect connect
   * held for the person holds the step, whatever App code makes of the
   * refusal. Answers what the function answered or why it failed, as data
   * (`OperationResult`).
   */
  async #callFunction(
    attempt: StepAttempt,
    reference: unknown,
    input: unknown
  ): Promise<Settled<unknown>> {
    // Counted before anything is awaited, in the order calls come.
    attempt.functionCalls += 1;
    const place = attempt.functionCalls;
    return await settle(async () => {
      this.#requireUntampered();
      await this.#requireCurrent(attempt, "APP");
      await this.#requireReviewed(attempt, "APP");
      await this.#requirePerson();
      const stepKey = this.#stepKeyOf(attempt);
      return await this.#hooks.callFunction(
        {
          run: this.#run,
          requestId: crypto.randomUUID(),
          deadline: attempt.deadline,
          stillCurrent: async () => {
            await this.#requireCurrent(attempt, "APP");
          },
          requireHolds: () => {
            if (!this.#holds(attempt)) {
              // Audited once per attempt, as any stale call is; the call
              // is refused here, with nothing awaited.
              void this.#leaseRefusal(attempt, "APP");
              throw executionErrors.create("execution.stale_attempt");
            }
          },
          held: (key) => {
            attempt.held = true;
            if (
              attempt.heldKeys.length < heldKeysKept &&
              !attempt.heldKeys.includes(key)
            ) {
              attempt.heldKeys.push(key);
            }
          },
        },
        reference,
        input,
        // Within what a submission key may be, whatever the step's name.
        `step:${await sha256Hex(canonicalJson([stepKey, place]))}`
      );
    });
  }

  /**
   * Calls export `method` of another App, by the run's permission on its
   * exports (`binding`), with `input` (`env.CRM.call(method, input)`),
   * only inside a step whose code its review shows calling that binding
   * (`#requireReviewed`), for the person the run acts for (app-calls.ts).
   * The called App's method gets the step's key on its caller, the only
   * one its connection calls take, so a side effect it holds holds the
   * step as the run's own would.
   */
  async #callExport(
    attempt: StepAttempt,
    binding: unknown,
    method: unknown,
    input: unknown
  ): Promise<Settled<unknown>> {
    return await settle(async () => {
      this.#requireUntampered();
      await this.#requireCurrent(attempt, "export");
      const idempotencyKey = this.#stepKeyOf(attempt);
      const { apps, authority, app } = this.#run;
      const name = checked(z.string(), binding);
      const grant = Object.hasOwn(apps, name) ? apps[name] : undefined;
      if (grant === undefined) {
        throw workflowErrors.create("workflow.invalid");
      }
      await this.#requireReviewed(attempt, name);
      attempt.calledApp = true;
      await this.#requireCurrent(attempt, name);
      return await heldNoted(
        attempt,
        async () =>
          await callExport(
            this.#env,
            {
              authority,
              idempotencyKey,
              attempt: attempt.leaseId,
              fence: this.#fenceOf(attempt),
              path: {
                chain: [app],
                // A run holds no App's turn while it waits for one.
                holding: [],
                // The called App's own limit, and no later than the
                // attempt the call comes from.
                deadline: attempt.deadline,
                readOnly: false,
              },
              actor: this.#actor,
            },
            grant,
            method,
            input
          )
      );
    });
  }

  /**
   * Opens this run's decision for a step, inside that step, and answers
   * its ID and deadline; the same step gets the same decision again, so
   * opening it again opens nothing new (src/decisions/).
   */
  async #openDecision(
    attempt: StepAttempt,
    request: unknown
  ): Promise<Settled<{ decision: string; deadline: number }>> {
    return await settle(async () => {
      this.#requireUntampered();
      await this.#requireCurrent(attempt, "decision");
      requireUnrefused(attempt);
      const { step, from, description, timeout } = checked(
        decisionSchema,
        request
      );
      return await openDecision(this.#env, this.#run, {
        step,
        from,
        description,
        timeout,
      });
    });
  }

  /**
   * The people one of this run's open decisions asks now, each with the
   * decision's link, inside a step (the one that asks them).
   */
  async #decisionRecipients(
    attempt: StepAttempt,
    decision: unknown,
    reminder: unknown
  ): Promise<Settled<DecisionRecipient[]>> {
    return await settle(async () => {
      this.#requireUntampered();
      await this.#requireCurrent(attempt, "decision");
      requireUnrefused(attempt);
      return await decisionRecipients(
        this.#env,
        this.#run,
        checked(identifierSchema, decision),
        checked(z.boolean(), reminder),
        async () => {
          await this.#requireCurrent(attempt, "decision");
        }
      );
    });
  }

  /**
   * Waits up to `timeout` for an answer to one of this run's decisions,
   * and answers how it stands then, read from the decision itself: the
   * event that wakes the run carries nothing it takes. With `last`, a
   * decision still open is closed, timed out, unless an answer lands
   * first. An answer that came before the wait began is taken at once.
   * A wake that finds nothing answered (an event of the decision's type
   * sent by anyone else) ends nothing: the run looks, and waits again for
   * the time it had left.
   */
  async waitForDecision(
    name: unknown,
    options: unknown
  ): Promise<Settled<DecisionOutcome>> {
    return await settle(async () => {
      this.#requireUntampered();
      const step = checked(stepNameSchema, name);
      await this.#requireStepReviewed(step);
      const { decision, timeout, last } = checked(decisionWaitSchema, options);
      // Whether it was answered when the run looked, and when that was:
      // recorded, so every replay decides as the first activation did
      // whether to wait, and for how long. The engine journals a wait's
      // timeout when it is first reached, and stops a run whose replay
      // asks for another (or skips a wait it holds).
      const prefix = `${waitStepPrefix}${await waitKeyOf(step)}`;
      const look = async (lookStep: string) =>
        reachedSchema.parse(
          await this.#step.do(lookStep, {}, async () => {
            const at = Date.now();
            const { answered } = await decisionOutcome(
              this.#env,
              this.#run,
              decision,
              false
            );
            return { at, answered };
          })
        );
      const reached = await look(`${prefix}:reached`);
      // The SDK worked `timeout` out from when it asked, but a pause or a
      // restart may have outlasted that: so never wait past the decision's
      // deadline, as its row has it, from when the wait was first reached.
      // Once that has passed, the decision is closed as timed out at once,
      // so a reminder that follows asks nobody.
      const deadline = await decisionDeadline(this.#env, this.#run, decision);
      const end = Math.min(reached.at + timeout, deadline);
      let seen = reached;
      for (let round = 0; !seen.answered && seen.at < end; round += 1) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- one wait at a time
          await this.#step.waitForEvent(
            round === 0 ? step : `${prefix}:again:${round}`,
            { type: decisionEventType(decision), timeout: end - seen.at }
          );
        } catch (error) {
          if (!isTimeout(error)) {
            throw error;
          }
          break;
        }
        // oxlint-disable-next-line no-await-in-loop -- one look per wake
        seen = await look(`${prefix}:woken:${round}`);
      }
      // Recorded too: an answer that comes after this can't change what a
      // replay of the run hears it ended with.
      return outcomeSchema.parse(
        await this.#step.do(
          `${prefix}:outcome`,
          {},
          async () =>
            await decisionOutcome(
              this.#env,
              this.#run,
              decision,
              last || Date.now() >= deadline
            )
        )
      );
    });
  }

  /**
   * The content of attachment `index` of a message an email trigger kept
   * for the run's App (`stored`, as the run's input names it), only inside
   * a step, for a person who is still there (kept-email.ts). Checked
   * against the run's own App, never one the isolate names: another App's
   * message is found as none. Every call is audited as a read, whatever
   * refuses it (outside a step, a name or index that isn't
   * one), with the name and index as sent. An attachment is handed on,
   * and a refusal answered, only once it's recorded: one that can't be
   * recorded fails as `internal.unexpected`, to be tried again. A step
   * attempt parses each message it reads once, however many of its
   * attachments it reads; a fetch that fails is tried again on its next
   * read. `stored: null` (a message that isn't kept) is refused with
   * `workflow.attachment_not_found`.
   */
  async #readAttachment(
    attempt: StepAttempt,
    stored: unknown,
    index: unknown
  ): Promise<Settled<Uint8Array>> {
    return await settle(async () => {
      const { step } = attempt;
      const sent = {
        step,
        message: typeof stored === "string" ? stored.slice(0, 256) : null,
        index:
          typeof index === "number" && Number.isFinite(index) ? index : null,
      };
      let content: Uint8Array;
      try {
        this.#requireUntampered();
        await this.#requireCurrent(attempt, "attachment");
        requireUnrefused(attempt);
        await this.#requirePerson();
        // A message that isn't kept names nothing to read.
        if (stored === null) {
          throw workflowErrors.create("workflow.attachment_not_found");
        }
        const message = checked(storedEmailSchema, stored);
        const at = checked(inboundEmailIndexSchema, index);
        // Only a message read and parsed is kept for the attempt's next
        // read: a fetch that failed is tried again.
        attempt.keptMessages ??= new Map();
        let kept = attempt.keptMessages.get(message);
        if (kept === undefined) {
          kept = await keptMessage(this.#env, this.#run.app, message);
          attempt.keptMessages.set(message, kept);
        }
        content = attachmentOf(kept, at);
        await this.#requireCurrent(attempt, "attachment");
      } catch (error) {
        const errorCode = isExpectedError(error)
          ? error.code
          : "internal.unexpected";
        // A stale attempt's refusal is audited once per attempt, as a
        // refused call (`#requireCurrent`): a loop of late reads can't
        // flood the audit log.
        if (errorCode === "execution.stale_attempt") {
          throw error;
        }
        try {
          await this.#auditRead({ ...sent, errorCode });
        } catch (auditError) {
          // No refusal goes unrecorded: the call fails as one that can be
          // tried again, and the refusal it would have been is logged.
          log.error("workflow.email.audit_failed", {
            runId: this.#run.runId,
            refusedWith: errorCode,
            ...errorFields(auditError),
          });
          throw auditError;
        }
        throw error;
      }
      // Recorded, and handed on, only while its run goes on: one cancelled
      // meanwhile gets nothing (`AttemptHost` checks the attempt again as
      // the call returns).
      if (!(await this.#auditRead({ ...sent, bytes: content.byteLength }))) {
        throw executionErrors.create("execution.stale_attempt");
      }
      return content;
    });
  }

  /**
   * Records a read of a kept message's attachment, through the outbox. A
   * read that hands the attachment on (`bytes`) is recorded only while the
   * run is neither cancelled nor ended, as the write finds it; whether it
   * was. A refusal is always recorded.
   */
  async #auditRead(read: {
    step: string | null;
    message: string | null;
    index: number | null;
    bytes?: number;
    errorCode?: string;
  }): Promise<boolean> {
    const { app, workflow, version, runId } = this.#run;
    const db = drizzle(this.#env.DB);
    const entry: AuditEntry = {
      actor: this.#actor,
      action: "workflow.email.read",
      target: { type: "workflow_run", id: runId },
      detail: {
        app,
        workflow,
        version,
        step: read.step,
        message: read.message,
        attachment: read.index,
        ...(read.bytes === undefined ? {} : { bytes: read.bytes }),
        ...(read.errorCode === undefined ? {} : { errorCode: read.errorCode }),
      },
    };
    if (read.bytes === undefined) {
      await auditedBatch(this.#env, db, [outboxed(db, entry)]);
      return true;
    }
    const live = sql`EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${workflowRuns.id} = ${runId} AND ${workflowRuns.cancelRequestedAt} IS NULL AND ${workflowRuns.endedAt} IS NULL)`;
    const [, still] = await auditedBatch(this.#env, db, [
      outboxedWhere(db, entry, live),
      db
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(and(eq(workflowRuns.id, runId), live)),
    ]);
    return still.length > 0;
  }
}
