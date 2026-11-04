import { providerTroubles } from "@grasp-os/shared/ai-providers";
import type { ProviderTrouble } from "@grasp-os/shared/ai-providers";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { connectErrors } from "@grasp-os/shared/connect";
import { toHex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { identifierSchema } from "@grasp-os/shared/ids";
import type { RunId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";
import type { ModelErrorCode } from "@grasp-os/shared/models";
import type { Authority } from "@grasp-os/shared/permissions";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import {
  coreStepPrefix,
  executionErrors,
  isRetryable,
  paramsStep,
  maxAttemptTimeoutMs,
  maxStepRetries,
  stepIdempotencyKey,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import type { InputShape, StepUse } from "@grasp-os/shared/workflows";
import type {
  EventMatch,
  WorkflowDuration,
  WorkflowStepConfig,
} from "@grasp-os/workerflow/contracts";
import { namedError } from "@grasp-os/workerflow/errors";
import type { AttemptLease } from "@grasp-os/workerflow/run";
import { RpcTarget } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import type { Email } from "postal-mime";
import { z } from "zod";

import { auditedBatch, outboxed } from "../audit-outbox.ts";
import { forSandbox } from "../bindings.ts";
import {
  decisionDeadline,
  decisionEventType,
  decisionOutcome,
} from "../decisions/decisions.ts";
import type { DecisionOutcome, DecisionRun } from "../decisions/decisions.ts";
import { askAgainMs } from "./admission.ts";
import { aiWaitEnded, aiWaitStarted, aiWakeType } from "./ai-waits.ts";
import type { AiWait, AiWaitRun } from "./ai-waits.ts";
import type { AttemptHost } from "./attempt-host.ts";
import type { Settled, StepError } from "./code.ts";
import { storedEventSchema } from "./event-envelopes.ts";
import { quotaLimits } from "./quotas.ts";
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
 * The run a host serves, as the dispatcher loaded it: what every kind of
 * run has (`RunKind`). What its code may call is its kind's.
 */
export interface HostedRun {
  runId: RunId;
  /**
   * The root of its lineage, for a run another run started: from its
   * row, read on every load, so a restart or replay keeps it. None for a
   * run that is its own root.
   */
  rootRunId?: RunId;
  /**
   * The run its work is charged to, for a run of another App than its
   * lineage root's, or of the root's App under another App's run, or of
   * the root's App under a run of that App charged to either, which it
   * inherits (quotas.ts, `accountClaimed`):
   * from its row, as the root is. None for a run charged to its lineage's
   * own.
   */
  accountRunId?: RunId;
  /** Who the run acts for in this execution. */
  authority: Authority;
  /**
   * Whose person share its workflow attempts and model requests take, from
   * its row (dispatcher.ts, `admissionSubjectOf`): who started it, its
   * account's (its lineage root's, or its App's first run in the lineage),
   * or its App's triggers' (`trigger:<app>`). Not who it
   * acts for, which is the App's owner for a run nobody started.
   */
  shareSubject: string;
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
  /** Sleeps until `timestamp`, in ms since the epoch: at once once past. */
  sleepUntil: (name: string, timestamp: number) => Promise<void>;
  waitForEvent: (
    name: string,
    options: { type: string; timeout: WorkflowDuration }
  ) => Promise<{ payload: unknown }>;
  /**
   * Waits until `until`, in ms since the epoch, for the oldest event of the
   * run's inbox that matches an entry of `match`: its type, and every
   * attribute it names (@grasp-os/workerflow's `waitForMatch`).
   */
  waitForMatch: (
    name: string,
    options: { match: readonly EventMatch[]; until: number }
  ) => Promise<{ payload: unknown; timestamp: Date }>;
  /**
   * Says the run busy outside the step API until the function returned is
   * called (workerflow's `step.busy`): the engine doesn't suspend it
   * meanwhile. The engine's step always can; a test's stand-in for it,
   * which never suspends, needn't.
   */
  busy?: () => () => void;
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
export interface StepAttempt {
  /**
   * Its lease ID, drawn here and never sent to the isolate: what tells this
   * attempt from another of the same step.
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
   * When the engine gives up on it, by the step's timeout: none of its
   * calls acts after it.
   */
  deadline: number;
  /** Whether its function has returned: its host acts no more. */
  over: boolean;
  /** Whether a call of it was refused as stale, and audited so, already. */
  staleAudited?: boolean;
  step: string;
  held: boolean;
  /**
   * What its model call's provider showed when the call failed on the
   * organization's own key (`aiWaitOf`): it refused the key, isn't
   * answering, or is limiting requests. The step then waits for it
   * (`keyMarkerOf`), whatever its code made of the failure.
   */
  aiTrouble?: AiWait;
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
   * call's place, which its key is derived from (app-run.ts, `#callFunction`).
   */
  functionCalls: number;
  /**
   * The first of its calls refused as one its review doesn't show, or
   * made from another attempt's code that had one refused: the attempt
   * fails with it, whatever its code made of the refusal.
   */
  refused?: Error;
  /**
   * What its kind failed it with for good (a sealed run's later attempt
   * of a step whose call went out once): the step fails with it, never
   * retried, whatever its code, and whatever its code made of it.
   */
  final?: Error;
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
 * actions); or its model call failed on the organization's own AI
 * provider key (`ai_provider`, `keyRound`).
 */
export type WaitReason =
  | { reason: "held" }
  | { reason: "outcome_unknown" }
  | ({ reason: "ai_provider" } & AiWait);

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

/** The field of a step's result that says its lineage was busy (`busyMarker`). */
const busyField = `${coreStepPrefix}busy`;

/** The field of a busy step's result that says how long a step may wait. */
const busyMaxField = `${coreStepPrefix}busyMaxMs`;

/**
 * What an attempt of a step answers when its run lineage's active time is
 * all held by attempts under way (quotas.ts, `workflow.lineage_busy`), or
 * no slot of the attempts running at once is free for it (admission.ts,
 * `workflow.queued`): recorded as the step's result, with
 * the seconds to wait, so the run waits durably, holding no compute, and
 * runs the step again under a step of its own, as a held step does. The
 * refusal spends none of the step's attempts, and its wait none of the
 * run's steps (`uncountedWaitStep`): the load is others' as much as the
 * run's. Its rounds wait a day in all at most (`workflowQueuedStepMs`,
 * `LoadWait`), then fail (`workflow.queue_timeout`). Workflow code can't
 * return it (`do` refuses it).
 */
export const busyMarker = ({ busyFor, maxWaitMs }: Busy) => ({
  [busyField]: busyFor,
  [busyMaxField]: maxWaitMs,
});

/**
 * An attempt refused for now: the seconds to wait, and how long a step
 * may wait in all, as the quota limits said then.
 */
export interface Busy {
  busyFor: number;
  maxWaitMs: number;
}

/** The field of a step's result that says its AI provider failed it (`keyMarkerOf`). */
const keyField = `${coreStepPrefix}aiWait`;

/** What a step waiting for its AI provider recorded (`keyMarkerOf`). */
const aiWaitRecordSchema = z.object({
  at: z.number(),
  provider: z.string(),
  trouble: z.enum(providerTroubles),
});

/**
 * What an attempt of a step answers when its model call failed on the
 * organization's own key for what its provider showed (`AiWait`), with
 * when: recorded as the step's result, so the run waits durably, holding
 * no compute, and runs the step again once calls work (`keyRound`),
 * rather than spend the step's retries, or fail the run, on a provider
 * that refuses the key, isn't answering or limits requests. Workflow code
 * can't return it (`do` refuses it).
 */
export const keyMarkerOf = (at: number, { provider, trouble }: AiWait) => ({
  [keyField]: { at, provider, trouble },
});

/** The schema of what the gateway tells of a provider's trouble (models.ts, `troubleError`). */
const aiWaitSchema = z.object({
  provider: z.string(),
  trouble: z.enum(providerTroubles),
});

/**
 * What a model call's failure tells of its provider, when it failed on
 * the organization's own key for what the provider showed; none else.
 */
export const aiWaitOf = (error: unknown): AiWait | undefined =>
  isExpectedError(error) && modelErrors.codeOf(error) !== undefined
    ? aiWaitSchema.safeParse(error.details).data
    : undefined;

/**
 * `aiWaitOf`, for a call tried once: only when the gateway saw that it
 * provably billed nothing (models.ts, `provablyUnbilled`), so running it
 * again can't send anything twice that may have been taken on.
 */
export const unbilledAiWaitOf = (error: unknown): AiWait | undefined =>
  isExpectedError(error) && error.details?.unbilled === true
    ? aiWaitOf(error)
    : undefined;

/** Whether `value` is one of core's markers, which workflow code can't return. */
export const isCoreMarker = (value: unknown): boolean =>
  isHeldMarker(value) ||
  (typeof value === "object" &&
    value !== null &&
    (Object.hasOwn(value, busyField) || Object.hasOwn(value, keyField)));

const busyRecordSchema = z.object({
  busyFor: z.number(),
  maxWaitMs: z.number(),
});

/**
 * One of core's markers, as a step's recorded result says it: a step held
 * for its person (`heldMarkerOf`), on an unknown outcome or not, with the
 * keys it waits on; or refused for load (`busyMarker`), with the seconds
 * to wait and how long a step may wait in all; or its model call failed for what its AI provider showed (`keyMarkerOf`), and when.
 */
export type CoreMarker =
  | { kind: "held"; keys: string[]; unknown: boolean }
  | ({ kind: "key" } & z.infer<typeof aiWaitRecordSchema>)
  | ({ kind: "busy" } & z.infer<typeof busyRecordSchema>);

/**
 * The marker `value` is, as recorded; none when it is a step's own result.
 * A marker core recorded always reads: one that doesn't is refused.
 */
export const markerOf = (value: unknown): CoreMarker | undefined => {
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
  if (Object.hasOwn(value, keyField)) {
    return { kind: "key", ...aiWaitRecordSchema.parse(field(keyField)) };
  }
  return {
    kind: "busy",
    ...busyRecordSchema.parse({
      busyFor: field(busyField),
      maxWaitMs: field(busyMaxField),
    }),
  };
};

/**
 * An admission that admits every attempt, with nothing to settle: a test's
 * host of its own, and a run an App's test started (fixture-runs.ts),
 * which counts nothing against the organization's quotas.
 */
export const unadmitted: AttemptAdmission = {
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
 * seconds to wait, at least one, and how long a step may wait in all.
 */
export const busyOf = (error: unknown): Busy | undefined => {
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
  return { busyFor, maxWaitMs };
};

/** What a step waited for load before an attempt (`#admit`). */
interface WaitedSoFar {
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
export interface LoadWait {
  rounds: number;
  waitedMs: number;
  maxWaitMs: number;
  sleepMs: number;
}

/** No wait for load yet. */
export const loadWaitStart: LoadWait = {
  rounds: 0,
  waitedMs: 0,
  maxWaitMs: 0,
  sleepMs: 0,
};

/**
 * The step's wait for load once its attempt answered `marker`: after a
 * hold or a refused key, none (an attempt was admitted); after a refusal for load, one
 * round more, sleeping as long as `askAgainMs` says, added to what its
 * rounds wait in all. A round left nothing to sleep (`sleepMs` 0) has
 * waited as long as a step may.
 */
export const loadWaitAfter = (wait: LoadWait, marker: CoreMarker): LoadWait => {
  if (marker.kind === "held" || marker.kind === "key") {
    return loadWaitStart;
  }
  const sleepMs = askAgainMs({
    waited: wait.rounds,
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
 * (`maxWaitMs`, the quota limits' `workflowQueuedStepMs`): no retry of
 * its own is spent, and none tried.
 */
export const queueTimedOut = (step: string, maxWaitMs: number): StepError => ({
  name: "Error",
  code: "workflow.queue_timeout",
  message: `Step "${step}" waited its turn to run for ${String(Math.round(maxWaitMs / 1000))} seconds, as long as a step may wait`,
});

/** Longest step name taken: a key and a decision's part fit well within. */
const maxStepName = 256;

/** Control characters, which the engine refuses in a step's name. */
const controlCharacter = /\p{Cc}/u;

export const stepNameSchema = z
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

export const milliseconds = z
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

/** A time, in ms since the epoch, as a sleep until it takes it. */
const timestampSchema = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

/** What an event wait recorded when it was first reached. */
const reachedAtSchema = z.strictObject({ at: timestampSchema });

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

/** What a decision's wait step asks: which decision, how long, whether last. */
export type DecisionWait = z.infer<typeof decisionWaitSchema>;

/** Where a test run's decisions are kept (`RunKind.decisionsKept`). */
export interface DecisionsKept {
  outcome: (decision: string, close: boolean) => Promise<DecisionOutcome>;
  deadline: (decision: string) => Promise<number>;
  lookMs: number;
}

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
export const checked = <Schema extends z.ZodType>(
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
const stepConfig = (
  { retries: declared, timeout }: z.output<typeof doOptionsSchema>,
  /** The kind's own, in place of the step's (`RunKind.limitsOf`). */
  limits: StepLimits = {}
): WorkflowStepConfig & { retries: StepRetries } => {
  const retries = limits.retries ?? declared;
  return {
    retries: {
      limit: retries?.limit ?? defaultRetryLimit,
      delay: retries?.delay ?? defaultRetryDelayMs,
      backoff: retries?.backoff ?? "exponential",
    },
    timeout: Math.min(
      timeout ?? maxAttemptTimeoutMs,
      limits.timeout ?? maxAttemptTimeoutMs
    ),
  };
};

/**
 * How a wait or an attempt that ran out of time ends in the engine: a
 * `WorkflowTimeoutError` ("Execution timed out after 500ms"), recognised
 * by its message too, which survives every way to core.
 */
const timedOut = /^(?:WorkflowTimeoutError: )?Execution timed out\b/u;
export const isTimeout = (error: unknown): boolean =>
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
export const maxWaits = 15;

/**
 * The longest wait between checks of a call of unknown outcome, in first
 * waits: an hour, so its 7 days take some 180 checks, a bounded journal.
 */
const maxUnknownWaits = 60;

/**
 * What a round of a step's wait waits for (`#waitBefore`), or, for a
 * catch's retry of it, decides and sleeps before (`#retried`).
 */
type WaitKind = "busy" | "held" | "unknown" | "key" | "retry";

/**
 * The prefix of the steps of round `round` of the wait of the step keyed
 * `key` (`waitKeyOf`) for `kind`: the one builder of a wait's step names,
 * which `uncountedWaitStep` reads back.
 */
export const waitStep = (key: string, kind: WaitKind, round: number): string =>
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
 * - a wait for its AI provider (`key`): its record, its wait,
 *   the step's run again and its end, bounded by its hold
 *   (`aiKeyHoldMsOf`) and the timed tries between (`keyRound`): the key is
 *   the organization's to replace, not the run's code;
 * - a decision's wait again, and its look, after a wake that answered
 *   nothing (`again:<round>`, `woken:<round>`, `waitForDecision`): an
 *   event of its type sent by someone else causes them, not the run's
 *   code, bounded by the engine's inbox (`maxInboxEvents`); for a test
 *   run (`RunKind.decisionsKept`), its own looks every so often too,
 *   bounded by its decision's deadline and its test's lifetime.
 */
const uncountedWaitStep =
  /^\$grasp:wait:[0-9a-f]{16}:(?:busy:\d+(?::|$)|key:\d+(?::|$)|held:\d+:waiting:|unknown:[1-9]\d*:|again:[1-9]\d*$|woken:\d+$)/u;

/**
 * A wait's step that runs the step it holds again (`#waitBefore`), of any
 * kind: its key names that step (`waitKeyOf`).
 */
const waitRunStep =
  /^\$grasp:wait:(?<key>[0-9a-f]{16}):(?:busy|held|unknown|key):\d+:run$/u;

/**
 * Tries of one check whether a held side effect still waits, after the
 * first: a connect that fails that often in a row fails the step.
 */
export const heldCheckRetries = 5;

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
export const waitMsOf = (env: Env): number => {
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
 * How long a step waits, from its model call's first refusal for the
 * organization's AI provider key, for a key that works: 7 days, then it
 * fails with `model.provider_key_failed`. Tests shorten it.
 */
const aiKeyHoldMs = 7 * 24 * 60 * 60 * 1000;

const aiKeyHoldMsOf = (env: Env): number => {
  const set = Number(env.WORKFLOW_AI_KEY_HOLD_MS);
  return Number.isInteger(set) && set > 0 && set < aiKeyHoldMs
    ? set
    : aiKeyHoldMs;
};

/** A step's wait for its AI provider, over its rounds in a row. */
export interface KeyWait {
  /** When its call first failed so; none while it isn't held. */
  since: number | undefined;
  /** What the provider showed last round, recorded; none before. */
  last: ProviderTrouble | undefined;
  /** Its rounds in a row so far. */
  rounds: number;
  /** The last round's prefix (`waitStep`), which its end is named after. */
  prefix: string;
}

/** No wait for a key yet. */
export const keyWaitStart = (): KeyWait => ({
  since: undefined,
  last: undefined,
  rounds: 0,
  prefix: "",
});

/** The code a step fails with once it waited as long as it may, by what its provider showed. */
const troubleCodes = {
  refused: "model.provider_key_failed",
  not_answering: "model.provider_unavailable",
  limiting: "model.rate_limited",
} as const satisfies Record<ProviderTrouble, ModelErrorCode>;

/**
 * The failure of step `step`, which waited for its AI provider as long as
 * a step may (`aiKeyHoldMsOf`), by what the provider showed last.
 */
export const keyTimedOut = (
  step: string,
  trouble: ProviderTrouble
): StepError => {
  const code = troubleCodes[trouble];
  return {
    name: "Error",
    code,
    message: `Step "${step}" waited for its AI provider as long as a step may. ${modelErrors.create(code).message}`,
  };
};

/**
 * Round `prefix` of a step's wait for its AI provider, its
 * attempt having answered `marker`: past its hold (`aiKeyHoldMsOf`, from
 * the first failure, as the markers recorded it), `"timed_out"`; else the
 * wait recorded on its first round and whenever what the provider shows
 * changes (`started`, in a step of its own), then a durable wait that
 * replacing a key ends (`aiWakeType`, ai-waits.ts), or else the next timed
 * try: a minute first (`waitMsOf`), doubling up to 15 minutes, for a
 * provider that answers again or lifts its limit. Read off the recorded
 * markers alone, so every replay waits the same.
 */
export const keyRound = async (
  run: Pick<RunStep, "do" | "waitForEvent">,
  env: Env,
  prefix: string,
  marker: { at: number } & AiWait,
  wait: KeyWait,
  started: (since: number, aiWait: AiWait) => Promise<void>
): Promise<"timed_out" | undefined> => {
  wait.since ??= marker.at;
  const { since } = wait;
  wait.rounds += 1;
  wait.prefix = prefix;
  const ends = since + aiKeyHoldMsOf(env);
  if (marker.at >= ends) {
    return "timed_out";
  }
  if (wait.last !== marker.trouble) {
    wait.last = marker.trouble;
    const { provider, trouble } = marker;
    await run.do(`${prefix}:waiting`, {}, async () => {
      await started(since, { provider, trouble });
      return null;
    });
  }
  const first = waitMsOf(env);
  try {
    await run.waitForEvent(prefix, {
      type: aiWakeType,
      timeout: Math.min(
        first * 2 ** (wait.rounds - 1),
        first * maxWaits,
        ends - marker.at
      ),
    });
  } catch (error) {
    if (!isTimeout(error)) {
      throw error;
    }
  }
  return undefined;
};

/**
 * The most an AI step waits after a full share of the model requests in
 * flight or a provider's rate turned it away, before its attempt fails and
 * the engine retries it at the step's own delay: so a step with a tight
 * retry config can't loop on the gateway. The refusal's
 * `retryAfterSeconds` is advisory, and steps don't wait longer: their
 * retries are theirs to set.
 */
const throttledWaitMs = 15_000;

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
 * The attempts the quota limits admit are its admission's to say
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

/**
 * The steps a run may take (spec 18.1's logical steps, 1000 a run), as
 * the quota limits have them: so a run whose code loops on steps without
 * end can't journal without bound. Counted over each activation's replay
 * of the run's journal (`countedStep`), so a restart, a retry or a new
 * activation counts every step the run took before. Every attempt of a
 * step is held to them again as it is admitted (quotas.ts,
 * `admitAttempt`).
 */
export const stepLimitOf = (env: Env): number => quotaLimits(env).workflowSteps;

/**
 * The model calls a run's lineage may make, as the quota limits have them
 * (`lineageModelRequests`): the ceiling a run's host holds its model calls
 * to (`maxModelCalls`). Every model request of a run's lineage is held to
 * them again as it is sent (models.ts, `scopesNowOf`).
 */
export const modelCallLimitOf = (env: Env): number =>
  quotaLimits(env).lineageModelRequests;

/**
 * `step`, counting the run's own steps (`stepLimit` is the allowance
 * of them) and refusing one past it, as a failure of that step.
 * Core's own steps (`$grasp:…`, but for a wait's, which the run's code
 * causes without bound: {@link waitStepPrefix}) and the SDK's first
 * `$params` step are outside the allowance: a run of one step fits an
 * allowance of one. So are the steps of a wait that aren't the run's own
 * (`uncountedWaitStep`),
 * and a step run again after one has no place of its own: it is the step
 * that already took its place, which its attempts are told
 * (`placeOfRunAgain`), so the policy's steps hold every round of it. A
 * catch's retry of a step (`#retried`) is the run's own, as its workflow
 * chose it: three steps a round (its decision, its sleep and the step's
 * run again), each a place of its own. Counted over every replay, so each
 * step keeps its place.
 */
export const countedStep = (step: RunStep, stepLimit: number): RunStep => {
  let own = 0;
  let params = false;
  /** Each of the run's own steps' place, by name, over every replay. */
  const places = new Map<string, number>();
  /** Each own step's wait key (`waitKeyOf`), worked out once. */
  const keys = new Map<string, string>();
  /**
   * The place of the step a wait's run again (`waitRunStep`) runs, which
   * takes none of its own: the step's own, as its first attempt had it,
   * so every round's attempt is admitted against the policy's steps as
   * it is then, whatever limit this activation counts by.
   */
  const placeOfRunAgain = async (name: string): Promise<number | undefined> => {
    const key = waitRunStep.exec(name)?.groups?.key;
    if (key === undefined) {
      return undefined;
    }
    for (const [ownName, place] of places) {
      // oxlint-disable-next-line no-await-in-loop -- each key once, cached
      const ownKey = keys.get(ownName) ?? (await waitKeyOf(ownName));
      keys.set(ownName, ownKey);
      if (ownKey === key) {
        return place;
      }
    }
    return undefined;
  };
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
    if (!places.has(name)) {
      places.set(name, own);
    }
    return own;
  };
  return {
    do: async (name, config, fn) => {
      const ordinal = take(name) ?? (await placeOfRunAgain(name));
      if (ordinal === undefined) {
        return await step.do(name, config, fn);
      }
      // Each attempt is told its step's place, for its admission against
      // the limits as they are then (quotas.ts, `admitAttempt`).
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
    sleepUntil: async (name, timestamp) => {
      take(name);
      await step.sleepUntil(name, timestamp);
    },
    waitForEvent: async (name, options) => {
      take(name);
      return await step.waitForEvent(name, options);
    },
    waitForMatch: async (name, options) => {
      take(name);
      return await step.waitForMatch(name, options);
    },
    ...(step.busy === undefined ? {} : { busy: step.busy }),
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
 * A CPU-limit kill as the Loader throws it (`isCpuLimitKill`): for a call
 * into an isolate already so stopped, and for the on-prem sandbox's `cpu`
 * verdict (code.ts), so both go the way the Loader's own kill does.
 */
export const cpuLimitKill = (cause?: unknown): Error =>
  new Error("Worker exceeded CPU time limit.", { cause });

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

/**
 * What a step failed with as the engine journaled it (`forIsolate`), a
 * step's timeout included, however the engine named it: so a sealed run
 * reads a failure the same fresh and replayed.
 */
const journaledFailure = (error: unknown): StepError =>
  error instanceof Error && error.name === "TimeoutError"
    ? { name: "TimeoutError", message: "The step ran out of time." }
    : forIsolate(error);

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
export const toStepError = (error: StepError): Error =>
  namedError(
    isRetryable(error) ? error.name : "NonRetryableError",
    error.message,
    error.code
  );

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
   * Admits a step's attempt against its run lineage's quotas before its
   * code runs (quotas.ts, `admitAttempt`), throwing the refusal, or
   * answering what settles the attempt once its function has returned.
   * The dispatcher's always does; none only for a test's host of its own.
   */
  admitAttempt?: (attempt: QuotaAttempt) => Promise<AttemptAdmission>;
}

/**
 * What a run of one kind may do on the host (`RunHost`), and how the host
 * names it: the host runs any kind's steps, waits, holds and retries alike,
 * and leaves to its kind which steps it may run, who must still be there,
 * what its attempts' code may call, and the records that name the run.
 * An App's run is one kind (app-run.ts).
 */
export interface RunKind {
  /** The run, as every kind has it. */
  readonly run: HostedRun;
  /** Who the run is in its steps' audit entries, on what, and what each carries. */
  readonly audit: Required<Pick<AuditEntry, "actor" | "target">> & {
    detail: Readonly<Record<string, Json>>;
  };
  /** The run as its decisions name it (decisions.ts). */
  readonly decisionRun: DecisionRun;
  /**
   * Where the run's decisions are kept, for a test run's, which are never
   * the organization's (sealed-run.ts): how one stands, closing it with
   * `close`; its deadline; and how often the run looks at it besides its
   * wake, which a test's answer doesn't owe. Unset, decisions.ts keeps
   * them, under `decisionRun`.
   */
  readonly decisionsKept?: DecisionsKept | undefined;
  /** The run as its waits for its AI provider name it (ai-waits.ts). */
  readonly aiWaitRun: AiWaitRun;
  /**
   * Why step `step` may not run as `use` (a `do`, a sleep, a decision's
   * wait, a sleep until a deadline, a catch), or nothing when it may; for
   * a sleep, `time` is its length, and for a sleep until, its deadline.
   * The name is the isolate's to say, so a refusal is tampering
   * (`RunHost.#refuseStep`).
   */
  stepRefusal: (
    step: string,
    use: HostStepUse,
    time?: number
  ) => Error | undefined;
  /**
   * Refuses once the person the run acts for has left: checked before
   * every step, and wherever its kind's calls check it.
   */
  requirePerson: () => Promise<void>;
  /**
   * The host `attempt`'s code reaches core through, every call as it, and
   * each admitted against its lineage's host calls (`admission`).
   */
  attemptHost: (
    attempt: StepAttempt,
    admission: AttemptAdmission
  ) => AttemptHost;
  /**
   * Hears what `attempt` failed with, as its code reported it, while it
   * still held: a sealed run keeps it for a later attempt of a step whose
   * call goes out once (sealed-run.ts). None of an App's.
   */
  attemptFailed?: (attempt: StepAttempt, error: StepError) => void;
  /**
   * Step `step`'s limits in place of what its code declared: a sealed
   * run's engine retries, and the longest an attempt may take, its task's
   * timeout or its catch's retry policy's attempt duration
   * (sealed-run.ts). None of an App's.
   */
  limitsOf?: (step: string) => StepLimits;
  /**
   * What `attempt` settled with, as the host takes it, from what its
   * code reported (`result`): a sealed run's checks of what its step
   * records, and of the failures only its code reports (sealed-run.ts).
   * An App's run takes what its code reported.
   */
  attemptSettled?: (
    attempt: StepAttempt,
    result: Settled<unknown>,
    /** Whether the Loader cut it off past its CPU time: `result` is core's. */
    cut?: boolean
  ) => Promise<Settled<unknown>>;
  /**
   * The error `attempt`, of a catch step (`RunHost.caught`), offers its
   * code to decide on, if its catch may take the failure pending; none
   * when it may not, and its code isn't asked.
   */
  caughtOffer?: (attempt: StepAttempt) => Json | undefined;
  /**
   * Hears how step `step`, one it let start (`stepRefusal`), ended, fresh
   * or replayed, as every activation reaches it, in order: what it
   * recorded, or what it failed with in the end, past its retries, as the
   * engine journaled it.
   */
  stepEnded?: (
    step: string,
    outcome: Settled<unknown>,
    /**
     * For a failure, the catch its last retry decision said takes it (the
     * `try` task's ID; null for none), if one decided.
     */
    takenBy?: string | null
  ) => void;
  /**
   * The retry the host may run of step `step` after its round `round`
   * failed with `error`, under a catch's retry policy (sealed-run.ts);
   * none when it may not. None of an App's.
   */
  retryOffer?: (
    step: string,
    error: StepError,
    round: number
  ) => RetryOffer | undefined;
  /**
   * The wait step `step` makes for one of the run's decisions, in place of
   * what its code asked (`wait`), or a refusal of it: a sealed run waits
   * only for the decision its task opened, until that decision's deadline
   * (sealed-run.ts). An App's run waits as its code asks.
   */
  decisionWait?: (step: string, wait: DecisionWait) => DecisionWait | Error;
  /**
   * The outcome wait step `step` answers, from how its decision ended
   * (`outcome`), inside the step that records it: a sealed run takes an
   * answer only as its decision binding still allows it (sealed-run.ts),
   * and fails the step otherwise. An App's run answers the outcome.
   */
  decisionTaken?: (
    step: string,
    outcome: DecisionOutcome
  ) => Promise<DecisionOutcome>;
  /**
   * Refuses a durable wait the run may not wait, before it starts: a
   * sleep, a sleep until a deadline, an event wait, or a retry's backoff. A test run's
   * are held to its limit (sealed-run.ts); an App's run waits any.
   */
  requireWait?: (wait: WaitLength) => void;
  /**
   * What event wait step `step` takes from the run's own inbox, and how
   * long it waits from when it is first reached, decided by the kind
   * alone, its authority to take them checked first: a sealed run's
   * (sealed-run.ts). None of an App's run, which waits for no events.
   */
  eventWait?: (step: string) => Promise<EventWaitPlan>;
}

/** What an event wait takes, and for how long (`RunKind.eventWait`). */
export interface EventWaitPlan {
  /** Engine types and attributes, any of which an event must match. */
  readonly match: readonly EventMatch[];
  /** How long it waits from when it was first reached, in ms. */
  readonly timeoutMs: number;
}

/**
 * How an event wait ended (`RunHost.listen`), as `@grasp-os/sdk/workflow`'s
 * `EventWait` has it: the event it took, its envelope as the host minted
 * it, or that none came in time.
 */
export type EventWaitOutcome =
  | {
      timedOut: false;
      event: {
        id: string;
        type: string;
        source: string;
        subject?: string;
        time: string;
        data: Json;
      };
    }
  | { timedOut: true };

/** A durable wait as `RunKind.requireWait` hears of it: a length, or an end. */
export type WaitLength = { readonly ms: number } | { readonly until: number };

/** A step's engine retries, as a step's config has them. */
export interface StepRetries {
  limit: number;
  delay: number;
  backoff: "constant" | "linear" | "exponential";
}

/** A kind's own limits of a step (`RunKind.limitsOf`). */
export interface StepLimits {
  /** Its engine retries, whatever its code declared. */
  retries?: StepRetries;
  /** The longest an attempt may take, below what its code declared. */
  timeout?: number;
}

/**
 * How the host is asked to run a step: as an App's run is
 * (`StepUse`), or, only by a sealed run, as a sleep until the deadline
 * its step recorded (`sleepUntil`), a `try` task's catch (`caught`) or
 * an event wait (`listen`).
 */
export type HostStepUse = StepUse | "sleepUntil" | "caught" | "listen";

/** What a retry's decision step records (`RunHost.#retried`). */
export interface RetryDecision {
  /** The catch it said takes the failure (a `try` task's ID; null for none). */
  by?: string | null;
  /** Whether the step runs again. */
  retry: boolean;
  /** After how long. */
  delayMs: number;
  /** When its first round failed, which every later decision reads. */
  firstFailedAt: number;
}

/**
 * A retry the host may run of a failed step (`RunKind.retryOffer`): the
 * error its code's retry function decides on, and what the host decides
 * of what it chose, by the policy's limits (throwing a refusal of a
 * choice the build's code never makes).
 */
export interface RetryOffer {
  readonly error: Json;
  /**
   * The decision when the build leaves its code nothing to decide (a
   * catch and a policy with no conditions): the host takes it without
   * asking, so no code can withhold it.
   */
  readonly alone?: (firstFailedAt: number) => RetryDecision;
  /** `choice` is `undefined` when its code failed to choose. */
  decided: (choice: unknown, firstFailedAt: number) => RetryDecision;
}

const retryDecisionSchema = z.strictObject({
  by: z.string().nullable().optional(),
  retry: z.boolean(),
  delayMs: z.int().min(0),
  firstFailedAt: z.number(),
});

/**
 * The host's checks of a run's attempts, for its kind's calls (`RunKind`):
 * each as `RunHost`'s own of the same name. A plain object, never the
 * host's methods: the host is the isolate's RPC target, and these aren't
 * the isolate's to call.
 */
export interface HostControls {
  /** Fails once the run's isolate was caught tampering. */
  requireUntampered: () => void;
  /** Whether `attempt` may still act. */
  holds: (attempt: StepAttempt) => boolean;
  /** Refuses, as stale, a call of `attempt` that no longer holds. */
  requireCurrent: (attempt: StepAttempt, call: string) => Promise<void>;
  /** The refusal of a call of `attempt` once it no longer holds. */
  leaseRefusal: (
    attempt: StepAttempt,
    call: string
  ) => Promise<Settled<never> | undefined>;
  /** The refusal of a call of `attempt` past its lineage's host calls. */
  hostCallRefusal: (
    attempt: StepAttempt,
    admission: AttemptAdmission,
    call: string
  ) => Promise<Settled<never> | undefined>;
  /** The attempt running now, else `attempt` (`RunHost.#live`). */
  running: (attempt: StepAttempt) => StepAttempt;
  /** Fails `attempt` and the one running now, as tampering. */
  refuseIn: (
    attempt: StepAttempt,
    error: Error,
    call: string,
    step?: string,
    binding?: string
  ) => Promise<never>;
  /** Records a refusal of a run's call, or of its step. */
  auditRefusal: (refusal: Refusal) => Promise<void>;
  /** `call`'s answer, asked of the gateway once `attempt` may ask. */
  askingOnce: (
    attempt: StepAttempt,
    request: string,
    call: () => Promise<unknown>,
    stillServed: () => Promise<void>
  ) => Promise<unknown>;
}

/** A refused call of a run, or step, as its audit entry names it. */
interface Refusal {
  step: string | null;
  call: string | null;
  errorCode: string;
  binding?: string;
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
  /** What the run, as its kind, may do (`RunKind`). */
  readonly #kind: RunKind;
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
   * last is the step running now, which every reviewed call and kind is
   * checked against as well as the step whose host it came through
   * (`HostControls.running`, as an App run's checks use it: app-run.ts).
   *
   * The SDK runs steps one after another, never inside or next to one
   * another (`exclusive`, workflow.ts), so a workflow it runs has one
   * attempt live at a time (and, at most, attempts the engine gave up on,
   * whose calls fail as stale first). Two live at once is code past the
   * SDK; the host can't tell which attempt's code made a call (a step
   * arrives as `do` alone, saying nothing of what started it), so a call
   * that either attempt's review doesn't allow is refused: it fails
   * closed. Steps run side by side would need the SDK to allow them and
   * each call to carry its caller first.
   */
  readonly #live: StepAttempt[] = [];
  /**
   * Whether the Loader stopped the run's isolate past its CPU time: no
   * later attempt of this execution calls into it (`do`).
   */
  #isolateStopped = false;

  /**
   * A host for the run `kind` makes of the host's checks of it
   * (`HostControls`): an App's run (app-run.ts, `appRun`).
   */
  constructor(
    env: Env,
    step: RunStep,
    kind: (host: HostControls) => RunKind,
    hooks: HostHooks
  ) {
    super();
    this.#env = env;
    this.#step = step;
    this.#hooks = hooks;
    const aiCalls = hooks.aiCalls ?? newAiCalls();
    this.#asking = aiCalls.asking;
    this.#unclaimed = aiCalls.unclaimed;
    this.#kind = kind({
      requireUntampered: () => {
        this.#requireUntampered();
      },
      holds: (attempt) => this.#holds(attempt),
      requireCurrent: async (attempt, call) => {
        await this.#requireCurrent(attempt, call);
      },
      leaseRefusal: async (attempt, call) =>
        await this.#leaseRefusal(attempt, call),
      hostCallRefusal: async (attempt, admission, call) =>
        await this.#hostCallRefusal(attempt, admission, call),
      running: (attempt) => this.#live.at(-1) ?? attempt,
      refuseIn: async (attempt, error, call, refused, binding) =>
        await this.#refuseIn(attempt, error, call, refused, binding),
      auditRefusal: async (refusal) => {
        await this.#auditRefusal(refusal);
      },
      askingOnce: async (attempt, request, call, stillServed) =>
        await this.#askingOnce(attempt, request, call, stillServed),
    });
    this.#run = this.#kind.run;
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
    const { runId } = this.#run;
    const { actor, target, detail: runDetail } = this.#kind.audit;
    const db = drizzle(this.#env.DB);
    try {
      await auditedBatch(this.#env, db, [
        outboxed(db, {
          actor,
          action: `workflow.step.${outcome}`,
          target,
          detail: {
            ...runDetail,
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
    const wakeType = await heldWakeType(step);
    if (unknownSince !== undefined) {
      // Never run again at once on an unknown outcome: should connect
      // and the step's call disagree on whether it may be recovered now,
      // the step would come back held at once, again and again. Only its
      // person's resolution, which wakes the step (wakes.ts), cuts this
      // first wait short, so the run acts on their word within seconds.
      // This wait replaced a plain sleep of the same name, with no branch
      // for a run suspended in one: Grasp has no release yet, so no such
      // run outlives a deploy.
      try {
        await this.#step.waitForEvent(`${prefix}:first`, {
          type: wakeType,
          timeout: first,
        });
      } catch (error) {
        if (!isTimeout(error)) {
          throw error;
        }
      }
    }
    const deadline =
      unknownSince === undefined
        ? undefined
        : unknownSince + unknownHoldMsOf(this.#env);
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
        // The reason is the wait's, fixed for all of it: an unknown
        // outcome's wait (`unknownSince`) never turns into a held one's.
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

  /**
   * Records, once in a step named after its last round, that step `step`
   * waits for its AI provider no more (ai-waits.ts).
   */
  async #keyWaitEnded(step: string, wait: KeyWait): Promise<void> {
    await this.#step.do(`${wait.prefix}:ended`, {}, async () => {
      await aiWaitEnded(this.#env, this.#run.runId, step);
      return null;
    });
  }

  /**
   * `#keyWaitEnded` for a step that is ending in a throw, when it waited:
   * never in the way of the step's own error, which is what the run sees.
   */
  async #keyWaitEndedQuietly(step: string, wait: KeyWait): Promise<void> {
    if (wait.since === undefined) {
      return;
    }
    try {
      await this.#keyWaitEnded(step, wait);
    } catch (error) {
      log.error("workflow.ai_wait_end_failed", {
        runId: this.#run.runId,
        ...errorFields(error),
      });
    }
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
    { waitedMs, maxWaitMs }: WaitedSoFar
  ): Promise<AttemptAdmission | Busy> {
    if (this.#hooks.admitAttempt === undefined) {
      // Waited as long as a step may: it fails, though a slot came free
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
        ...(waitedMs === undefined ? {} : { waitedMs }),
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
   * said, as long as `sleepMs` (a sleep, which holds no attempt).
   * `unknown` carries when the step was first held on its current unknown
   * outcome across rounds. Answers the prefix of the steps it waited in,
   * which the step's next run is named after.
   */
  async #waitBefore(
    step: string,
    /** What its rounds are named after: the step's name, or a retry's. */
    base: string,
    marker: Exclude<CoreMarker, { kind: "key" }>,
    { round, sleepMs }: WaitRound,
    unknown: { since?: number }
  ): Promise<string> {
    const key = await waitKeyOf(base);
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
    await this.#step.sleep(prefix, sleepMs);
    return prefix;
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
    fn: (attempt: AttemptHost) => Promise<unknown>,
    /**
     * A sealed run's choice of a retry after a failure, its code's
     * (`RunKind.retryOffer`, `#retried`); an App's run has none.
     */
    retry?: unknown
  ): Promise<Settled<unknown>> {
    return await this.#doStep(
      name,
      options,
      "do",
      async (host) => await fn(host),
      typeof retry === "function"
        ? async (error: Json): Promise<unknown> =>
            // SAFETY: the isolate's function, over RPC, answering
            // `Settled` as every one of its functions does (code.ts).
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
            await (retry as (error: Json) => Promise<unknown>)(error)
        : undefined
    );
  }

  /**
   * Runs a `try` task's catch step of a sealed run: its code is handed the
   * error its catch may take (`RunKind.caughtOffer`), and decides whether
   * it does; it isn't asked when the catch may take nothing, and the step
   * records that it took none. What the step records is the kind's to
   * check (`RunKind.attemptSettled`), and what it answers, fresh or
   * replayed, is what it recorded.
   */
  async caught(
    name: unknown,
    options: unknown,
    fn: (attempt: AttemptHost, error: Json) => Promise<unknown>
  ): Promise<Settled<unknown>> {
    return await this.#doStep(
      name,
      options,
      "caught",
      async (host, attempt) => {
        const offered = this.#kind.caughtOffer?.(attempt);
        return offered === undefined
          ? { ok: true, value: false }
          : await fn(host, offered);
      }
    );
  }

  /**
   * `do`'s work, and a catch's (`caught`), run as `use`: `call` is the
   * attempt's function in the isolate. A failure a catch's retry policy
   * may try again runs the step again in its place (`#retried`), each
   * round under steps of its own, its call under the same key.
   */
  async #doStep(
    name: unknown,
    options: unknown,
    use: "do" | "caught",
    call: (host: AttemptHost, attempt: StepAttempt) => Promise<unknown>,
    retry?: (error: Json) => Promise<unknown>
  ): Promise<Settled<unknown>> {
    let failed: StepError | undefined;
    // The catch its last retry decision said takes the failure, if any.
    let takenBy: string | null | undefined;
    let attempted = false;
    // Whether its kind let it start: only such a step's end is its to hear.
    let started = false;
    let step = "";
    let sideEffect = false;
    let input: InputShape | null = null;
    // Its wait for its AI provider, over its rounds in a row: ended however
    // the step ends, a throw included, so no run reads as waiting on.
    let keyWait = keyWaitStart();
    const stepDone = Promise.withResolvers<null>();
    try {
      this.#requireUntampered();
      step = checked(stepNameSchema, name);
      await this.#requireStep(step, use);
      started = true;
      const parsed = checked(doOptionsSchema, options);
      sideEffect = parsed.sideEffect === true;
      input = inputShape(parsed.input);
      const config = stepConfig(parsed, this.#kind.limitsOf?.(step));
      await this.#kind.requirePerson();
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
        const attempt = this.#attemptOf(
          step,
          context,
          isLastAttempt(context, tries, config.retries.limit)
        );
        // Admitted before its code runs, or failed with the refusal: a
        // limit reached fails the step; a lineage whose time attempts
        // under way hold ends the step as busy, and the run waits
        // (`busyMarker`).
        const admitted = await settle(
          async () =>
            await this.#admit(attempt, {
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
            async (host) => await call(host, attempt),
            stepDone.promise
          );
        } finally {
          current = this.#holds(attempt);
          // Its function has returned: its host acts no more, whatever
          // the attempt's code still has out.
          attempt.over = true;
          this.#live.splice(this.#live.indexOf(attempt), 1);
          // What it held of its lineage's time turns into what it used.
          await admission.settle();
        }
        // Connect held a side effect of it for the person the run acts
        // for: the step ends as held, not failed, whatever the workflow
        // code made of the answer, and runs again once they decided. The
        // run's own calls say so, its App's functions' through their
        // resource bindings (`BindingCaller.held`). Once decided, the
        // rerun's call answers for good: a decline (`connect.declined`) is
        // an error like any other, which workflow or App code may catch
        // and carry on from; it is audited in connect whatever the code
        // does with it.
        const held = current && attempt.held;
        // A call its review doesn't show fails the step for good, even
        // when its code caught the refusal and carried on.
        if (attempt.refused !== undefined) {
          failed = forIsolate(attempt.refused);
          throw toStepError(failed);
        }
        if (attempt.final !== undefined) {
          failed = forIsolate(attempt.final);
          throw namedError("NonRetryableError", failed.message, failed.code);
        }
        if (held) {
          return heldMarkerOf(attempt.heldKeys, attempt.unknown);
        }
        // Its model call was refused for the organization's AI provider
        // key: the step waits for a working one, not failed, using no
        // retry, whatever the workflow code made of the refusal.
        if (current && attempt.aiTrouble !== undefined) {
          return keyMarkerOf(Date.now(), attempt.aiTrouble);
        }
        if (!result.ok) {
          failed = result.error;
          if (current) {
            this.#kind.attemptFailed?.(attempt, result.error);
          }
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
        // Audited here, before the engine stores the result, so a stop
        // between the two can't lose it: at least once, as a stop before
        // the result is stored runs the step, and audits it, again.
        if (current) {
          await this.#audited(step, "completed", { sideEffect });
        }
        return result.value;
      };
      const keyWaitStarted = async (
        since: number,
        aiWait: AiWait
      ): Promise<void> => {
        await aiWaitStarted(
          this.#env,
          this.#kind.aiWaitRun,
          step,
          aiWait,
          since
        );
        await this.#hooks.waiting({ reason: "ai_provider", ...aiWait });
      };
      // The step run under `base` (its own name, or a retry's), then run
      // again while it is held, or its lineage busy: wait until the person
      // decided, or the seconds the lineage said, then run the step again
      // under the same key, in a step of its own each time, its names
      // `base`'s, so every execution replays the same steps.
      const rounds = async (base: string): Promise<unknown> => {
        tries = 0;
        load = loadWaitStart;
        failed = undefined;
        let value = await this.#step.do(base, config, attemptStep);
        // When the step was first held on its current unknown outcome.
        const unknown: { since?: number } = {};
        let round = 0;
        for (
          let marker = markerOf(value);
          marker !== undefined;
          marker = markerOf(value)
        ) {
          round += 1;
          if (marker.kind !== "key" && keyWait.since !== undefined) {
            // oxlint-disable-next-line no-await-in-loop -- once per wait
            await this.#keyWaitEnded(step, keyWait);
            keyWait = keyWaitStart();
          }
          // Read off the markers alone, journaled as the step's results,
          // so every replay counts the same.
          load = loadWaitAfter(load, marker);
          if (marker.kind === "busy" && load.sleepMs <= 0) {
            failed = queueTimedOut(step, marker.maxWaitMs);
            throw toStepError(failed);
          }
          if (marker.kind === "key") {
            // oxlint-disable-next-line no-await-in-loop -- one round at a time
            const prefix = waitStep(await waitKeyOf(base), "key", round);
            // oxlint-disable-next-line no-await-in-loop -- one round at a time
            const ended = await keyRound(
              this.#step,
              this.#env,
              prefix,
              marker,
              keyWait,
              keyWaitStarted
            );
            if (ended === "timed_out") {
              // oxlint-disable-next-line no-await-in-loop -- once
              await this.#keyWaitEnded(step, keyWait);
              keyWait = keyWaitStart();
              failed = keyTimedOut(step, marker.trouble);
              throw toStepError(failed);
            }
            tries = 0;
            // oxlint-disable-next-line no-await-in-loop -- one round at a time
            value = await this.#step.do(`${prefix}:run`, config, attemptStep);
            continue;
          }
          // oxlint-disable-next-line no-await-in-loop -- one round at a time
          const prefix = await this.#waitBefore(
            step,
            base,
            marker,
            { round, sleepMs: load.sleepMs },
            unknown
          );
          tries = 0;
          // oxlint-disable-next-line no-await-in-loop -- one round at a time
          value = await this.#step.do(`${prefix}:run`, config, attemptStep);
        }
        if (keyWait.since !== undefined) {
          await this.#keyWaitEnded(step, keyWait);
          keyWait = keyWaitStart();
        }
        return value;
      };
      // When its first round failed, as a catch's retry recorded it.
      let firstFailedAt: number | undefined;
      let value: unknown;
      for (let round = 1; ; round += 1) {
        const base =
          round === 1
            ? step
            : // oxlint-disable-next-line no-await-in-loop -- one round at a time
              `${waitStep(await waitKeyOf(step), "retry", round)}:run`;
        try {
          // oxlint-disable-next-line no-await-in-loop -- one round at a time
          value = await rounds(base);
          break;
        } catch (error) {
          if (this.#kind.retryOffer === undefined) {
            throw error;
          }
          // As the engine journaled it, so a replay decides the same.
          const roundError = journaledFailure(error);
          // oxlint-disable-next-line no-await-in-loop -- one round at a time
          const retried = await this.#retried(step, roundError, round, {
            retry,
            firstFailedAt,
            stepDone: stepDone.promise,
          });
          // This round's own decision, none if it had none.
          takenBy = retried?.by;
          if (retried?.retry !== true) {
            throw error;
          }
          // It runs again: it waits for its AI provider no more.
          // oxlint-disable-next-line no-await-in-loop -- one round at a time
          await this.#keyWaitEndedQuietly(step, keyWait);
          keyWait = keyWaitStart();
          ({ firstFailedAt } = retried);
        }
      }
      this.#kind.stepEnded?.(step, { ok: true, value });
      return { ok: true, value };
    } catch (error) {
      // The step ran again after its wait and threw: it waits no more.
      await this.#keyWaitEndedQuietly(step, keyWait);
      // A kind that hears how its steps end (`stepEnded`) hears, and its
      // code is answered, what the step failed with as the engine
      // journaled it, fresh or replayed alike: never `failed`, which an
      // attempt the engine gave up on may still set.
      const journaled =
        this.#kind.stepEnded === undefined
          ? undefined
          : journaledFailure(error);
      const reported = journaled ?? failed ?? forIsolate(error);
      if (started && journaled !== undefined) {
        this.#kind.stepEnded?.(step, { ok: false, error: journaled }, takenBy);
      }
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
   * The attempt of step `step` the engine claimed (`context`): its
   * number, its step's key and its lease, which an activation that is
   * over no longer has, and whether it is the step's `last`.
   */
  #attemptOf(step: string, context: unknown, last: boolean): StepAttempt {
    const told = attemptContextSchema.parse(context);
    const lease = this.#hooks.leaseOf(told.idempotencyKey, told.attempt);
    if (lease === undefined) {
      throw new Error(`Step "${step}"'s attempt holds no lease`);
    }
    return {
      leaseId: crypto.randomUUID(),
      number: told.attempt,
      ...(told.stepOrdinal === undefined ? {} : { ordinal: told.stepOrdinal }),
      key: told.idempotencyKey,
      generation: lease.generation,
      deadline: lease.deadline,
      over: false,
      step,
      held: false,
      unknown: false,
      heldKeys: [],
      functionCalls: 0,
      last,
    };
  }

  /**
   * Whether step `step`, whose round `round` failed with `error`, runs
   * again in its place: only as its kind offers
   * (`RunKind.retryOffer`: a sealed run's step in the list of a `try`
   * whose catch retries, while its policy has rounds left and the
   * failure may be tried again), and its code's `retry` chooses, the
   * kind holding that choice to the policy. Decided in a step of its own
   * that records it (`#decideRetry`), then a durable sleep of the backoff
   * it decided, each named after the round it leads to. Answers when the
   * first round failed, which every later decision reads; `undefined`
   * when it doesn't run again, and the step fails as its round did,
   * whatever a decision itself failed with; a backoff its kind refuses
   * (`RunKind.requireWait`) fails it with that refusal. Fresh or replayed
   * alike.
   */
  async #retried(
    step: string,
    error: StepError,
    round: number,
    {
      retry,
      firstFailedAt,
      stepDone,
    }: {
      retry: ((error: Json) => Promise<unknown>) | undefined;
      firstFailedAt: number | undefined;
      stepDone: Promise<unknown>;
    }
  ): Promise<RetryDecision | undefined> {
    const offer = this.#kind.retryOffer?.(step, error, round);
    if (offer === undefined) {
      return undefined;
    }
    // Taken alone where the build leaves nothing to decide; else asked of
    // its code, if it gave a way to ask.
    const { alone } = offer;
    let decide: ((context: unknown) => Promise<RetryDecision>) | undefined;
    if (alone !== undefined) {
      decide = async () =>
        await Promise.resolve(alone(firstFailedAt ?? Date.now()));
    } else if (retry !== undefined) {
      decide = async (context) =>
        await this.#decideRetry(step, context, offer, {
          retry,
          firstFailedAt,
          stepDone,
        });
    }
    if (decide === undefined) {
      // Its policy asks its code, which gave no way to ask: code past the
      // SDK, skipping what its policy says.
      const refusal = workflowErrors.create("workflow.invalid");
      refusal.message = `Step "${step}" gives no retry for its policy to ask.`;
      await settle(
        async () => await this.#refuseTampering(refusal, { step, call: null })
      );
      return undefined;
    }
    const prefix = waitStep(await waitKeyOf(step), "retry", round + 1);
    let decided: RetryDecision;
    try {
      decided = retryDecisionSchema.parse(
        await this.#step.do(`${prefix}:decide`, stepConfig({}), decide)
      );
    } catch {
      // The round's failure goes on unchanged, whatever its decision
      // failed with: a refusal of it was recorded as tampering already,
      // which ends the run (`#refuseTampering`).
      return undefined;
    }
    if (!decided.retry) {
      return decided;
    }
    if (decided.delayMs > 0) {
      // Past what the run may wait, the step fails with that refusal
      // instead of its round's failure.
      this.#kind.requireWait?.({ ms: decided.delayMs });
      await this.#step.sleep(`${prefix}:wait`, decided.delayMs);
    }
    await this.#kind.requirePerson();
    return decided;
  }

  /**
   * The decision step of a retry of step `step`, as the engine claimed its
   * attempt (`context`): the error `offer` names handed to the isolate's
   * `retry`, outside any step's attempt (so nothing it calls is made), and
   * its choice held to the policy by the kind (`RetryOffer.decided`): a
   * choice the build's code never makes is tampering. A failure of its
   * own (an expression that failed) retries nothing. Not admitted as an
   * attempt: it calls nothing, and its rounds are (a refusal for load
   * here would skip the policy, where a round waits it out); a step has
   * at most four. Recorded, so a replay sleeps as long and decides the
   * same.
   */
  async #decideRetry(
    step: string,
    context: unknown,
    offer: RetryOffer,
    {
      retry,
      firstFailedAt,
      stepDone,
    }: {
      retry: (error: Json) => Promise<unknown>;
      firstFailedAt: number | undefined;
      stepDone: Promise<unknown>;
    }
  ): Promise<RetryDecision> {
    const firstAt = firstFailedAt ?? Date.now();
    const attempt = this.#attemptOf(step, context, false);
    if (this.#tampered !== undefined) {
      throw toStepError(forIsolate(this.#tampered));
    }
    try {
      const call = this.#isolateStopped
        ? Promise.reject(cpuLimitKill())
        : retry(offer.error);
      this.#hooks.attemptCall?.(call, stepDone);
      let chosen: Settled<unknown>;
      try {
        chosen = fromIsolate(await call);
      } catch (error) {
        if (!isCpuLimitKill(error)) {
          // Rejected rather than reported: the engine decides again,
          // journaling words of core's, never the isolate's.
          throw new Error("The retry's decision failed.", { cause: error });
        }
        this.#isolateStopped = true;
        throw toStepError(forIsolate(error));
      }
      if (!this.#holds(attempt)) {
        throw attemptTimedOut();
      }
      try {
        // A choice its code failed to make is the kind's to judge too.
        return offer.decided(chosen.ok ? chosen.value : undefined, firstAt);
      } catch (error) {
        // Tampering: the decision fails for good, and with it the step.
        const refused = await settle(
          async () =>
            await this.#refuseTampering(
              error instanceof Error
                ? error
                : workflowErrors.create("workflow.invalid"),
              { step, call: null }
            )
        );
        throw toStepError(
          refused.ok
            ? forIsolate(workflowErrors.create("workflow.invalid"))
            : refused.error
        );
      }
    } finally {
      attempt.over = true;
    }
  }

  /**
   * Calls `attempt`'s function in the run's isolate, through a host whose
   * every call `admission` admits as one of its lineage's host calls,
   * `stepDone` settling
   * once its step ends in this activation: what it settled with, or, once
   * the Loader (on-prem, the sandbox: code.ts, `stepCodeFailure`) stopped
   * the isolate past its CPU time while it ran, a timeout, which its step's retries retry in a fresh activation with a
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
      ? Promise.reject(cpuLimitKill())
      : fn(this.#kind.attemptHost(attempt, admission));
    this.#hooks.attemptCall?.(call, stepDone);
    let reported: Settled<unknown>;
    try {
      reported = fromIsolate(await call);
    } catch (error) {
      const cut = isCpuLimitKill(error);
      if (cut) {
        this.#isolateStopped = true;
      }
      // Cut off, or its function rejected rather than reported: a kind
      // that checks what its attempts settle with checks this too, so
      // nothing gets past it; any other's step fails, or its engine
      // tries it again, as it did.
      if (this.#kind.attemptSettled === undefined) {
        if (cut) {
          return { ok: false, error: forIsolate(error) };
        }
        throw error;
      }
      return await this.#kind.attemptSettled(
        attempt,
        { ok: false, error: forIsolate(error) },
        cut
      );
    }
    return (await this.#kind.attemptSettled?.(attempt, reported)) ?? reported;
  }

  async sleep(name: unknown, duration: unknown): Promise<Settled<null>> {
    let step = "";
    let started = false;
    const slept = await settle(async () => {
      this.#requireUntampered();
      step = checked(stepNameSchema, name);
      await this.#requireStep(
        step,
        "sleep",
        typeof duration === "number" ? duration : undefined
      );
      started = true;
      const ms = checked(milliseconds, duration);
      this.#kind.requireWait?.({ ms });
      await this.#step.sleep(step, ms);
      return null;
    });
    if (started) {
      this.#kind.stepEnded?.(step, slept);
    }
    return slept;
  }

  /**
   * Sleeps durably until `until`, in ms since the epoch: at once once
   * past. Only a sealed run's sleeping task sleeps so, until exactly the
   * deadline its step recorded (`RunKind.stepRefusal`); an App's run has
   * no such step.
   */
  async sleepUntil(name: unknown, until: unknown): Promise<Settled<null>> {
    let step = "";
    let started = false;
    const slept = await settle(async () => {
      this.#requireUntampered();
      step = checked(stepNameSchema, name);
      await this.#requireStep(
        step,
        "sleepUntil",
        typeof until === "number" ? until : undefined
      );
      started = true;
      const at = checked(timestampSchema, until);
      this.#kind.requireWait?.({ until: at });
      await this.#kind.requirePerson();
      await this.#step.sleepUntil(step, at);
      return null;
    });
    if (started) {
      this.#kind.stepEnded?.(step, slept);
    }
    return slept;
  }

  /**
   * Waits durably for an event of the run's own inbox, holding no
   * isolate: only a sealed run's event wait does (an App's run's kind
   * refuses the step as tampering). What it takes, and until when, are its kind's
   * (`RunKind.eventWait`), never its code's. When it was first reached is
   * recorded, so its deadline is the same on every replay; the engine
   * journals the event it took, so a replay answers that event, and no
   * other wait takes it again. Past its deadline, `{ timedOut: true }`.
   */
  async listen(name: unknown): Promise<Settled<EventWaitOutcome>> {
    let step = "";
    let started = false;
    const waited = await settle(async (): Promise<EventWaitOutcome> => {
      this.#requireUntampered();
      step = checked(stepNameSchema, name);
      await this.#requireStep(step, "listen");
      started = true;
      await this.#kind.requirePerson();
      const plan = await this.#kind.eventWait?.(step);
      if (plan === undefined) {
        throw new Error(`Step "${step}" waits for events its run has none of`);
      }
      const { match, timeoutMs } = plan;
      const reached = reachedAtSchema.parse(
        await this.#step.do(
          `${waitStepPrefix}${await waitKeyOf(step)}:reached`,
          {},
          async () => await Promise.resolve({ at: Date.now() })
        )
      );
      const until = reached.at + timeoutMs;
      this.#kind.requireWait?.({ until });
      let taken: { payload: unknown; timestamp: Date };
      try {
        taken = await this.#step.waitForMatch(step, { match, until });
      } catch (error) {
        if (isTimeout(error)) {
          return { timedOut: true };
        }
        throw error;
      }
      // As the host minted it when the run accepted it (run-events.ts).
      const stored = storedEventSchema.parse(taken.payload);
      return {
        timedOut: false,
        event: {
          id: stored.id,
          type: stored.type,
          source: stored.source,
          ...(stored.subject === undefined ? {} : { subject: stored.subject }),
          time: taken.timestamp.toISOString(),
          data: stored.data,
        },
      };
    });
    if (started) {
      this.#kind.stepEnded?.(step, waited);
    }
    return waited;
  }

  /**
   * `call`'s answer, asked of the gateway once {@link #untilAsking} lets
   * `attempt` ask. When a full share or a provider's rate turns it away,
   * the attempt waits the wait core computed, at most
   * {@link throttledWaitMs} (as long as its timeout lets it), before it
   * fails, unless it is the last: nothing comes after it.
   */
  async #askingOnce(
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
      // A full share of the model requests in flight (the gateway already
      // waited its turn for as long as a call may), or the provider's
      // rate: the attempt waits the wait core computed, as long as its
      // timeout lets it and no longer than {@link throttledWaitMs}, before
      // it fails, unless it is the last.
      // One its provider limits on the organization's key holds the run
      // instead (`keyMarkerOf`): no wait here.
      const throttled = modelErrors.codeOf(error);
      if (
        (throttled === "model.queued" || throttled === "model.rate_limited") &&
        aiWaitOf(error) === undefined &&
        !attempt.last
      ) {
        const wait = isExpectedError(error)
          ? error.details?.retryAfterSeconds
          : undefined;
        await waitWithin(
          attempt,
          Math.min(
            throttledWaitMs,
            typeof wait === "number" ? wait * 1000 : throttledWaitMs
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
   * Returns once `attempt` may ask the gateway for its step's AI call: once
   * no call of the step is still in flight, so a later attempt waits for
   * an earlier one's answer rather than ask, and pay, beside it. An
   * attempt the engine gave up on meanwhile fails.
   */
  async #untilAsking(attempt: StepAttempt): Promise<void> {
    for (;;) {
      const asking = this.#asking.get(attempt.step);
      if (asking === undefined) {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- then look again
      await asking.then(
        () => null,
        () => null
      );
      if (!this.#holds(attempt)) {
        throw modelErrors.create("model.failed");
      }
    }
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
   * Refuses a step its kind doesn't let the run run as `use`
   * (`RunKind.stepRefusal`): a `do`, a sleep or a decision's wait alike.
   * No code runs, and no wait is journaled, under a name of the isolate's
   * own making. Caught or not, it ends the run (`#refuseTampering`).
   */
  async #requireStep(
    step: string,
    use: HostStepUse,
    time?: number
  ): Promise<void> {
    const error = this.#kind.stepRefusal(step, use, time);
    if (error !== undefined) {
      await this.#refuseStep(step, error);
    }
  }

  /**
   * Refuses step `step` as tampering (`#refuseTampering`). Asked for from
   * inside another step's attempt, that attempt fails too
   * (`StepAttempt.refused`), so a step that catches the refusal of a step
   * nested in it and returns still fails, never completes.
   */
  async #refuseStep(step: string, error: Error): Promise<never> {
    const running = this.#live.at(-1);
    if (running !== undefined) {
      running.refused = error;
    }
    return await this.#refuseTampering(error, { step, call: null });
  }

  /**
   * Fails `attempt` (and the one running now) with `error`, as tampering
   * audited under `step`.
   */
  async #refuseIn(
    attempt: StepAttempt,
    error: Error,
    call: string,
    step = attempt.step,
    binding?: string
  ): Promise<never> {
    const running = this.#live.at(-1) ?? attempt;
    running.refused = error;
    attempt.refused = error;
    return await this.#refuseTampering(error, { step, call, binding });
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
  async #refuseTampering(
    error: Error,
    {
      step,
      call,
      binding,
    }: {
      step: string | null;
      call: string | null;
      /** The model binding a refused model call named. */
      binding?: string | undefined;
    }
  ): Promise<never> {
    if (this.#tampered === undefined) {
      this.#tampered = error;
      const refusal = forIsolate(error);
      this.#hooks.tampered(refusal);
      await this.#auditRefusal({
        step,
        call,
        errorCode: refusal.code ?? "workflow.invalid",
        ...(binding === undefined ? {} : { binding }),
      });
    }
    throw error;
  }

  /**
   * Records a refusal of a run's call, or of its step, through the outbox.
   * One that can't be recorded is logged: refused all the same, and the
   * step or run fails with it, which is audited.
   */
  async #auditRefusal(refusal: Refusal): Promise<void> {
    const { runId } = this.#run;
    const { actor, target, detail } = this.#kind.audit;
    const db = drizzle(this.#env.DB);
    try {
      await auditedBatch(this.#env, db, [
        outboxed(db, {
          actor,
          action: "workflow.call.refused",
          target,
          detail: { ...detail, ...refusal },
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

  /** How the run's decision `decision` stands (`RunKind.decisionsKept`). */
  async #decisionOutcome(
    decision: string,
    close: boolean
  ): Promise<DecisionOutcome> {
    const kept = this.#kind.decisionsKept;
    return kept === undefined
      ? await decisionOutcome(
          this.#env,
          this.#kind.decisionRun,
          decision,
          close
        )
      : await kept.outcome(decision, close);
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
    let step = "";
    let started = false;
    const waited = await settle(async () => {
      this.#requireUntampered();
      step = checked(stepNameSchema, name);
      await this.#requireStep(step, "waitForDecision");
      started = true;
      const asked = checked(decisionWaitSchema, options);
      const held = this.#kind.decisionWait?.(step, asked) ?? asked;
      if (held instanceof Error) {
        return await this.#refuseStep(step, held);
      }
      const { decision, timeout, last } = held;
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
            const { answered } = await this.#decisionOutcome(decision, false);
            return { at, answered };
          })
        );
      const reached = await look(`${prefix}:reached`);
      // The SDK worked `timeout` out from when it asked, but a pause or a
      // restart may have outlasted that: so never wait past the decision's
      // deadline, as its row has it, from when the wait was first reached.
      // Once that has passed, the decision is closed as timed out at once,
      // so a reminder that follows asks nobody.
      const kept = this.#kind.decisionsKept;
      const deadline =
        kept === undefined
          ? await decisionDeadline(this.#env, this.#kind.decisionRun, decision)
          : await kept.deadline(decision);
      const end = Math.min(reached.at + timeout, deadline);
      let seen = reached;
      for (let round = 0; !seen.answered && seen.at < end; round += 1) {
        // A test run's decision is looked at again every so often as well:
        // its answer owes no wake, so one is read at the next look.
        const left = end - seen.at;
        try {
          // oxlint-disable-next-line no-await-in-loop -- one wait at a time
          await this.#step.waitForEvent(
            round === 0 ? step : `${prefix}:again:${round}`,
            {
              type: decisionEventType(decision),
              timeout: kept === undefined ? left : Math.min(left, kept.lookMs),
            }
          );
        } catch (error) {
          if (!isTimeout(error)) {
            throw error;
          }
          if (kept === undefined) {
            break;
          }
        }
        // oxlint-disable-next-line no-await-in-loop -- one look per wake
        seen = await look(`${prefix}:woken:${round}`);
      }
      // Recorded too: an answer that comes after this can't change what a
      // replay of the run hears it ended with.
      return outcomeSchema.parse(
        await this.#step.do(`${prefix}:outcome`, {}, async () => {
          const outcome = await this.#decisionOutcome(
            decision,
            last || Date.now() >= deadline
          );
          return (await this.#kind.decisionTaken?.(step, outcome)) ?? outcome;
        })
      );
    });
    if (started) {
      this.#kind.stepEnded?.(step, waited);
    }
    return waited;
  }
}
