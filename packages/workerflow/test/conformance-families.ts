// The compatibility profile Workerflow declares, its families (the rows of
// the platform specification's section 42.2 matrix), and every discrepancy
// the conformance suite found between Workerflow and the reference engine.
//
// The reference here is the Workflows engine Wrangler ships, run on the
// same workerd: the pinned local oracle. It is not managed Cloudflare: it
// differs from Cloudflare's documentation in places (its default retry
// delay is 1 second, not 10), and the managed oracle is GRA-382's, on a
// real account. So a discrepancy is one of three things:
//
//   decided     Workerflow differs on purpose, by a named scope decision.
//   failed      Workerflow lacks the behavior: the family fails, and the
//               follow-up issue builds it.
//   unresolved  Workerflow and the reference differ and no decision says
//               which is right; the managed oracle (GRA-382) and the
//               decision issue settle it. Not a pass.
//
// A family qualifies on plain workerd when every discrepancy it has is
// decided. The profile is partial until every family qualifies here and
// on managed Cloudflare. Every discrepancy has an executable check in
// conformance.test.ts that observes both sides, so a change on either
// engine fails it until this declaration is updated.

/** The profile's identity, apart from the package and storage versions. */
export const profileId = "cloudflare-js-2026-10-01";

export const families = [
  "definition-event",
  "do-overloads",
  "step-context",
  "retry-policy",
  "nonretryable-failure",
  "sleeps",
  "events",
  "serialization",
  "streams",
  "sensitive-output",
  "binding-create-get",
  "batch-operations",
  "status",
  "pause-resume",
  "termination-deletion",
  "restart",
  "rollbacks",
  "subscriptions",
  "schedules",
  "retention-limits",
] as const;

export type Family = (typeof families)[number];

export type Verdict = "decided" | "failed" | "unresolved";

export interface Discrepancy {
  readonly family: Family;
  readonly verdict: Verdict;
  /** What Workerflow does. */
  readonly workerflow: string;
  /** What the reference does. */
  readonly reference: string;
  /** The decision, for `decided`; the issue that settles it, otherwise. */
  readonly resolution: string;
}

/** Where an unresolved discrepancy is settled. */
const toOracle =
  "GRA-382 observes managed Cloudflare; GRA-649 decides and records the scope decision";

export const discrepancies = {
  "default-retry-delay": {
    family: "step-context",
    verdict: "decided",
    workerflow: "a step's default first retry delay is 10 seconds",
    reference: "1 second",
    resolution:
      "Cloudflare's documented default, frozen in the profile (spec 42.2; config.ts)",
  },
  "idempotency-key": {
    family: "step-context",
    verdict: "decided",
    workerflow: "a step's context carries an idempotencyKey",
    reference: "no idempotencyKey",
    resolution:
      "additive: effects are at least once, and the key lets a receiver apply one once (contracts.ts)",
  },
  "attempt-timeout-name": {
    family: "retry-policy",
    verdict: "unresolved",
    workerflow: "a timed-out attempt's error is named WorkflowTimeoutError",
    reference: "named Error, with the same message",
    resolution: toOracle,
  },
  "caught-non-retryable": {
    family: "nonretryable-failure",
    verdict: "unresolved",
    workerflow: "a caught NonRetryableError keeps its name and message",
    reference: 'named Error, its message prefixed "NonRetryableError: "',
    resolution: toOracle,
  },
  "past-sleep-until": {
    family: "sleeps",
    verdict: "unresolved",
    workerflow: "sleepUntil a past time resolves at once",
    reference: 'the run errors ("You can\'t sleep until a time in the past")',
    resolution: toOracle,
  },
  "negative-sleep": {
    family: "sleeps",
    verdict: "unresolved",
    workerflow: "a negative sleep duration is refused, and the run errors",
    reference: "accepted, as no sleep",
    resolution: toOracle,
  },
  "parallel-sleeps": {
    family: "sleeps",
    verdict: "failed",
    workerflow:
      "sleeps raced or awaited together end the run with WorkflowParallelWaitError",
    reference: "both sleeps run, and the run completes",
    resolution: "GRA-274 builds parallel sleeps and waits",
  },
  "wait-race": {
    family: "events",
    verdict: "failed",
    workerflow:
      "a wait raced against a sleep ends the run with WorkflowParallelWaitError",
    reference: "the event wins the race, and the run completes with it",
    resolution: "GRA-274 builds parallel sleeps and waits",
  },
  "wait-timeout-name": {
    family: "events",
    verdict: "unresolved",
    workerflow: "a wait's timeout is named WorkflowTimeoutError",
    reference: "named Error, with the same message",
    resolution: toOracle,
  },
  "event-type-rule": {
    family: "events",
    verdict: "unresolved",
    workerflow:
      "an event type follows the instance ID's rule; another is refused at the wait and at sendEvent",
    reference: "any string is taken",
    resolution: toOracle,
  },
  "event-to-ended-run": {
    family: "events",
    verdict: "unresolved",
    workerflow: "sendEvent to an ended run throws instance.not_running",
    reference: "taken, and ignored",
    resolution: toOracle,
  },
  "class-instance-result": {
    family: "serialization",
    verdict: "unresolved",
    workerflow:
      "a class instance a step returns is kept as its own fields, as structured clone keeps it",
    reference:
      "each attempt fails with DataCloneError and is retried, as an ordinary step error",
    resolution: toOracle,
  },
  "byob-stream": {
    family: "streams",
    verdict: "failed",
    workerflow: "a step's stream result refuses a BYOB reader",
    reference: "a byte stream: a BYOB reader reads it",
    resolution: "GRA-647 returns stream results as byte streams",
  },
  "invalid-stream-error": {
    family: "streams",
    verdict: "unresolved",
    workerflow:
      "a locked stream or one of text chunks ends the run with WorkflowFatalError",
    reference: "TypeError for a locked stream, DataCloneError for text chunks",
    resolution: toOracle,
  },
  "duplicate-create": {
    family: "binding-create-get",
    verdict: "unresolved",
    workerflow:
      "create with an ID that exists throws instance.already_exists, as Cloudflare's types say",
    reference: "returns the existing instance",
    resolution: toOracle,
  },
  "batch-limit": {
    family: "batch-operations",
    verdict: "decided",
    workerflow: "createBatch refuses more than 100 instances",
    reference: "takes 101",
    resolution: "Cloudflare's documented and typed limit of 100 (binding.ts)",
  },
  "batch-duplicates": {
    family: "batch-operations",
    verdict: "unresolved",
    workerflow:
      "createBatch creates an ID once, skips one that exists, and returns only what it created",
    reference:
      "returns an instance per entry, duplicates and existing IDs included; Cloudflare's types say an existing ID throws",
    resolution: toOracle,
  },
  "rolling-back-status": {
    family: "status",
    verdict: "unresolved",
    workerflow: "a run rolling back reports rollingBack",
    reference: "Cloudflare's types declare no rollingBack status",
    resolution: toOracle,
  },
  "waiting-status": {
    family: "status",
    verdict: "unresolved",
    workerflow: "a run suspended at an event wait reports waiting",
    reference: "running, until the event or the timeout",
    resolution: toOracle,
  },
  "status-fields": {
    family: "status",
    verdict: "unresolved",
    workerflow:
      "a status has output only when complete, and says how a rolling back ended (rollback)",
    reference: "output: null when not complete, and no rollback field",
    resolution: toOracle,
  },
  "terminate-rollback-error": {
    family: "rollbacks",
    verdict: "unresolved",
    workerflow:
      "a rollback of a terminated run is given an error named Terminated",
    reference: "named Error, with the same message",
    resolution: toOracle,
  },
  "suspension-events": {
    family: "subscriptions",
    verdict: "unresolved",
    workerflow:
      "workflow_waiting and workflow_running around every suspension (a sleep, a retry's backoff)",
    reference: "no events for a suspension",
    resolution: toOracle,
  },
  "event-config-timeout": {
    family: "subscriptions",
    verdict: "unresolved",
    workerflow: "step_started's config gives the timeout in milliseconds",
    reference: 'as the step gave it ("10 minutes")',
    resolution: toOracle,
  },
  "schedule-oracle": {
    family: "schedules",
    verdict: "unresolved",
    workerflow:
      "a schedule's occurrence starts a run with the schedule in its event (test/batches.test.ts)",
    reference: "no way to start a run from a schedule locally",
    resolution: "GRA-382: no local oracle exists for schedules",
  },
  "empty-step-name": {
    family: "retention-limits",
    verdict: "unresolved",
    workerflow: "an empty step name is refused, and the run errors",
    reference: "taken",
    resolution: toOracle,
  },
} as const satisfies Record<string, Discrepancy>;

export type DiscrepancyName = keyof typeof discrepancies;

const verdictRank: Record<Verdict, number> = {
  decided: 0,
  unresolved: 1,
  failed: 2,
};

/** A family's verdict on plain workerd: its worst discrepancy's. */
export const familyVerdict = (
  family: Family
): "qualified" | "failed" | "unresolved" => {
  let worst: Verdict = "decided";
  for (const discrepancy of Object.values(discrepancies)) {
    if (
      discrepancy.family === family &&
      verdictRank[discrepancy.verdict] > verdictRank[worst]
    ) {
      worst = discrepancy.verdict;
    }
  }
  return worst === "decided" ? "qualified" : worst;
};
