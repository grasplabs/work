import {
  generatedImport,
  generatorVersion,
} from "@grasp-os/open-workflow/generate";
import { schemaFromDescriptor } from "@grasp-os/sdk/host";
import { connectErrors } from "@grasp-os/shared/connect";
import { decidersSchema } from "@grasp-os/shared/decisions";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { expectedMessageOf, isExpectedError } from "@grasp-os/shared/errors";
import { identifierMaxLength } from "@grasp-os/shared/identifier";
import { runIdSchema } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import {
  workflowResourceErrors,
  workflowStateMaxBytes,
} from "@grasp-os/shared/workflow-resources";
import {
  executionErrors,
  paramsStep,
  placeholderOf,
  stepIdempotencyKey,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import { namedError } from "@grasp-os/workerflow/errors";
import { expressionErrors } from "@grasp-os/workflow-expressions/errors";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed } from "../audit-outbox.ts";
import { memberRole } from "../auth/identity.ts";
import type { DecisionOutcome } from "../decisions/decisions.ts";
import { generatedModule, stateStepOf } from "../workflow-builds.ts";
import type {
  LoadedBuild,
  SealedCall,
  SealedTask,
  SealedTemplate,
} from "../workflow-builds.ts";
import { writeWorkflowState } from "../workflow-state.ts";
import { AttemptHost, attemptCallLabels } from "./attempt-host.ts";
import type { AttemptCalls } from "./attempt-host.ts";
import { runModules } from "./code.ts";
import type { Settled, StepError } from "./code.ts";
import { emitEvent } from "./emitted-events.ts";
import { eventTypeKey } from "./event-envelopes.ts";
import { forIsolate, isCoreMarker, settle, unbilledAiWaitOf } from "./host.ts";
import type {
  DecisionWait,
  EventWaitPlan,
  HostControls,
  HostedRun,
  HostStepUse,
  RetryDecision,
  RetryOffer,
  RunKind,
  StepAttempt,
  StepLimits,
  WaitLength,
} from "./host.ts";
import type { AttemptAdmission } from "./quotas.ts";
import { callAction } from "./resource-action.ts";
import { requireCallAuthority, runAuthority } from "./resource-authority.ts";
import type { CallingRun } from "./resource-authority.ts";
import { auditAdmissionRefusal, makeCall } from "./resource-calls.ts";
import type { BuiltCall, Effect } from "./resource-calls.ts";
import { callCompute } from "./resource-compute.ts";
import {
  askDeciders,
  callInvalid,
  decisionRunOf,
  openRunDecision,
  promptOf,
  recipientsOf,
  requireDecisionAuthority,
  takeDecision,
} from "./resource-decisions.ts";
import {
  failureOf,
  matchesFilter,
  notCaught,
  raisedCode,
  retryable,
} from "./resource-errors.ts";
import type { CaughtError, Failure } from "./resource-errors.ts";
import { boundedJson } from "./resource-host.ts";
import type { ActionModelCalls, HostedResourceRun } from "./resource-host.ts";
import { requireResourceRunEvidenceReadable } from "./resource-reads.ts";
import { requirePackagesAdmitted } from "./sealed-packages.ts";

// What a run of a sealed build of a generated JSON workflow may do on the
// run host (host.ts, `RunHost`), with its workflow's resource authority:
// run the steps its build seals, and from inside a task's own step make
// that task's call, as the build sealed it, once. The isolate runs the
// build's code: it computes the values of the call's expression holes, and
// the host checks the rest of the call against the sealed template, fills
// in what the isolate may never see, and makes the call as a resource run
// makes it (resource-calls.ts).
//
// Threat model, and how each is closed. Everything the isolate sends is
// untrusted: it runs the build's code, but anything there could ask
// anything.
//
// - Code that isn't the build's. A run loads only its sealed build
//   (resource-runs.ts, `loadedRun`, or a test run's `loadedCandidateRun`,
//   then `sealedRunFrom`): the build its start's receipt pins, every artifact
//   checked against the manifest and the manifest against the pin
//   (workflow-builds.ts, `loadWorkflowBuild`), and the build's identity
//   against the manifest's, which is the hash its row pins, before its
//   isolate can be loaded with exactly that build's modules
//   (`sealedRunModules`, which takes only a run so loaded). A
//   tampered build never runs (`workflow.version_corrupt`), and nor does
//   one generated for another SDK than the run's main module runs
//   (`generatedForRunHost`): until GRA-1514, every stored build's.
// - A step the build doesn't have. Each engine step's name is one of the
//   sealed table's (`stepTableOf`): `<task>:<step>` for a step of a task
//   in no loop, `<task>:<step>@<i>/<j>…` inside items (`stepNameOf`), a
//   decision task's parts as the SDK's `#ask`, `#asked` and `#answer`
//   after either, `workflow:input` and `workflow:output` where the workflow has them,
//   and the SDK's `$params`. Any other name, one in another encoding of
//   the same key included, or a step run otherwise than it runs (a task's
//   step as a `do`, a sleeping task's own as its sleep, an event wait's
//   own as its wait, a try's catch as a catch), beside another step, or
//   again, is refused, and fails the run. A `fork`, a loop of items at
//   once, every task in one, and a listen that isn't an event wait
//   (`isEventWait`) have no steps in the table.
// - A loop's item it never had, or out of its order. A task inside loops
//   whose items run one after another names its item's index in each loop
//   its build seals around it, and nothing else: its loops are its task's.
//   Each index must be of an item the loop's enter step recorded (at most
//   the platform's 1,000 a collection, `workflow.collection_invalid`
//   past them), in a loop the run is still in, and of the item running
//   now; only the innermost may move on, to a later item only, by its
//   item step where its loop seals one (its `while`) and never by a catch.
//   An item passed over ran no step, its work all skipped: flow decided in
//   the isolate, as an `if` is, every call still held to its template.
//   A loop the run left (a step outside its items ran) runs no item more,
//   and no step starts twice, so its enter step can't open it again: so
//   items run in increasing order, none repeated, and a run's
//   steps stay bounded by its tasks and its recorded items (and the run's
//   own step ceiling). Stopping early is flow too. Each item's
//   steps have names, effects' keys, deadlines and retries of their own,
//   and a failure pending in an item holds every step but a catch back,
//   taken only by a try around its task: one in its own item (the item
//   running now) or around the loop, whose catch leaves the loop.
// - A call outside its task's step, or more than one. A call goes through
//   the host of the attempt whose code makes it (attempt-host.ts), only
//   while that attempt holds its lease and is the step running now, and
//   only from the step of a call task that makes its call (`<task>:task`).
//   Code outside any step has no attempt to call through (code.ts,
//   `workflow.outside_step`), and an attempt's host kept past its step is
//   refused as stale. Each attempt makes one call: a second is refused.
// - A call the build didn't seal. The binding, the operation, and every
//   literal of the sealed template must be the call's exactly; an object
//   must have exactly the template's keys, and an array exactly its
//   length (`matched`). An expression's hole (`slot`) takes any JSON
//   within a step's size: the host fills in no slot, so a placeholder
//   there is data. Every refusal fails the run.
// - A sensitive value reaching the isolate, or leaving where it mustn't.
//   The isolate gets only the parameters that aren't sensitive
//   (`sealedRunStart`). Where the build seals a sensitive parameter as a
//   connector call's argument (`param`), the call carries only its
//   placeholder (`{"$grasp:param": name}`, the SDK's `sensitiveParam`) of
//   that very parameter, and the host puts in the value the run's start
//   froze: never anywhere else, in no other kind of call. The value goes to
//   connect alone, and an answer that echoes it is refused
//   (resource-calls.ts, `BuiltCall.sensitive`), so it never reaches the
//   step's record. A connector's error reaches the isolate as its code
//   and that code's fixed message only (`fixedMessage`), never what the
//   connector or its tool said. The audit log keeps the arguments as the isolate sent
//   them, placeholders and not values, as a digest: it names things and
//   never carries their content (@grasp-os/shared/audit).
// - Authority that changed since the start. Every call is decided again as
//   it is made (`requireCallAuthority`, in `makeCall` and `emitEvent`): a
//   revoked approval, permission or role stops the next call
//   (`workflow.call_denied`). The person the run acts for must still be an
//   active member before every step.
// - An effect repeated. A store operation's, a model's and an action's
//   call goes out at most once per step, whatever its attempts
//   (`SentCalls`, marked sent just before it leaves, after every check of
//   its own, in the run's object, whose output gate holds the call until
//   the mark is durable (run-object.ts, `sentCallsIn`), so no later
//   activation, an evicted one's successor included, sends it again; a
//   later attempt fails as the one that sent it did, and one that
//   provably billed nothing may be sent again); a connector's is keyed in connect under its step's key,
//   and a call connect holds for the person ends its step as held, which
//   runs again once they decided.
// - A run past what it may spend. Its model calls, its actions' included,
//   are held to its ceiling (`maxModelCalls`) as they go out, counted in
//   the run's object across activations (run-object.ts, `modelCallsIn`),
//   so a replay spends nothing its earlier activations spent; each call is
//   one of its lineage's host calls; its attempts are admitted as its
//   activation says (resource-runs.ts, `sealedActivation`): an independent
//   run's as its workflow's (`workflow-resource:<id>`) in its account's
//   lineage, a test run's as its own.
// - A catch taking what it mustn't (spec 13.7). The host keeps its own
//   record of the failure no catch took yet (`#pending`), mapped by
//   resource-errors.ts from what it knows. A failure the host made keeps
//   its mapping: an attempt one of whose calls the host failed or refused
//   fails with that, whatever its code reports, throws instead, or
//   swallows, a function that rejects rather than reports included. One
//   only the isolate reports is an expression's, a task's data's, or the
//   task's own runtime failure, as the platform's unexpected one
//   (`isolateFailure`): never one no catch may take, so never a host's
//   relabelled. Each is decided on as the engine journaled it, so a
//   replay decides alike (host.ts, `#doStep`). While one is pending, the only step
//   that runs is a `try`'s catch (`RunHost.caught`): its code is offered
//   the error only when that catch may take it (one a catch may take, of
//   a task in its try's list, with every property of its sealed
//   `errors.with`) and decides by its `when` (decision 2); saying it took
//   what it wasn't offered, or that a catch with no conditions didn't
//   take what it was, is tampering. The step journals the error it
//   took, so a replay binds the same one. A run whose code goes on past a
//   failure no catch took is refused at its next step, or, ending well,
//   fails with that failure (`failureUntaken`, resource-runs.ts), as the
//   build's code, which rethrows it, would have.
// - A retry past its limits. The host runs a step's rounds (host.ts,
//   `#retried`), only after a failure that may be tried again
//   (`retryable`) of a task in the list of a try whose catch has a retry
//   policy with rounds left. The isolate only chooses which catch takes
//   the failure and whether its retry's `when` holds; the host holds that
//   to a try around the task whose filter the error has, and computes the
//   backoff and the limits itself, recorded (`retryDecided`): never past
//   the innermost catch with no conditions, which takes the failure, nor
//   without a retry of a policy with none.
// - A raise forged or swallowed. A raise's step fails with the error its
//   build sealed, by the host, unless its record says the task was
//   skipped (its `if`, decision 2).
// - Waking early, or a replay waiting otherwise. A literal wait sleeps
//   exactly its sealed length; a deadline's wait until exactly the
//   deadline its task's enter step recorded, at most a year ahead. The
//   isolate computes that deadline as it does any expression (decision
//   1), and leaving a wait out is flow, as an `if` is.
// - A decision asked of someone the binding doesn't allow, answered by
//   anyone else, or taken otherwise than it was answered. A decision task
//   (`grasp.decision`) runs as the SDK's `step.decision` does: its enter
//   step records what it asks, its task step opens it, a step of its own
//   asks its people, and a wait takes the answer.
//   - The enter step's record is held to the build's templates as a
//     call's arguments are (`matched`): every literal exact, a slot any
//     JSON, never a sensitive parameter; its recipients each named as
//     deciders (`person:`, `team:` or `role:`), the first its code's
//     `from`.
//   - The host opens the decision from that record alone, on the binding
//     the build seals (resource-decisions.ts, `openRunDecision`): each
//     recipient one the binding's frozen deciders cover now, never the
//     run's own person, who can't answer it as a member of a team or role
//     either; its authority decided again; its prompt the recorded one,
//     its deadline the sealed timeout's (else what is left of the run's
//     age), whatever its code asks. A step run again opens the decision
//     it opened (one per run and step). A test's run (a draft's, or one
//     an App's test started) opens none, and reaches nobody.
//   - Its task step must record exactly the decision the host opened in
//     it. Its asking step asks only that one, by the host's own notice
//     (`askDeciders`: the isolate learns nobody's address), its authority
//     decided again first, never reminding; once it asked, a failure of
//     the step the host hears of fails it for good, so a retry doesn't
//     ask again (one cut off unheard, its activation lost, may ask once
//     more: a second notice, never a second decision).
//   - Its wait is for that decision only, until its deadline
//     (`decisionWait`). The outcome is read from the decision's row,
//     never from the event that wakes the run nor from the isolate, and
//     taken only as the binding still allows it (`takeDecision`:
//     authority decided again, whoever answered still covered and never
//     the run's person, what they answered held to the contract's
//     response schema), in the step that records it, so a replay takes it
//     alike. A decision nobody answered before its deadline closes as
//     timed out, and the decision service refuses an answer after that.
// - An event wait taking an event the isolate made up, one sent to
//   another run, or through a binding the run may not use. An event wait
//   (`isEventWait`: the first event of any of its sealed types) runs only
//   as the host's own step (`RunHost.listen`), never as a step its code
//   records: its outcome is the event the engine took and journaled, or
//   that none came by its deadline (`{ timedOut: true }`). What it takes
//   is the build's alone (`eventWait`): the engine's types of its sealed
//   binding and types (`eventTypeKey`, so no other binding's event
//   matches), from the run's own inbox, which takes only events admitted
//   to this run through a binding its start froze (run-events.ts). Before
//   every wait, a replay's too, the binding must be one the start froze
//   and its authority must hold (`workflow.event_denied`); no catch takes
//   a wait's failure, so a replay refused after a revocation fails the
//   run rather than taking a path the run never took. Its deadline is
//   its sealed timeout from when it was first reached, as recorded, so a
//   replay waits alike; the engine takes each event once.
// - A test run sitting waiting. Its sleeps, its deadlines (from its start,
//   as recorded), its event waits' deadlines and its retries' backoffs are
//   held to its `maxSleepMs`
//   (`requireWait`): one past it fails the run, and no catch takes it.
// - State a step keeps between its workflow's runs (workflow-state.ts)
//   that the build didn't seal, or kept by a step that didn't succeed. A
//   task keeps only its sealed `state`'s keys, by its state step alone
//   (`stateStepOf`: its leave step, else its task step), whose record
//   must be exactly `{ output, state }` with exactly those keys, each
//   value held to its template as a call's (`matched`: literals exact, an
//   expression's value any JSON, never a sensitive parameter) and to the
//   descriptor of the value its key takes, by the SDK's own validator
//   (which generated code runs first, failing its step as data: a value
//   past it here got past the SDK), no marker of core's in it
//   (`#stateChecked`); anything else is tampering: the host holds them to the build, never to the isolate. It is written only as the host records the step
//   (host.ts, `RunKind.stepRecording`): after the host's last check of
//   the attempt, its lease held, so never by an attempt that failed, was
//   refused, caught or held, nor by a failed retry round. It writes
//   under the step's idempotency key, the same on every attempt, round
//   and replay, so it lands once: a crash between the write and the
//   journal writes nothing twice, and a replay of a journaled step writes
//   nothing at all. What lands stands, as the first write: should the
//   engine lose that attempt's result after it (its timeout, or storing
//   it failing), a later attempt's values aren't written, and if every
//   later attempt fails, the step fails with its state kept. More than a
//   workflow's state takes in all fails the step, a test run's too. A refused write
//   (too large, a run that ended) fails the step, after its call's
//   effect as `workflow.failed_after_effect`. A test run, a draft's or one
//   an App's test started, writes nothing, and nor does a restricted run,
//   whose state would carry what it read to the workflow's other runs
//   (restricted.ts): its skip is audited (`workflow.state.withheld`).
// - State changing under a run. A run reads its workflow's state once,
//   as its start is decided (a write or reset landing between that and
//   its admission is the next start's to read), frozen with its start's receipt (a draft's
//   test run with its row), and every activation hands the isolate that
//   same snapshot (`sealedRunStart`), whatever other runs write since. A
//   run an App's test started reads none: nothing of the organization's.
//   A reset, or the workflow's deletion, leaves those copies with the runs
//   that already started, until retention (a receipt's details) or the
//   sweep of test runs removes them.
// - An attempt longer than sealed. Each is held to its task's timeout and
//   its tries' retry attempt durations, and its engine retries are the
//   host's own (`limitsOf`), whatever its code declares.

/**
 * Whether `sdk` is the one a sealed build's generated module must import:
 * the SDK the run's main module runs it on (code.ts, `runMain`).
 */
const isRunHostSdk = (sdk: string): boolean => sdk === "@grasp-os/sdk/workflow";

/**
 * Whether `build` was generated for the run host: by the current
 * generator, whose modules import the SDK the run's main module runs. A
 * build of the generator before it (`@grasp-os/sdk/open-workflow`, which
 * names its steps and calls its host in another way) runs on
 * resource-host.ts only, until GRA-1514 regenerates every stored version
 * onto `@grasp-os/sdk/workflow`: so none is ever loaded here, where its
 * first step would be refused as one the build doesn't seal.
 */
export const generatedForRunHost = (build: LoadedBuild): boolean =>
  build.generator === generatorVersion && isRunHostSdk(generatedImport);

/** A run of a sealed build, as its activation loaded it (`sealedRunFrom`). */
export interface HostedSealedRun extends HostedRun {
  readonly workflowId: string;
  readonly version: number;
  /**
   * When it was admitted, in ms: a decision with no timeout waits out its
   * age, and a deadline's wait is measured from it.
   */
  readonly createdAt: number;
  /** Its sealed build, checked against the hash its row pins. */
  readonly build: LoadedBuild;
  /**
   * The parameter values its start froze, sensitive ones included: only
   * those the build lists as not sensitive reach the isolate.
   */
  readonly params: Readonly<Record<string, Json>>;
  /** Its input, as its start admitted it. */
  readonly input: Json;
  /**
   * What its workflow kept between runs as its start was admitted, frozen
   * with the start: the same in every activation (`$state`).
   */
  readonly state: Readonly<Record<string, Json>>;
  /** What its calls go by: its principal, invoker and frozen bindings. */
  readonly calling: CallingRun;
  /** The most model calls it may make: its build's and the host's lower. */
  readonly maxModelCalls: number;
  /**
   * For a test run (candidate-runs.ts): the longest any one of its waits
   * may last, a retry's backoff included, and the furthest past its start
   * a sleep until a deadline may end, in ms. One past it fails the run
   * (`workflow.candidate_wait_limit`, which no catch takes), so no test
   * run sits waiting for long.
   */
  readonly maxSleepMs?: number;
}

/**
 * The attempts of a run's steps whose call is tried once that sent it, by
 * the engine's key of the step and the attempt's number, and what each
 * such attempt failed with: kept with the run, written before the call
 * leaves (run-object storage commits before outgoing I/O), so an attempt
 * that died before it sent anything, in its admission say, leaves none.
 */
export interface SentCalls {
  /** Marks that attempt `attempt` of step `key` sent its call. */
  markSent: (key: string, attempt: number) => void;
  /** Takes the mark back: the call provably billed nothing. */
  unmarkSent: (key: string, attempt: number) => void;
  /** Whether that attempt sent its call. */
  sent: (key: string, attempt: number) => boolean;
  /** Keeps what an attempt that sent its call failed with. */
  keepFailure: (key: string, attempt: number, error: StepError) => void;
  /** What that attempt failed with, if it was kept. */
  failureOf: (key: string, attempt: number) => StepError | undefined;
}

/** What a sealed run's kind keeps with the run, across its activations. */
export interface SealedRunMemory {
  /** Its tried-once calls that went out (`SentCalls`). */
  sentCalls: SentCalls;
  /** The model calls it made, its actions' included. */
  modelCalls: ActionModelCalls;
  /** The run's own sandbox session on-prem, once open: its actions' parent. */
  sessionId?: () => string | undefined;
}

/** A `grasp.decision` call task. */
type DecisionTask = Extract<SealedTask, { kind: "call" }> & {
  call: Extract<SealedCall, { name: "grasp.decision" }>;
};

const isDecisionTask = (task: SealedTask | undefined): task is DecisionTask =>
  task?.kind === "call" && task.call.name === "grasp.decision";

/**
 * The parts `step.decision` runs of a decision task's step besides its
 * opening: asking its people, noting when, and waiting for the answer. A
 * reminder is none: a sealed decision never reminds.
 */
const decisionParts = ["ask", "asked", "answer"] as const;

/** A step of the sealed table: its task (none for the workflow's own). */
interface SealedStep {
  readonly task?: SealedTask;
  readonly kind: string;
}

/** A `for` task. */
type ForTask = Extract<SealedTask, { kind: "for" }>;

/**
 * Whether `task` is a loop whose items run one after another
 * (`concurrency` 1): the only items a sealed run runs. Items at once and a
 * `fork`'s branches don't run here yet.
 */
const isSequentialLoop = (task: SealedTask | undefined): task is ForTask =>
  task?.kind === "for" && task.loop.concurrency === 1;

/** The furthest ahead a deadline may be, as the engine sleeps: a year. */
const maxDeadlineMs = 365 * 86_400_000;

/** A `listen` task. */
type ListenTask = Extract<SealedTask, { kind: "listen" }>;

/**
 * Whether `task` is an event wait the run host runs: one that takes the
 * first event of any of its sealed types (`any`), through its sealed
 * binding, until its timeout of at most a year. The sealed listen's other
 * fields (`one` and `all`, filters by an event's attributes, correlations)
 * are resource-host.ts's until GRA-1366 removes it: such a listen has no
 * steps here, so it never runs, and `read` is never read (the wait always
 * answers the host's `EventWait`).
 */
const isEventWait = (task: SealedTask | undefined): task is ListenTask =>
  task?.kind === "listen" &&
  task.listen.strategy === "any" &&
  task.timeoutMs <= maxDeadlineMs &&
  task.listen.filters.every(
    (filter) => filter.attributes.length === 0 && filter.correlate === undefined
  );

/**
 * The steps `build` seals, by `<task>:<kind>`, the item indices of their
 * engine names left out (`stepNameOf`): the workflow's own, every task's
 * outside any loop, and every task's inside loops whose items run one
 * after another. A `fork`, a loop of items at once, and every task inside
 * one have no steps here, so they never run.
 */
const stepTableOf = (build: LoadedBuild): ReadonlyMap<string, SealedStep> => {
  const table = new Map<string, SealedStep>();
  if (build.workflow.input) {
    table.set("workflow:input", { kind: "input" });
  }
  if (build.workflow.output) {
    table.set("workflow:output", { kind: "output" });
  }
  const tasks = new Map(build.tasks.map((task) => [task.id, task]));
  for (const task of build.tasks) {
    const runs =
      task.kind !== "fork" &&
      (task.kind !== "for" || isSequentialLoop(task)) &&
      (task.kind !== "listen" || isEventWait(task)) &&
      task.scope.every((id) => isSequentialLoop(tasks.get(id)));
    if (runs) {
      for (const kind of task.steps) {
        table.set(`${task.id}:${kind}`, { task, kind });
      }
      // `step.decision`'s parts of a decision task's own step (the SDK's
      // `#part`): its asking, when it asked, and its wait for the answer.
      if (isDecisionTask(task) && task.steps.includes("task")) {
        for (const part of decisionParts) {
          table.set(`${task.id}:task#${part}`, { task, kind: part });
        }
      }
    }
  }
  return table;
};

/**
 * A step's key, as generated code gives it: its kind, and inside loop
 * items `@` and the index of its item in each loop around it, outermost
 * first (`item@2/5`). The loops are its task's sealed `scope`, so the key
 * names only the indices.
 */
const stepKeyPattern =
  /^(?<kind>[a-z]+)(?:@(?<path>(?:0|[1-9]\d{0,3})(?:\/(?:0|[1-9]\d{0,3}))*))?$/u;

/**
 * An engine step name, read: its name, its kind, its item indices, and
 * the SDK's part of a decision's step (`#ask`), if any.
 */
interface StepName {
  readonly id: string;
  readonly kind: string;
  readonly path: readonly number[];
  readonly part?: string;
}

/** A part of a step, as the SDK names it after its key (`#ask`). */
const stepPartPattern = /^[\w-]+$/u;

/**
 * Engine step `step` (`name:key`, its key URI-encoded, then `#part` for a
 * decision's parts, as the SDK names it) read as `stepKeyPattern` has
 * it; nothing for one that isn't in exactly that form, an encoding of the
 * same key otherwise included.
 */
const stepNameOf = (step: string): StepName | undefined => {
  const colon = step.indexOf(":");
  if (colon <= 0) {
    return undefined;
  }
  const id = step.slice(0, colon);
  // An encoded key holds no `#`: the first is the part's.
  const [encoded = "", part, ...more] = step.slice(colon + 1).split("#");
  if (more.length > 0 || (part !== undefined && !stepPartPattern.test(part))) {
    return undefined;
  }
  let key: string;
  try {
    key = decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
  const groups = stepKeyPattern.exec(key)?.groups;
  if (groups?.kind === undefined || encodeURIComponent(key) !== encoded) {
    return undefined;
  }
  return {
    id,
    kind: groups.kind,
    path: groups.path === undefined ? [] : groups.path.split("/").map(Number),
    ...(part === undefined ? {} : { part }),
  };
};

/** A step of the sealed table, as run in the items `path` names. */
interface ResolvedStep extends SealedStep {
  /** Its item's index in each loop around it, outermost first. */
  readonly path: readonly number[];
  /** The loops `path` indexes: an item step's own loop last. */
  readonly loops: readonly string[];
}

/**
 * Where task `id` runs in items `path` of its loops: `id`, then
 * `@<indices>` inside items. One place per run of a task.
 */
const placeOf = (id: string, path: readonly number[]): string =>
  path.length === 0 ? id : `${id}@${path.join("/")}`;

/** A loop whose items the run may still reach, by the place of its task. */
interface OpenLoop {
  /** How many items its enter step recorded. */
  readonly count: number;
  /** The item running now: -1 before its first. */
  current: number;
}

/** What a loop's enter step records, when not skipped. */
const itemsRecordSchema = z.object({
  items: z.array(z.json()).max(platformLimits.workflowCollectionItems),
});

/** The sealed calls a task's step makes through a binding. */
type BoundCall = Extract<
  SealedCall,
  {
    name:
      | "grasp.connector"
      | "grasp.operation"
      | "grasp.model"
      | "grasp.compute"
      | "grasp.action"
      | "grasp.emit";
  }
>;

/**
 * A task's call as the isolate makes it, `env[binding].call(operation,
 * arguments)`: the sealed binding, the connector's operation (the call's
 * own name for any other), and the template its arguments must match.
 */
interface CallTemplate {
  readonly call: BoundCall;
  readonly operation: string;
  readonly arguments: SealedTemplate;
}

/** `[key, template]`, or nothing for a part the build didn't seal. */
const partOf = (
  key: string,
  template: SealedTemplate | undefined
): [string, SealedTemplate][] =>
  template === undefined ? [] : [[key, template]];

/** The call template of `call`; none for a call the isolate never makes. */
const callTemplateOf = (call: SealedCall): CallTemplate | undefined => {
  switch (call.name) {
    case "grasp.connector": {
      return { call, operation: call.operation, arguments: call.arguments };
    }
    case "grasp.operation":
    case "grasp.compute":
    case "grasp.action": {
      return { call, operation: call.name, arguments: call.arguments };
    }
    case "grasp.model": {
      return {
        call,
        operation: call.name,
        arguments: {
          object: [
            ["instructions", call.instructions],
            ["input", call.input],
            ...partOf("model", call.model),
            ...partOf("maxOutputTokens", call.maxOutputTokens),
          ],
        },
      };
    }
    case "grasp.emit": {
      return {
        call,
        operation: call.name,
        arguments: {
          object: [["data", call.data], ...partOf("subject", call.subject)],
        },
      };
    }
    // Made by the host, or not yet run here.
    case "grasp.now":
    case "grasp.random":
    case "grasp.sleepUntil":
    case "grasp.decision": {
      return undefined;
    }
    default: {
      return call satisfies never;
    }
  }
};

/**
 * The calls whose step makes them once only (spec 13.7): a store
 * operation, run by another App's release, a model request, and an
 * action, whose effects aren't proven idempotent as a whole.
 */
const triedOnceCalls: ReadonlySet<SealedCall["name"]> = new Set([
  "grasp.operation",
  "grasp.model",
  "grasp.action",
]);

/**
 * What a tried-once call's attempt fails with when an earlier attempt sent
 * it and nothing it failed with was kept: that attempt was left open (its
 * activation died, or the engine gave up on it as it ran past its time,
 * the only failures the host doesn't hear of: `RunKind.attemptFailed`),
 * as the engine's timeout failed it.
 */
const leftOpen: StepError = {
  name: "TimeoutError",
  message: "The step ran out of time.",
};

/**
 * `failure`, what the attempt that sent a tried-once call failed with, as
 * every later attempt of its step fails: never retried, its message and
 * code kept, a timeout's code `operation.deadline_exceeded` (as the old
 * host's `lastRetry`, resource-host.ts).
 */
const triedBefore = (failure: StepError): Error =>
  namedError(
    "NonRetryableError",
    failure.message,
    failure.code ??
      (failure.name === "TimeoutError"
        ? "operation.deadline_exceeded"
        : "internal.unexpected")
  );

/**
 * `error`, a connector call's failure, with its code's own fixed message
 * (and no details): so nothing a connector or its tool said, a sensitive
 * argument quoted included, reaches the isolate through it.
 */
const fixedMessage = (error: unknown): unknown => {
  if (!isExpectedError(error)) {
    return error;
  }
  return namedError(
    error.name,
    expectedMessageOf(error.code) ?? "The connector call failed.",
    error.code
  );
};

/** A refusal of what the build's code never sends: the run fails with it. */
const tampering = (message: string): Error => {
  const error = workflowErrors.create("workflow.invalid");
  error.message = message;
  return error;
};

/** The `try` tasks of `build` whose list holds `task`, innermost first. */
const triesAround = (
  build: LoadedBuild,
  task: SealedTask
): Extract<SealedTask, { kind: "try" }>[] =>
  build.tasks
    .filter(
      (around): around is Extract<SealedTask, { kind: "try" }> =>
        around.kind === "try" &&
        task.pointer.startsWith(`${around.pointer}/try/`)
    )
    .toSorted((a, b) => b.pointer.length - a.pointer.length);

/** Whether `task`'s own step sleeps: a wait, or a `grasp.sleepUntil` call. */
const sleepsOf = (task: SealedTask): boolean =>
  task.kind === "wait" ||
  (task.kind === "call" && task.call.name === "grasp.sleepUntil");

/**
 * Whether `task` sleeps until a deadline its enter step records: a wait
 * of an expression's duration, or a `grasp.sleepUntil` call.
 */
const sleepsUntil = (task: SealedTask): boolean =>
  (task.kind === "wait" && task.duration !== undefined) ||
  (task.kind === "call" && task.call.name === "grasp.sleepUntil");

/** The longest a retry's backoff may sleep, as the engine sleeps: a year. */
const maxRetryDelayMs = 365 * 86_400_000;

/** A task's step that records that its `if` skipped it. */
const skippedSchema = z.strictObject({ skipped: z.literal(true) });

/** What a deadline's enter step records, when not skipped. */
const deadlineRecordSchema = z.object({ until: z.int().min(0) });

/** What a decision task's enter step records, when not skipped. */
const decisionRecordSchema = z.strictObject({
  recipients: z.json(),
  prompt: z.json(),
  input: z.json(),
});

/** What a decision task's step records: the decision the host opened. */
const openedSchema = z.strictObject({
  decision: z.string(),
  deadline: z.number(),
});

/** How the SDK opens a decision (`step.decision`). */
const openingSchema = z.strictObject({
  step: z.string(),
  from: z.string(),
  // The host's own: it asks the prompt its enter step recorded (which the
  // SDK passes trimmed), until the sealed timeout's deadline.
  description: z.unknown(),
  timeout: z.unknown(),
});

/** As long as a decision's wait may be: its deadline comes first. */
const maxDecisionWaitMs = 365 * 86_400_000;

/** What a decision asks, as its task's enter step recorded it. */
interface DecisionAsks {
  /** Its recipients as deciders (`recipientsOf`). */
  readonly recipients: readonly string[];
  readonly prompt: string;
  readonly input: Json;
}

/** What a catch step journals (`RunHost.caught`): what it took, if any. */
const caughtJournalSchema = z.union([
  z.strictObject({ caught: z.literal(false) }),
  z.strictObject({ caught: z.literal(true), error: z.json() }),
]);

/**
 * Which catch takes a failure, as a retry function chooses it: the `try`
 * task whose catch does (`by`), and whether its retry's `when` holds; or
 * none.
 */
const retryChoiceSchema = z
  .strictObject({ by: z.string(), retry: z.boolean() })
  .nullable();

/**
 * A sealed run's steps' engine retries, whatever its code declares: a
 * failure trying again may fix (a timeout, the isolate's CPU, a busy
 * store) is tried twice more, a second apart and doubling, as the old
 * engine did. A catch's retry policy runs rounds of its own around them.
 */
const sealedRetries = {
  limit: 2,
  delay: 1000,
  backoff: "exponential",
} as const satisfies NonNullable<StepLimits["retries"]>;

/** What a failure only a task's code reports says, past its code. */
const taskFailed = "The task failed.";

/** The codes of a task's own data that didn't fit its schema. */
const dataCodes: ReadonlySet<string> = new Set([
  "workflow.task_data_invalid",
  "workflow.output_invalid",
]);

/**
 * `error`, a failure only the isolate reports, as the host takes it: an
 * expression's or a task's data's by its code, any other the task's own
 * runtime failure, with no code, each in the platform's words. Never a timeout, a host's code or one no
 * catch may take: the host keeps what it made itself (`#hostFailures`).
 */
const isolateFailure = (error: StepError): StepError => {
  const { code } = error;
  // Only a code the platform defines: one core reads back the same from
  // the engine's journal, so a replay maps it alike (host.ts, `forIsolate`).
  const kept =
    expressionErrors.codeOf(error) !== undefined ||
    (code !== undefined && dataCodes.has(code));
  // The platform's words for it, never its code's: a message the isolate
  // chose could read back as a timeout or a CPU kill (host.ts,
  // `forIsolate`), and could quote what the run read.
  return kept
    ? {
        name: "Error",
        message: expectedMessageOf(code ?? "") ?? taskFailed,
        code,
      }
    : { name: "Error", message: taskFailed };
};

/**
 * What a step whose call took effect fails with when anything of it fails
 * after: never a catch's to take (resource-errors.ts), as a catch would
 * take it as a call that didn't.
 */
const failedAfterEffect: StepError = {
  name: "Error",
  message: workflowResourceErrors.create("workflow.failed_after_effect")
    .message,
  code: "workflow.failed_after_effect",
};

/** What a raise task's step fails with: its sealed error, the workflow's own. */
const raisedBy = (task: Extract<SealedTask, { kind: "raise" }>): StepError => ({
  name: "Error",
  message:
    task.error.title ?? workflowResourceErrors.create(raisedCode).message,
  code: raisedCode,
});

/**
 * Whether a catch or its retry policy decides with no condition of its
 * own (`when`, `exceptWhen`): the isolate has nothing to decide for it.
 */
const unconditional = (
  conditions: { when?: number; exceptWhen?: number } | undefined
): boolean =>
  conditions !== undefined &&
  conditions.when === undefined &&
  conditions.exceptWhen === undefined;

/**
 * Where among `tries` (innermost first) the innermost catch is that takes
 * `error` whatever its code says: its filter has it, and it has no
 * conditions; -1 for none.
 */
const forcedOf = (
  tries: readonly Extract<SealedTask, { kind: "try" }>[],
  error: CaughtError
): number =>
  tries.findIndex(
    (around) =>
      matchesFilter(error, around.catch.errors) && unconditional(around.catch)
  );

/**
 * Whether `around`'s catch retries round `round` whatever its code says:
 * its policy has rounds left and no conditions.
 */
const forcedRetry = (
  around: Extract<SealedTask, { kind: "try" }> | undefined,
  round: number
): boolean => {
  const policy = around?.catch.retry;
  return (
    policy !== undefined && round < policy.attempts && unconditional(policy)
  );
};

/**
 * The backoff before round `round + 1` of `policy`, its jitter drawn here.
 */
const backoffOf = (
  policy: NonNullable<Extract<SealedTask, { kind: "try" }>["catch"]["retry"]>,
  round: number
): number => {
  let factor = 1;
  if (policy.backoff === "linear") {
    factor = round;
  } else if (policy.backoff === "exponential") {
    factor = 2 ** (round - 1);
  }
  const { jitter } = policy;
  return (
    policy.delayMs * factor +
    (jitter === undefined
      ? 0
      : Math.round(
          jitter.fromMs + Math.random() * (jitter.toMs - jitter.fromMs)
        ))
  );
};

/**
 * Round `round + 1` of `policy` after its backoff, from `firstFailedAt`:
 * none past its duration limit, nor a year.
 */
const scheduled = (
  policy: NonNullable<Extract<SealedTask, { kind: "try" }>["catch"]["retry"]>,
  round: number,
  firstFailedAt: number
): RetryDecision => {
  const delayMs = backoffOf(policy, round);
  const limited =
    policy.limitMs !== undefined &&
    Date.now() + delayMs - firstFailedAt > policy.limitMs;
  return limited || delayMs > maxRetryDelayMs
    ? { retry: false, delayMs: 0, firstFailedAt }
    : { retry: true, delayMs, firstFailedAt };
};

/**
 * What the isolate's retry `choice` of round `round`, of a task in the
 * lists of `tries` (innermost first), decides. It names the try whose
 * catch takes `error` (decision 2: its `when`), which must be one of
 * them whose filter `error` has, and none past the innermost such catch
 * with no conditions, which takes it whatever the isolate says; and
 * whether that catch's retry `when` holds, which a policy with no
 * conditions does. Anything else is tampering. It retries while the
 * policy has rounds left, after its backoff, and none past its duration
 * limit from `firstFailedAt`, nor a year.
 */
export const retryDecided = (
  tries: readonly Extract<SealedTask, { kind: "try" }>[],
  error: CaughtError,
  round: number,
  choice: unknown,
  firstFailedAt: number
): RetryDecision => {
  const stop = { retry: false, delayMs: 0, firstFailedAt };
  const forced = forcedOf(tries, error);
  if (choice === undefined) {
    // Its code failed to choose (an expression of a `when` that failed):
    // no retry, and no catch it named. (Where the build leaves it nothing
    // to decide, the host decides alone: `RetryOffer.alone`.)
    return stop;
  }
  const chosen = retryChoiceSchema.safeParse(choice);
  if (!chosen.success) {
    throw tampering("A retry's choice names a catch and whether it retries.");
  }
  const by = chosen.data?.by;
  const at = tries.findIndex(({ id }) => id === by);
  const around = tries[at];
  if (chosen.data === null) {
    if (forced !== -1) {
      throw tampering(
        `Task "${tries[forced]?.id ?? ""}"'s catch takes the failure.`
      );
    }
    return { ...stop, by: null };
  }
  if (
    around === undefined ||
    !matchesFilter(error, around.catch.errors) ||
    (forced !== -1 && at > forced)
  ) {
    throw tampering(`Task "${by ?? ""}"'s catch can't take the failure.`);
  }
  if (!chosen.data.retry && forcedRetry(around, round)) {
    throw tampering(`Task "${around.id}"'s catch retries the failure.`);
  }
  const policy = around.catch.retry;
  return {
    ...(chosen.data.retry && policy !== undefined && round < policy.attempts
      ? scheduled(policy, round, firstFailedAt)
      : stop),
    by: around.id,
  };
};

/**
 * What a deadline's enter step whose record is `value` fails with, if its
 * deadline isn't one: a time in ms since the epoch, at most a year ahead.
 */
const deadlineUnfit = (value: unknown): StepError | undefined => {
  const until = deadlineRecordSchema.safeParse(value).data?.until;
  return until !== undefined && until - Date.now() <= maxDeadlineMs
    ? undefined
    : forIsolate(
        workflowResourceErrors.create("workflow.call_invalid", {
          issues: ["until: Give a time in milliseconds at most a year ahead."],
        })
      );
};

/**
 * What a loop's enter step whose record is `value` fails with, if it
 * records no items, or more than a run fans out over (1,000).
 */
const itemsUnfit = (value: unknown): StepError | undefined =>
  itemsRecordSchema.safeParse(value).success
    ? undefined
    : forIsolate(workflowResourceErrors.create("workflow.collection_invalid"));

/**
 * Whether `value` is one the host records of a step: JSON within a step's
 * result, and no marker of core's (host.ts, `#doStep`).
 */
const recordable = (value: unknown): boolean => {
  if (isCoreMarker(value) || !z.json().optional().safeParse(value).success) {
    return false;
  }
  return (
    new TextEncoder().encode(JSON.stringify(value) ?? "").byteLength <=
    platformLimits.stepPayloadBytes
  );
};

/** A task that keeps something in its workflow's state, and what. */
interface Keeps {
  readonly task: SealedTask;
  readonly kept: NonNullable<SealedTask["state"]>;
}

/**
 * What the step of kind `kind` of `task` keeps in its workflow's state:
 * nothing but for its state step (`stateStepOf`) of a task whose sealed
 * `state` names a key.
 */
const keepsOf = (
  task: SealedTask | undefined,
  kind: string | undefined
): Keeps | undefined =>
  task?.state === undefined ||
  Object.keys(task.state).length === 0 ||
  kind !== stateStepOf(task)
    ? undefined
    : { task, kept: task.state };

const utf8 = new TextEncoder();

/** What a state step records: its output, and what it keeps by key. */
const stateRecordSchema = z.strictObject({
  output: z.json(),
  state: z.record(z.string(), z.json()),
});

/** Whether `value` is a list. */
const isList = (value: Json): value is readonly Json[] => Array.isArray(value);

/** Whether `value` is an object, not a list. */
const isRecord = (
  value: Json
): value is Readonly<Record<string, Json | undefined>> =>
  typeof value === "object" && value !== null && !isList(value);

/**
 * `sent`, the arguments the isolate sent, matched against `template` at
 * `path`: each literal exactly, an object's keys exactly, an array's
 * length exactly, a slot any JSON (the host fills in no slot, so what
 * looks like a placeholder there is data), and a sensitive
 * parameter's place only that parameter's placeholder, its value put in
 * by `fill` (none where no sensitive parameter may be) and kept in
 * `sensitive`. Throws `tampering` for anything else.
 */
const matched = (
  template: SealedTemplate,
  sent: Json,
  path: string,
  fill: ((name: string) => Json | undefined) | undefined,
  sensitive: Json[]
): Json => {
  if ("literal" in template) {
    if (canonicalJson(sent) !== canonicalJson(template.literal)) {
      throw tampering(`${path} isn't the value the build sealed.`);
    }
    return template.literal;
  }
  if ("slot" in template) {
    return sent;
  }
  if ("param" in template) {
    const name = placeholderOf(sent);
    if (name !== template.param) {
      throw tampering(
        `${path} takes only the placeholder of the sensitive parameter "${template.param}".`
      );
    }
    const value = fill?.(name);
    if (value === undefined) {
      throw tampering(
        `${path} is a sensitive parameter the run has no value of here.`
      );
    }
    sensitive.push(value);
    return value;
  }
  if ("array" in template) {
    if (!isList(sent) || sent.length !== template.array.length) {
      throw tampering(
        `${path} isn't a list of the ${template.array.length} items the build sealed.`
      );
    }
    return template.array.map((item, index) =>
      matched(item, sent[index] ?? null, `${path}[${index}]`, fill, sensitive)
    );
  }
  const keys = new Set(template.object.map(([key]) => key));
  if (
    !isRecord(sent) ||
    Object.keys(sent).length !== keys.size ||
    Object.keys(sent).some((key) => !keys.has(key))
  ) {
    throw tampering(`${path} hasn't exactly the keys the build sealed.`);
  }
  // Own data properties, in the template's order: no key, `__proto__`
  // included, is anything else.
  const object: Record<string, Json> = {};
  for (const [key, item] of template.object) {
    Object.defineProperty(object, key, {
      value: matched(
        item,
        sent[key] ?? null,
        `${path}.${key}`,
        fill,
        sensitive
      ),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return object;
};

/** A model call's arguments, as their template matched them. */
const modelArgumentsSchema = z.strictObject({
  instructions: z.json(),
  input: z.json(),
  model: z.json().optional(),
  maxOutputTokens: z.json().optional(),
});

/** An emit's arguments, as their template matched them. */
const emitArgumentsSchema = z.strictObject({
  data: z.json(),
  subject: z.json().optional(),
});

/** How a connection binding's stub sends a call: `[operation, arguments, options]`. */
const sentCallSchema = z.union([
  z.tuple([z.string(), z.unknown()]),
  z.tuple([z.string(), z.unknown(), z.undefined()]),
]);

class SealedRun implements SealedRunKind {
  readonly #env: Env;
  readonly #host: HostControls;
  readonly #memory: SealedRunMemory;
  readonly #steps: ReadonlyMap<string, SealedStep>;
  /** The attempts that made their call: each makes one. */
  readonly #called = new WeakSet<StepAttempt>();
  /**
   * The first failure the host made of each attempt's calls (a call it
   * failed, or refused): the attempt fails with it, whatever its code
   * reports or swallows (`attemptSettled`).
   */
  readonly #hostFailures = new WeakMap<StepAttempt, StepError>();
  /** The attempts a call of which took effect: it answered. */
  readonly #effected = new WeakSet<StepAttempt>();
  /** What each state step's accepted attempt keeps (`#stateChecked`). */
  readonly #keeps = new WeakMap<StepAttempt, Record<string, Json>>();
  /** The error each catch step's attempt was offered (`caughtOffer`). */
  readonly #offers = new WeakMap<StepAttempt, CaughtError>();
  /**
   * The failure no catch took yet, fresh or replayed, as this activation
   * reaches the steps (`stepEnded`): while there is one, only a catch
   * step runs.
   */
  #pending: Failure | undefined;
  /** The pending failure as the engine journaled it (`failureUntaken`). */
  #pendingError: StepError | undefined;
  /**
   * The catch the pending failure's step's last retry decision said takes
   * it (null for none), if one decided: no other catch is offered it.
   */
  #pendingBy: string | null | undefined;
  /**
   * Each sleeping task's deadline, as its enter step recorded it, by the
   * place it runs in (`placeOf`): each item of a loop has its own.
   */
  readonly #deadlines = new Map<string, number>();
  /** What each decision task asks, as its enter step recorded it. */
  readonly #asks = new Map<string, DecisionAsks>();
  /** The decision each decision task's step opened, as it recorded it. */
  readonly #opened = new Map<string, string>();
  /** The decision each attempt of a decision task's step opened. */
  readonly #openings = new WeakMap<
    StepAttempt,
    { decision: string; deadline: number }
  >();
  /** The `for` tasks whose items run here, by ID (`isSequentialLoop`). */
  readonly #loopTasks: ReadonlyMap<string, ForTask>;
  /**
   * The loops whose items the run may still reach, by the place of their
   * task, as this activation reaches their enter steps: those around the
   * step that ran last, and one just entered. Any other is over: none of
   * its items runs again (`#loopRefusal`).
   */
  readonly #loops = new Map<string, OpenLoop>();
  /**
   * The steps this activation let start: none starts twice, so no loop
   * is entered again to run its items over.
   */
  readonly #started = new Set<string>();
  /**
   * The step running now, from when the host let it start until it ended
   * (`stepEnded`): the build's code runs its steps one at a time, so none
   * starts beside another, nor during a retry's decision.
   */
  #running: string | undefined;
  readonly run: HostedSealedRun;
  readonly audit: RunKind["audit"];
  readonly decisionRun: RunKind["decisionRun"];
  readonly aiWaitRun: RunKind["aiWaitRun"];

  constructor(
    env: Env,
    run: HostedSealedRun,
    memory: SealedRunMemory,
    host: HostControls
  ) {
    this.#env = env;
    this.#host = host;
    this.#memory = memory;
    this.#steps = stepTableOf(run.build);
    this.#loopTasks = new Map(
      run.build.tasks.flatMap((task) =>
        isSequentialLoop(task) ? [[task.id, task] as const] : []
      )
    );
    this.run = run;
    this.audit = {
      actor: { type: "system" },
      target: { type: "workflow_run", id: run.runId },
      detail: {
        workflow: run.workflowId,
        version: run.version,
        build: run.build.hash,
      },
    };
    this.decisionRun = decisionRunOf(run.calling);
    this.aiWaitRun = { kind: "resource", runId: run.runId };
  }

  /** The person the run acts for must still be an active member. */
  async requirePerson(): Promise<void> {
    if (
      (await memberRole(this.#env.DB, this.run.calling.principal)) === undefined
    ) {
      throw permissionErrors.create("permission.person_inactive");
    }
  }

  /**
   * The failure no catch took, as the engine journaled it, if one is
   * pending as the run's code ends: a run whose code ends well with one
   * went on past it, and fails with it (resource-runs.ts), as the build's
   * code, which rethrows what no catch took, would have.
   */
  get failureUntaken(): StepError | undefined {
    return this.#pending === undefined ? undefined : this.#pendingError;
  }

  /**
   * Refuses a durable wait past a test run's `maxSleepMs`
   * (`workflow.candidate_wait_limit`): one of `ms`, or one until `until`,
   * measured from the run's start, as recorded, so a replay refuses
   * alike. Any wait of any other run.
   */
  requireWait(wait: WaitLength): void {
    const { maxSleepMs, createdAt } = this.run;
    const ms = "ms" in wait ? wait.ms : wait.until - createdAt;
    if (maxSleepMs !== undefined && ms > maxSleepMs) {
      throw workflowResourceErrors.create("workflow.candidate_wait_limit", {
        limit: maxSleepMs,
      });
    }
  }

  /**
   * Refuses a step the sealed table doesn't have, or not as it runs: a
   * task's step as a `do`, but a sleeping task's own as its sleep (of
   * exactly its sealed length, or until exactly its recorded deadline),
   * an event wait's own as its wait, and a try's catch as a catch; in an item its loops don't have, or out
   * of their order (`#loopRefusal`). While a failure no catch took is
   * pending, any step but a catch; while another step runs, any step; a
   * step that started already, again. A step it lets start runs until it
   * ends (`stepEnded`).
   */
  stepRefusal(
    step: string,
    use: HostStepUse,
    time?: number
  ): Error | undefined {
    if (this.#running !== undefined) {
      return tampering(
        `Step "${step}" starts only once step "${this.#running}" ended.`
      );
    }
    if (this.#pending !== undefined && use !== "caught") {
      return tampering(
        "A run goes on past a failure only once a catch took it."
      );
    }
    if (this.#started.has(step)) {
      return tampering(`Step "${step}" runs once.`);
    }
    if (step === paramsStep) {
      if (use !== "do") {
        return tampering(`Step "${step}" isn't one the build seals.`);
      }
    } else {
      const sealed = this.#stepOf(step);
      if (sealed === undefined || !this.#runsAs(sealed, use, time)) {
        return tampering(`Step "${step}" isn't one the build seals.`);
      }
      const refusal = this.#loopRefusal(sealed, use);
      if (refusal !== undefined) {
        return tampering(refusal);
      }
      this.#enterItems(sealed);
    }
    this.#started.add(step);
    this.#running = step;
    return undefined;
  }

  /**
   * Engine step `step` as the sealed table has it, in the items its name
   * says: its task's sealed loops, one index for each (an item step's own
   * loop last). Nothing for any other name.
   */
  #stepOf(step: string): ResolvedStep | undefined {
    const name = stepNameOf(step);
    const sealed =
      name === undefined
        ? undefined
        : this.#steps.get(
            `${name.id}:${name.kind}${name.part === undefined ? "" : `#${name.part}`}`
          );
    if (name === undefined || sealed === undefined) {
      return undefined;
    }
    const scope = sealed.task?.scope ?? [];
    const loops =
      sealed.kind === "item" && sealed.task !== undefined
        ? [...scope, sealed.task.id]
        : scope;
    return loops.length === name.path.length
      ? { ...sealed, path: name.path, loops }
      : undefined;
  }

  /**
   * Why `step` may not run in the items its path names, run as `use`; or
   * nothing. Each item must be one its loop's enter step recorded, in a
   * loop the run is still in (`#loops`), and the one running now; only at
   * the innermost level may the step start a later item of that loop than
   * the one running: its item step when the loop seals one, otherwise any
   * step but a catch. An item between them ran no step (its work all
   * skipped, or the code's choice, as an `if` is). So items run in
   * increasing order, none again, none after the run left their loop, and
   * an item step starts its item, once.
   */
  #loopRefusal(step: ResolvedStep, use: HostStepUse): string | undefined {
    const { path, loops, kind } = step;
    for (const [depth, index] of path.entries()) {
      const id = loops[depth] ?? "";
      const loop = this.#loops.get(placeOf(id, path.slice(0, depth)));
      if (loop === undefined || index >= loop.count) {
        return `Loop "${id}" has no item ${index} here.`;
      }
      const innermost = depth === path.length - 1;
      const startsItem = innermost && kind === "item";
      const next =
        innermost &&
        index > loop.current &&
        use !== "caught" &&
        (startsItem ||
          this.#loopTasks.get(id)?.steps.includes("item") === false);
      if (index === loop.current ? startsItem : !next) {
        return `Item ${index} of loop "${id}" doesn't run now: its items run in increasing order, each once.`;
      }
    }
    return undefined;
  }

  /**
   * Notes that `step`, which `#loopRefusal` let run, runs in the items
   * its path names: an item it names past the one running starts; any
   * loop it runs in none of the items of is over.
   */
  #enterItems({ path, loops }: ResolvedStep): void {
    const around = new Set<string>();
    for (const [depth, index] of path.entries()) {
      const place = placeOf(loops[depth] ?? "", path.slice(0, depth));
      around.add(place);
      const loop = this.#loops.get(place);
      if (loop !== undefined) {
        loop.current = index;
      }
    }
    for (const place of this.#loops.keys()) {
      if (!around.has(place)) {
        this.#loops.delete(place);
      }
    }
  }

  /** `stepRefusal`'s check of a step of the sealed table, `sealed`. */
  #runsAs(
    sealed: ResolvedStep,
    use: HostStepUse,
    time: number | undefined
  ): boolean {
    const { task, kind, path } = sealed;
    const sleeps = kind === "task" && task !== undefined && sleepsOf(task);
    const listens = kind === "task" && isEventWait(task);
    if (use === "do") {
      return kind !== "catch" && kind !== "answer" && !sleeps && !listens;
    }
    if (use === "listen") {
      return listens;
    }
    if (use === "waitForDecision") {
      return kind === "answer";
    }
    if (use === "caught") {
      return kind === "catch" && task?.kind === "try";
    }
    return (
      sleeps &&
      task !== undefined &&
      this.#sleepsAs(task, placeOf(task.id, path), use, time)
    );
  }

  /**
   * `#runsAs`'s check of sleeping task `task`'s own step's sleep, where it
   * runs at `place` (`placeOf`).
   */
  #sleepsAs(
    task: SealedTask,
    place: string,
    use: HostStepUse,
    time: number | undefined
  ): boolean {
    if (time === undefined) {
      return false;
    }
    if (use === "sleep") {
      return task.kind === "wait" && time === task.milliseconds;
    }
    return (
      use === "sleepUntil" &&
      sleepsUntil(task) &&
      time === this.#deadlines.get(place)
    );
  }

  /**
   * Every step's engine retries, whatever its code declared
   * (`sealedRetries`), and the longest an attempt of `step` may take: its
   * task's timeout, and each retry policy's attempt duration of the tries
   * around it.
   */
  limitsOf(step: string): StepLimits {
    const task = this.#stepOf(step)?.task;
    if (task === undefined) {
      return { retries: sealedRetries };
    }
    const limits = [
      // A listen's timeout is how long it waits for its events, never
      // how long an attempt of its steps may take.
      ...(task.timeoutMs === undefined || task.kind === "listen"
        ? []
        : [task.timeoutMs]),
      ...triesAround(this.run.build, task).flatMap((around) =>
        around.catch.retry?.attemptMs === undefined
          ? []
          : [around.catch.retry.attemptMs]
      ),
    ];
    return {
      retries: sealedRetries,
      ...(limits.length === 0 ? {} : { timeout: Math.min(...limits) }),
    };
  }

  /**
   * The error a catch step's `attempt` offers its code: the failure
   * pending, if its catch may take it (one a catch may take, of a task in
   * its try's list, with every property of its `errors.with`).
   */
  caughtOffer(attempt: StepAttempt): Json | undefined {
    const task = this.#stepOf(attempt.step)?.task;
    const pending = this.#pending;
    if (
      task?.kind !== "try" ||
      pending?.catchable !== true ||
      !pending.error.instance.startsWith(`${task.pointer}/try/`) ||
      !matchesFilter(pending.error, task.catch.errors)
    ) {
      return undefined;
    }
    // A catch further in with no conditions takes it, whatever the code
    // asks of this one.
    const { error } = pending;
    const takenFurtherIn = this.run.build.tasks.some(
      (inner) =>
        inner.kind === "try" &&
        inner.pointer.startsWith(`${task.pointer}/try/`) &&
        error.instance.startsWith(`${inner.pointer}/try/`) &&
        matchesFilter(error, inner.catch.errors) &&
        unconditional(inner.catch)
    );
    // Its retry's decision said which catch takes it: no other.
    const decided = this.#pendingBy;
    if (takenFurtherIn || (decided !== undefined && decided !== task.id)) {
      return undefined;
    }
    this.#offers.set(attempt, pending.error);
    return { ...pending.error };
  }

  /**
   * What `attempt` settled with, as the host takes it: the failure the
   * host made of its calls, if any; a failure only its code reports, as
   * `isolateFailure` maps it; a catch's answer as what it journals; a
   * raise not skipped as its sealed error; a deadline's enter step only
   * with a deadline at most a year ahead.
   */
  async attemptSettled(
    attempt: StepAttempt,
    result: Settled<unknown>,
    cut = false
  ): Promise<Settled<unknown>> {
    const made = this.#hostFailures.get(attempt);
    if (made !== undefined) {
      // Past a call that took effect, a later refusal fails it after it.
      return {
        ok: false,
        error: this.#effected.has(attempt) ? failedAfterEffect : made,
      };
    }
    if (!result.ok) {
      return {
        ok: false,
        error: this.#reportedFailure(attempt, result.error, cut),
      };
    }
    return await this.#recordChecked(attempt, result.value);
  }

  /**
   * A failure only `attempt`'s code reports, `error` (or its cut-off past
   * its CPU time), as the host takes it: once a call of it took effect,
   * `workflow.failed_after_effect`,
   * which no catch takes, as a catch would take it as a call that didn't;
   * of a raise's step, its sealed error, unless its `if` failed as an
   * expression; otherwise as `isolateFailure` maps it.
   */
  #reportedFailure(
    attempt: StepAttempt,
    error: StepError,
    /** Whether the Loader cut it off: `error` is core's timeout. */
    cut: boolean
  ): StepError {
    if (this.#effected.has(attempt)) {
      return failedAfterEffect;
    }
    const reported = cut ? error : isolateFailure(error);
    const { task, kind } = this.#stepOf(attempt.step) ?? {};
    return kind === "task" &&
      task?.kind === "raise" &&
      expressionErrors.codeOf(reported) === undefined
      ? raisedBy(task)
      : reported;
  }

  /**
   * A catch step's answer, `value`: whether its catch takes the error it
   * was offered, as what it journals. Taking what it wasn't offered, or
   * leaving what a catch with no conditions was offered, is tampering.
   */
  async #caughtChecked(
    attempt: StepAttempt,
    task: SealedTask | undefined,
    value: unknown
  ): Promise<Settled<unknown>> {
    const offered = this.#offers.get(attempt);
    if (typeof value !== "boolean" || (value && offered === undefined)) {
      return await this.#refused(
        attempt,
        "A catch takes only the error it was offered."
      );
    }
    // A catch with no conditions takes what it is offered: there is
    // nothing for its code to decide (decision 2).
    if (
      !value &&
      offered !== undefined &&
      task?.kind === "try" &&
      unconditional(task.catch)
    ) {
      return await this.#refused(
        attempt,
        "A catch with no conditions takes the error it was offered."
      );
    }
    return {
      ok: true,
      value:
        value && offered !== undefined
          ? { caught: true, error: offered }
          : { caught: false },
    };
  }

  /** `attemptSettled`'s checks of what `attempt`'s step records, `value`. */
  async #recordChecked(
    attempt: StepAttempt,
    value: unknown
  ): Promise<Settled<unknown>> {
    // What the host refuses of any step's record (host.ts, `#doStep`), of
    // one whose call took effect: failed after it, for good.
    if (this.#effected.has(attempt) && !recordable(value)) {
      return { ok: false, error: failedAfterEffect };
    }
    const { task, kind } = this.#stepOf(attempt.step) ?? {};
    if (kind === "catch") {
      return await this.#caughtChecked(attempt, task, value);
    }
    const skipped = skippedSchema.safeParse(value).success;
    if (isDecisionTask(task)) {
      return await this.#decisionRecordChecked(
        attempt,
        task,
        kind === "enter" && skipped ? undefined : kind,
        value
      );
    }
    if (kind === "task" && task?.kind === "raise" && !skipped) {
      return { ok: false, error: raisedBy(task) };
    }
    let unfit: StepError | undefined;
    if (kind === "enter" && task !== undefined && !skipped) {
      if (sleepsUntil(task)) {
        unfit = deadlineUnfit(value);
      } else if (task.kind === "for") {
        unfit = itemsUnfit(value);
      }
    }
    if (unfit !== undefined) {
      return { ok: false, error: unfit };
    }
    const keeps = skipped ? undefined : keepsOf(task, kind);
    return keeps === undefined
      ? { ok: true, value }
      : await this.#stateChecked(attempt, keeps, value);
  }

  /**
   * A state step's record, `value`, of task `task`, which keeps `kept`
   * (`keepsOf`):
   * `{ output, state }`, `state` with exactly the sealed keys, each value
   * held to its template as a call's arguments are (`matched`, no
   * sensitive parameter anywhere) and to its sealed descriptor, by the
   * SDK's validator, no marker of core's in any. Anything else is tampering. More than a
   * workflow's state takes in all fails the step. What it keeps
   * is written once its step is recorded (`stepRecording`).
   */
  async #stateChecked(
    attempt: StepAttempt,
    { task, kept }: Keeps,
    value: unknown
  ): Promise<Settled<unknown>> {
    const record = stateRecordSchema.safeParse(value);
    const sealed = Object.keys(kept);
    const given = record.success ? Object.entries(record.data.state) : [];
    if (
      !record.success ||
      given.length !== sealed.length ||
      given.some(
        ([key, each]) => !Object.hasOwn(kept, key) || isCoreMarker(each)
      )
    ) {
      return await this.#refused(
        attempt,
        `Task "${task.id}"'s ${stateStepOf(task) ?? "task"} step records { output, state }, its state with exactly the keys the build sealed.`,
        "state"
      );
    }
    try {
      for (const [key, each] of given) {
        const shape = kept[key];
        if (shape === undefined) {
          throw tampering(`state.${key} isn't sealed.`);
        }
        matched(shape.template, each, `state.${key}`, undefined, []);
        // Of the shape its key takes, by the SDK's own validator.
        const checked = schemaFromDescriptor(canonicalJson(shape.value))[
          "~standard"
        ].validate(each);
        if ("then" in checked || checked.issues !== undefined) {
          throw tampering(`state.${key} isn't of the shape the build sealed.`);
        }
      }
    } catch (error) {
      return await this.#refused(
        attempt,
        error instanceof Error ? error.message : "The state isn't sealed.",
        "state"
      );
    }
    // Past what its workflow's state takes in all, it fails, a test run's
    // too. A run that writes is counted by its write, with what the state
    // holds as it lands (workflow-state.ts); one that never writes counts
    // what its snapshot holds besides, so a draft's test fails where its
    // runs would.
    const { calling } = this.run;
    const writes = calling.candidate === undefined && calling.fixture !== true;
    const merged = {
      ...(writes ? {} : this.run.state),
      ...Object.fromEntries(given),
    };
    const bytes = Object.entries(merged).reduce(
      (total, [key, each]) =>
        total +
        utf8.encode(key).byteLength +
        utf8.encode(canonicalJson(each)).byteLength,
      0
    );
    if (bytes > workflowStateMaxBytes) {
      return {
        ok: false,
        error: this.#effected.has(attempt)
          ? failedAfterEffect
          : forIsolate(
              workflowResourceErrors.create("workflow.state_too_large")
            ),
      };
    }
    this.#keeps.set(attempt, Object.fromEntries(given));
    return { ok: true, value };
  }

  /**
   * Writes what `attempt`'s state step keeps (`#stateChecked`) in its
   * workflow's state, as the host records the step: only for an attempt
   * whose record the host and this run accepted, its lease held, never a
   * failed, refused, caught or held one. Under the step's idempotency key,
   * the same on every attempt, round and replay, so it lands once
   * (workflow-state.ts). A test run writes nothing, and nor does a
   * restricted one, whose state would flow to the workflow's other runs
   * (restricted.ts): its skip is audited (`workflow.state.withheld`).
   * The write's refusal fails the step: after its call took effect, as
   * `workflow.failed_after_effect`.
   */
  async stepRecording(attempt: StepAttempt): Promise<StepError | undefined> {
    const values = this.#keeps.get(attempt);
    const { calling, runId, workflowId } = this.run;
    if (
      values === undefined ||
      calling.candidate !== undefined ||
      calling.fixture === true
    ) {
      return undefined;
    }
    const { step } = attempt;
    if (calling.restricted) {
      const db = drizzle(this.#env.DB);
      await auditedBatch(this.#env, db, [
        outboxed(db, {
          actor: { type: "system" },
          action: "workflow.state.withheld",
          target: { type: "workflow_run", id: runId },
          detail: {
            workflow: workflowId,
            ...(step.length <= identifierMaxLength ? { step } : {}),
            keys: Object.keys(values).length,
            reason: "restricted",
          },
        }),
      ]);
      return undefined;
    }
    try {
      await writeWorkflowState(
        this.#env,
        runId,
        stepIdempotencyKey(runId, step),
        values
      );
      return undefined;
    } catch (error) {
      if (workflowResourceErrors.codeOf(error) === undefined) {
        throw error;
      }
      return this.#effected.has(attempt)
        ? failedAfterEffect
        : forIsolate(error);
    }
  }

  /**
   * `#recordChecked`'s checks of what a step of kind `kind` of decision
   * task `task` records, `value` (no kind for an enter step its `if`
   * skipped): its enter step's (`#decisionEntered`), and its task step's,
   * exactly the decision the host opened in that attempt.
   */
  async #decisionRecordChecked(
    attempt: StepAttempt,
    task: DecisionTask,
    kind: string | undefined,
    value: unknown
  ): Promise<Settled<unknown>> {
    if (kind === "enter") {
      return await this.#decisionEntered(attempt, task, value);
    }
    if (kind !== "task") {
      return { ok: true, value };
    }
    const opened = this.#openings.get(attempt);
    const recorded = z.json().safeParse(value);
    return opened !== undefined &&
      recorded.success &&
      canonicalJson(recorded.data) === canonicalJson(opened)
      ? { ok: true, value }
      : await this.#refused(
          attempt,
          `Task "${task.id}"'s step records the decision it opened.`,
          "decision"
        );
  }

  /**
   * A decision task's enter step's record, `value`: what its decision
   * asks, `{ recipients, prompt, input }`, each held to the build's
   * template as a call's arguments are (`matched`, no sensitive
   * parameter anywhere); anything else is tampering. Recipients or a
   * prompt no decision takes fail the step as the call's would.
   */
  async #decisionEntered(
    attempt: StepAttempt,
    task: DecisionTask,
    value: unknown
  ): Promise<Settled<unknown>> {
    const record = decisionRecordSchema.safeParse(value);
    if (!record.success) {
      return await this.#refused(
        attempt,
        `Task "${task.id}"'s enter step records { recipients, prompt, input }.`,
        "decision"
      );
    }
    const { call } = task;
    try {
      for (const part of ["recipients", "prompt", "input"] as const) {
        matched(call[part], record.data[part], part, undefined, []);
      }
    } catch (error) {
      return await this.#refused(
        attempt,
        error instanceof Error ? error.message : "The decision isn't sealed.",
        "decision"
      );
    }
    try {
      const { recipients } = record.data;
      recipientsOf(recipients);
      // As deciders already, so its code's `from` (`step.decision`, a
      // person value) can be the first of them exactly. One named twice
      // is asked once (`recipientsOf`), the first still first.
      const named: readonly Json[] = Array.isArray(recipients)
        ? recipients
        : [];
      if (!named.every((each) => decidersSchema.safeParse(each).success)) {
        throw callInvalid("recipients: Name each as person:, team: or role:.");
      }
      promptOf(record.data.prompt);
    } catch (error) {
      return { ok: false, error: forIsolate(error) };
    }
    return { ok: true, value };
  }

  /**
   * Notes how step `step` ended, fresh or replayed: a catch that took the
   * failure pending ends it; a deadline's enter step's deadline is kept
   * for its sleep; a loop's enter step's items open its loop (`#loops`);
   * a failure, past its retries, is pending, as a catch
   * would see it (a catch step's own, or one of no task's, none may take).
   */
  stepEnded(
    step: string,
    outcome: Settled<unknown>,
    takenBy?: string | null
  ): void {
    if (this.#running === step) {
      this.#running = undefined;
    }
    const sealed = this.#stepOf(step);
    const task = sealed?.task;
    if (!outcome.ok) {
      this.#pendingBy = takenBy;
      this.#pendingError = outcome.error;
      // An event wait's failure is the host's refusal of the wait (its
      // binding's authority, its person, a test run's limit), asked again
      // on every replay and never journaled before it: a catch taking it
      // would let a replay after a revocation take a path the run never
      // took, so none does.
      this.#pending =
        task === undefined ||
        sealed?.kind === "catch" ||
        (sealed?.kind === "task" && isEventWait(task))
          ? notCaught()
          : failureOf(outcome.error, task, false);
      return;
    }
    if (sealed?.kind === "catch") {
      if (caughtJournalSchema.parse(outcome.value).caught) {
        this.#pending = undefined;
      }
      return;
    }
    if (sealed?.kind === undefined || task === undefined) {
      return;
    }
    const place = placeOf(task.id, sealed.path);
    if (isDecisionTask(task)) {
      this.#decisionEnded(place, sealed.kind, outcome.value);
      return;
    }
    if (sealed.kind === "enter") {
      this.#entered(task, place, outcome.value);
    }
  }

  /**
   * Keeps what task `task`'s enter step at `place` recorded, `value`: a
   * deadline's, for its sleep; a loop's items, which open its loop.
   */
  #entered(task: SealedTask, place: string, value: unknown): void {
    if (sleepsUntil(task)) {
      const until = deadlineRecordSchema.safeParse(value).data?.until;
      if (until !== undefined) {
        this.#deadlines.set(place, until);
      }
    } else if (task.kind === "for") {
      const items = itemsRecordSchema.safeParse(value).data?.items;
      if (items !== undefined) {
        this.#loops.set(place, { count: items.length, current: -1 });
      }
    }
  }

  /**
   * Keeps what the step of kind `kind` of the decision task at `place`
   * (`placeOf`: each item of a loop has its own) recorded, `value`, as
   * checked when it ran (`#recordChecked`): what its enter step asks, and
   * the decision its task step opened.
   */
  #decisionEnded(
    place: string,
    kind: string | undefined,
    value: unknown
  ): void {
    if (kind === "enter") {
      const record = decisionRecordSchema.safeParse(value);
      if (record.success) {
        this.#asks.set(place, {
          recipients: recipientsOf(record.data.recipients),
          prompt: promptOf(record.data.prompt),
          input: record.data.input,
        });
      }
    } else if (kind === "task") {
      const opened = openedSchema.safeParse(value);
      if (opened.success) {
        this.#opened.set(place, opened.data.decision);
      }
    }
  }

  /**
   * The wait of step `step` (a decision task's `#answer`) as the host
   * runs it: for exactly the decision its task step opened, until that
   * decision's deadline, closing it then, whatever its code asked.
   */
  decisionWait(step: string, wait: DecisionWait): DecisionWait | Error {
    const sealed = this.#stepOf(step);
    const opened =
      sealed?.task === undefined
        ? undefined
        : this.#opened.get(placeOf(sealed.task.id, sealed.path));
    if (opened === undefined || wait.decision !== opened) {
      return tampering(
        `Step "${step}" waits only for the decision its task opened.`
      );
    }
    return { decision: opened, timeout: maxDecisionWaitMs, last: true };
  }

  /**
   * What step `step`'s decision answers, once it ended as `outcome`: an
   * answer taken only as its binding still allows it (`takeDecision`),
   * its value held to the contract's response schema; a refusal fails
   * the step for good. A timeout is the outcome as it is.
   */
  async decisionTaken(
    step: string,
    outcome: DecisionOutcome
  ): Promise<DecisionOutcome> {
    const task = this.#stepOf(step)?.task;
    if (!isDecisionTask(task)) {
      throw new Error(`Step "${step}" is no decision task's`);
    }
    if (!outcome.answered) {
      return outcome;
    }
    try {
      const { approved, by, value } = await takeDecision(
        this.#env,
        this.run.calling,
        task.id,
        task.call.binding,
        outcome
      );
      return { answered: true, approved, by, payload: value };
    } catch (error) {
      // Decided: trying again takes nothing else.
      throw isExpectedError(error)
        ? namedError("NonRetryableError", error.message, error.code)
        : error;
    }
  }

  /**
   * What event wait step `step` (an event wait's own) takes, from its
   * build alone: the first event of the run's inbox of any of its sealed
   * types through its sealed binding (each kept under the engine's type
   * naming both, `eventTypeKey`, so no other binding's event matches),
   * until its sealed timeout. Refused unless the run may still take
   * events through that binding (`#requireEventAuthority`).
   */
  async eventWait(step: string): Promise<EventWaitPlan> {
    const task = this.#stepOf(step)?.task;
    if (!isEventWait(task)) {
      throw new Error(`Step "${step}" is no event wait's`);
    }
    const { binding, filters } = task.listen;
    await this.#requireEventAuthority(binding);
    return {
      match: await Promise.all(
        filters.map(async ({ type }) => ({
          type: await eventTypeKey(binding, type),
        }))
      ),
      timeoutMs: task.timeoutMs,
    };
  }

  /**
   * Refuses a wait for events through `alias` unless the run may still
   * take them: an event binding its start froze, its authority holding
   * now (resource-authority.ts, `requireCallAuthority`), as a call's must
   * (`workflow.event_denied`). A test run's binding is its checkpoint's,
   * and nothing outside it is asked.
   */
  async #requireEventAuthority(alias: string): Promise<void> {
    const { calling } = this.run;
    if (calling.candidate !== undefined) {
      if (calling.candidate.get(alias)?.kind !== "event") {
        throw workflowResourceErrors.create("workflow.event_denied");
      }
      return;
    }
    const binding = calling.bindings.get(alias);
    if (binding?.kind !== "event") {
      throw workflowResourceErrors.create("workflow.event_denied");
    }
    try {
      await requireCallAuthority(this.#env, calling, binding);
    } catch (error) {
      if (workflowResourceErrors.codeOf(error) === "workflow.call_denied") {
        throw workflowResourceErrors.create("workflow.event_denied");
      }
      throw error;
    }
  }

  /**
   * The retry the host may run of step `step` after round `round` failed
   * with `error`: one that may be tried again (`retryable`), of a task in
   * the list of a try whose catch may take it (its filter has it, and it
   * is no further out than the innermost with no conditions) and retries
   * with rounds left. Decided alone, without asking the code, when the
   * first catch to take it has no conditions, nor has its policy.
   */
  retryOffer(
    step: string,
    error: StepError,
    round: number
  ): RetryOffer | undefined {
    const sealed = this.#stepOf(step);
    const task = sealed?.task;
    if (task === undefined || sealed?.kind === "catch") {
      return undefined;
    }
    const failure = failureOf(error, task, false);
    if (!failure.catchable || !retryable(failure, task)) {
      return undefined;
    }
    const tries = triesAround(this.run.build, task);
    const forced = forcedOf(tries, failure.error);
    // The catches that may take it: their filters have it, and none past
    // the innermost with no conditions, which takes it whatever the code.
    const takers = (forced === -1 ? tries : tries.slice(0, forced + 1)).filter(
      (around) => matchesFilter(failure.error, around.catch.errors)
    );
    if (!takers.some((around) => round < (around.catch.retry?.attempts ?? 0))) {
      return undefined;
    }
    const [first] = takers;
    // The first to take it has no conditions, nor has its policy (an
    // offer means it has one, with rounds left): nothing for the code to
    // decide.
    const fixed =
      first !== undefined &&
      unconditional(first.catch) &&
      unconditional(first.catch.retry);
    return {
      error: { ...failure.error },
      decided: (choice, firstFailedAt) =>
        retryDecided(tries, failure.error, round, choice, firstFailedAt),
      ...(fixed
        ? {
            alone: (firstFailedAt: number) =>
              retryDecided(
                tries,
                failure.error,
                round,
                { by: first.id, retry: forcedRetry(first, round) },
                firstFailedAt
              ),
          }
        : {}),
    };
  }

  /** Refuses `attempt` as tampering, `message` its refusal: its failure. */
  async #refused(
    attempt: StepAttempt,
    message: string,
    call = "caught"
  ): Promise<Settled<never>> {
    return await settle(
      async () => await this.#host.refuseIn(attempt, tampering(message), call)
    );
  }

  /**
   * Answers `settled`, a host call's of `attempt`, noted as the host's
   * failure of it when it is one, and the first.
   */
  #noted<Answer extends Settled<unknown> | undefined>(
    attempt: StepAttempt,
    settled: Answer
  ): Answer {
    const answer: Settled<unknown> | undefined = settled;
    if (answer?.ok === false && !this.#hostFailures.has(attempt)) {
      this.#hostFailures.set(attempt, answer.error);
    }
    return settled;
  }

  /** `#call`'s answer, noted as an effect of `attempt` when it answered. */
  #answered(attempt: StepAttempt, settled: Settled<unknown>): Settled<unknown> {
    if (settled.ok) {
      this.#effected.add(attempt);
    }
    return this.#noted(attempt, settled);
  }

  attemptHost(attempt: StepAttempt, admission: AttemptAdmission): AttemptHost {
    // Every call but a binding's is one the build's code never makes.
    const refused = async (label: string): Promise<Settled<never>> =>
      await settle(async () => {
        this.#host.requireUntampered();
        return await this.#host.refuseIn(
          attempt,
          tampering(`A run of a sealed build makes no ${label} call.`),
          label
        );
      });
    const calls: AttemptCalls = {
      callConnection: async (binding, call) =>
        this.#answered(
          attempt,
          await this.#call(attempt, admission, binding, call)
        ),
      callModel: async () => await refused(attemptCallLabels.callModel),
      callCollection: async () =>
        await refused(attemptCallLabels.callCollection),
      callBrain: async () => await refused(attemptCallLabels.callBrain),
      callFunction: async () => await refused(attemptCallLabels.callFunction),
      openDecision: async (request) =>
        this.#noted(attempt, await this.#openDecision(attempt, request)),
      decisionRecipients: async (decision, reminder) =>
        this.#noted(
          attempt,
          await this.#askDecision(attempt, decision, reminder)
        ),
      readAttachment: async () =>
        await refused(attemptCallLabels.readAttachment),
    };
    return new AttemptHost(
      calls,
      async (call) =>
        this.#noted(attempt, await this.#host.leaseRefusal(attempt, call)),
      async (call) =>
        this.#noted(
          attempt,
          await this.#host.hostCallRefusal(attempt, admission, call)
        )
    );
  }

  /**
   * The decision task's step `attempt` is, if it runs now and calls the
   * host for the first time, of kind `kind`; refused as tampering
   * otherwise.
   */
  async #decisionStep(
    attempt: StepAttempt,
    kind: string
  ): Promise<{ task: DecisionTask; place: string }> {
    const refuse = async (message: string): Promise<never> =>
      await this.#host.refuseIn(attempt, tampering(message), "decision");
    const sealed = this.#stepOf(attempt.step);
    const task = sealed?.task;
    if (!isDecisionTask(task) || sealed?.kind !== kind) {
      return await refuse(
        `Step "${attempt.step}" makes no such decision call.`
      );
    }
    if (this.#host.running(attempt) !== attempt) {
      return await refuse(`Step "${attempt.step}" calls only while it runs.`);
    }
    if (this.#called.has(attempt)) {
      return await refuse(`Step "${attempt.step}" makes its call once.`);
    }
    this.#called.add(attempt);
    return { task, place: placeOf(task.id, sealed.path) };
  }

  /**
   * Opens the decision of decision task step `attempt`, as `step.decision`
   * asks (`request`), from what its enter step recorded alone
   * (`openRunDecision`): its recipients the binding covers, never the
   * run's person, its deadline the sealed timeout's. Its code's `from`
   * must be the first recipient recorded; its description and timeout
   * aren't read.
   */
  async #openDecision(
    attempt: StepAttempt,
    request: unknown
  ): Promise<Settled<{ decision: string; deadline: number }>> {
    return await settle(async () => {
      this.#host.requireUntampered();
      await this.#host.requireCurrent(attempt, "decision");
      const { task, place } = await this.#decisionStep(attempt, "task");
      const asks = this.#asks.get(place);
      const opening = openingSchema.safeParse(request);
      if (
        asks === undefined ||
        !opening.success ||
        opening.data.step !== attempt.step ||
        opening.data.from !== asks.recipients[0]
      ) {
        return await this.#host.refuseIn(
          attempt,
          tampering(
            `Task "${task.id}" opens its decision as its enter step recorded it.`
          ),
          "decision"
        );
      }
      const { call } = task;
      // Not yet in v1: its own action telling them, and a reminder.
      if (call.ask !== undefined || call.remindAfterMs !== undefined) {
        throw callInvalid(
          "ask: A sealed run's decision asks by the host's notice alone, once."
        );
      }
      const { calling, createdAt } = this.run;
      // A test's run (a draft's, or one an App's test started) reaches no
      // person: until its decisions are answered from its fixtures here,
      // it opens none.
      if (calling.candidate !== undefined || calling.fixture === true) {
        throw callInvalid(
          "binding: A test run opens no decision on the run host yet."
        );
      }
      // Its input is shown to people other than the run's person.
      await requireResourceRunEvidenceReadable(this.#env, calling);
      this.#requireHolds(attempt);
      const opened = await openRunDecision(
        this.#env,
        { ...calling, createdAt },
        task.id,
        attempt.step,
        {
          binding: call.binding,
          recipients: [...asks.recipients],
          prompt: asks.prompt,
          input: asks.input,
          ...(call.timeoutMs === undefined
            ? {}
            : { timeoutMs: call.timeoutMs }),
        }
      );
      this.#requireHolds(attempt);
      this.#openings.set(attempt, opened);
      return opened;
    });
  }

  /**
   * Asks the people of the decision decision task step `attempt` (its
   * `#ask`) is for, by the host's own notice (`askDeciders`): only the
   * decision its task step opened, never as a reminder, and only while
   * its binding's authority still holds. Its code
   * learns nobody's address: it is answered no recipients.
   */
  async #askDecision(
    attempt: StepAttempt,
    decision: unknown,
    reminder: unknown
  ): Promise<Settled<[]>> {
    return await settle(async () => {
      this.#host.requireUntampered();
      await this.#host.requireCurrent(attempt, "decision");
      const { task, place } = await this.#decisionStep(attempt, "ask");
      const opened = this.#opened.get(place);
      if (opened === undefined || decision !== opened || reminder !== false) {
        return await this.#host.refuseIn(
          attempt,
          tampering(`Task "${task.id}" asks once, for the decision it opened.`),
          "decision"
        );
      }
      // Its people are shown what it asks: never once its binding was
      // revoked, or its run's evidence can't be read, since it opened.
      const { calling } = this.run;
      await requireDecisionAuthority(this.#env, calling, task.call.binding);
      await requireResourceRunEvidenceReadable(this.#env, calling);
      this.#requireHolds(attempt);
      await askDeciders(this.#env, calling, opened);
      // Its people were told: a later failure of the step the host hears
      // of fails it for good, so no retry asks them again.
      this.#effected.add(attempt);
      return [];
    });
  }

  /**
   * Keeps what `attempt` failed with when it sent its call tried once: a
   * later attempt of its step fails with it.
   */
  attemptFailed(attempt: StepAttempt, error: StepError): void {
    const calls = this.#memory.sentCalls;
    if (calls.sent(attempt.key, attempt.number)) {
      calls.keepFailure(attempt.key, attempt.number, error);
    }
  }

  /**
   * Refuses `attempt` of a step whose call is tried once when an earlier
   * attempt of it sent it (`SentCalls`). It fails as the one that sent it
   * did, for good (`StepAttempt.final`): its step isn't tried again,
   * whatever its code, which a retryable one's would otherwise be.
   */
  #requireNoneSent(attempt: StepAttempt): void {
    const marks = this.#memory.sentCalls;
    for (let earlier = 1; earlier < attempt.number; earlier += 1) {
      if (marks.sent(attempt.key, earlier)) {
        const error = triedBefore(
          marks.failureOf(attempt.key, earlier) ?? leftOpen
        );
        attempt.final = error;
        throw error;
      }
    }
  }

  /** Throws unless `attempt` still holds its lease, nothing awaited. */
  #requireHolds(attempt: StepAttempt): void {
    if (!this.#host.holds(attempt)) {
      throw executionErrors.create("execution.stale_attempt");
    }
  }

  /**
   * `attempt`'s call through `binding` (`[operation, arguments]`, as a
   * connection stub sends it): its task's call, checked against the
   * sealed template, audited, then made.
   */
  async #call(
    attempt: StepAttempt,
    admission: AttemptAdmission,
    binding: unknown,
    call: unknown
  ): Promise<Settled<unknown>> {
    return await settle(async () => {
      this.#host.requireUntampered();
      await this.#host.requireCurrent(attempt, "connection");
      const refuse = async (message: string): Promise<never> =>
        await this.#host.refuseIn(attempt, tampering(message), "connection");
      const { task, kind } = this.#stepOf(attempt.step) ?? {};
      const template =
        task?.kind === "call" && kind === "task"
          ? callTemplateOf(task.call)
          : undefined;
      if (task === undefined || template === undefined) {
        return await refuse(`Step "${attempt.step}" makes no call.`);
      }
      if (this.#host.running(attempt) !== attempt) {
        return await refuse(`Step "${attempt.step}" calls only while it runs.`);
      }
      if (this.#called.has(attempt)) {
        return await refuse(`Step "${attempt.step}" makes its call once.`);
      }
      this.#called.add(attempt);
      const sent = sentCallSchema.safeParse(call);
      const args = sent.success ? boundedJson(sent.data[1]) : undefined;
      if (!sent.success || args === undefined) {
        return await refuse(
          "A call sends its operation and JSON arguments within a step's size."
        );
      }
      if (binding !== template.call.binding) {
        return await refuse(
          `Step "${attempt.step}" calls only binding ${template.call.binding}.`
        );
      }
      if (sent.data[0] !== template.operation) {
        return await refuse(
          `Step "${attempt.step}" calls only ${template.operation}.`
        );
      }
      const { params } = this.run;
      const sensitive: Json[] = [];
      let value: Json;
      try {
        value = matched(
          template.arguments,
          args.value,
          "arguments",
          // A sensitive parameter is a connector call's argument only.
          template.call.name === "grasp.connector"
            ? (name) => (Object.hasOwn(params, name) ? params[name] : undefined)
            : undefined,
          sensitive
        );
      } catch (error) {
        return await this.#host.refuseIn(
          attempt,
          error instanceof Error ? error : tampering("The call isn't sealed."),
          "connection"
        );
      }
      // Before its audit: a call refused as tried leaves no evidence of one
      // that went out.
      if (triedOnceCalls.has(template.call.name)) {
        this.#requireNoneSent(attempt);
      }
      await this.#auditCall(attempt, template, args.value);
      return await this.#made(
        attempt,
        admission,
        task,
        template,
        value,
        sensitive
      );
    });
  }

  /**
   * Keeps the evidence of `attempt`'s call before it goes out, or it
   * doesn't go: its sealed call and binding, and a digest of its
   * arguments as the isolate sent them, placeholders and not values.
   */
  async #auditCall(
    attempt: StepAttempt,
    template: CallTemplate,
    sent: Json
  ): Promise<void> {
    const db = drizzle(this.#env.DB);
    const { actor, target, detail } = this.audit;
    await auditedBatch(this.#env, db, [
      outboxed(db, {
        actor,
        action: "workflow.call.checked",
        target,
        detail: {
          ...detail,
          step: attempt.step,
          call: template.call.name,
          binding: template.call.binding,
          operation: template.operation,
          arguments: await sha256Hex(canonicalJson(sent)),
        },
      }),
    ]);
  }

  /**
   * `attempt`'s call of task `task`, its arguments matched (`value`, with
   * the sensitive values put in): made as a resource run's call is.
   */
  async #made(
    attempt: StepAttempt,
    admission: AttemptAdmission,
    task: SealedTask,
    { call }: CallTemplate,
    value: Json,
    sensitive: Json[]
  ): Promise<Json> {
    const marks = this.#memory.sentCalls;
    const once = triedOnceCalls.has(call.name);
    const effect: Effect = {
      key: stepIdempotencyKey(this.run.runId, attempt.step),
      deadline: attempt.deadline,
      requireHolds: () => {
        this.#requireHolds(attempt);
      },
      // Marked as it goes out, every check of its own passed: from then on
      // no later attempt of the step sends it again.
      ...(once
        ? {
            sending: () => {
              marks.markSent(attempt.key, attempt.number);
            },
          }
        : {}),
    };
    try {
      return await this.#sent(
        attempt,
        admission,
        task,
        call,
        value,
        sensitive,
        effect
      );
    } catch (error) {
      // Provably billed nothing: a later attempt may ask again. Any other
      // failure is kept as the attempt's own (`attemptFailed`).
      if (
        once &&
        call.name === "grasp.model" &&
        unbilledAiWaitOf(error) !== undefined
      ) {
        marks.unmarkSent(attempt.key, attempt.number);
      }
      throw error;
    }
  }

  /** `#made`'s work: the call, as a resource run's is made. */
  async #sent(
    attempt: StepAttempt,
    admission: AttemptAdmission,
    task: SealedTask,
    call: BoundCall,
    value: Json,
    sensitive: Json[],
    effect: Effect
  ): Promise<Json> {
    const { calling, build } = this.run;
    switch (call.name) {
      case "grasp.connector": {
        const built: BuiltCall = {
          name: call.name,
          binding: call.binding,
          operation: call.operation,
          arguments: value,
          sensitive,
        };
        try {
          return await makeCall(this.#env, calling, task.id, built, effect);
        } catch (error) {
          // Held for the person: the step waits, and runs again once they
          // decided, connect answering what they decided under its key.
          attempt.held ||= connectErrors.codeOf(error) === "connect.held";
          throw fixedMessage(error);
        }
      }
      case "grasp.operation": {
        return await makeCall(
          this.#env,
          calling,
          task.id,
          { name: call.name, binding: call.binding, arguments: value },
          effect
        );
      }
      case "grasp.model": {
        const parts = modelArgumentsSchema.parse(value);
        this.#reserveModelCall(
          `${effect.key}:${attempt.number}:${attempt.generation}`
        );
        try {
          return await makeCall(
            this.#env,
            calling,
            task.id,
            {
              name: call.name,
              binding: call.binding,
              ...parts,
              outputSchema: call.outputSchema,
            },
            effect
          );
        } catch (error) {
          // Provably billed nothing: the step waits for its provider.
          attempt.aiTrouble = unbilledAiWaitOf(error);
          throw error;
        }
      }
      case "grasp.compute": {
        await this.#packagesAdmitted();
        return await callCompute(
          this.#env,
          build.compute,
          build.sdk,
          call,
          value,
          attempt.deadline
        );
      }
      case "grasp.action": {
        await this.#packagesAdmitted();
        this.#requireHolds(attempt);
        effect.sending?.();
        return await this.#action(
          attempt,
          admission,
          task,
          call,
          value,
          effect.key
        );
      }
      case "grasp.emit": {
        const { data, subject } = emitArgumentsSchema.parse(value);
        if (calling.candidate !== undefined) {
          return null;
        }
        await requireResourceRunEvidenceReadable(this.#env, calling);
        this.#requireHolds(attempt);
        await emitEvent(
          this.#env,
          calling,
          {
            taskId: task.id,
            stepKey: effect.key,
            binding: call.binding,
            type: call.type,
            data,
            ...(subject === undefined ? {} : { subject }),
            ...(call.dataschema === undefined
              ? {}
              : { dataschema: call.dataschema }),
          },
          effect.requireHolds
        );
        return null;
      }
      default: {
        return call satisfies never;
      }
    }
  }

  /**
   * Takes one of the run's model calls for the call keyed `key`, with
   * nothing awaited between the check and the count: `workflow.model_call_limit`
   * once none is left.
   */
  #reserveModelCall(key: string): void {
    const { maxModelCalls } = this.run;
    if (this.#memory.modelCalls.count() >= maxModelCalls) {
      throw workflowResourceErrors.create("workflow.model_call_limit", {
        limit: maxModelCalls,
      });
    }
    this.#memory.modelCalls.keep(key);
  }

  /**
   * Admits the approved graph the build seals, if it seals one, before
   * its modules load: `workflow.packages_revoked` once it is revoked.
   */
  async #packagesAdmitted(): Promise<void> {
    const { build, workflowId } = this.run;
    if (build.packages !== undefined) {
      await requirePackagesAdmitted(
        this.#env,
        workflowId,
        build.packages.graphHash
      );
    }
  }

  /**
   * An action task's call: the action run in the modules' sandbox
   * (resource-action.ts), each of its calls admitted as one of the run's
   * own (its packages, a host call, a model call's place), then made
   * under its step's key and its ordinal.
   */
  async #action(
    attempt: StepAttempt,
    admission: AttemptAdmission,
    task: SealedTask,
    call: Extract<SealedCall, { name: "grasp.action" }>,
    input: Json,
    stepKey: string
  ): Promise<Json> {
    const { calling, build, workflowId } = this.run;
    const refused = {
      build: build.hash,
      task: task.id,
      attempt: attempt.number,
      generation: attempt.generation,
    };
    return await callAction(
      this.#env,
      build.compute,
      build.sdk,
      call,
      input,
      attempt.deadline,
      {
        owner: `workflow-action:${workflowId}`,
        parent: this.#memory.sessionId?.(),
        make: async (built, ordinal) => {
          this.#requireHolds(attempt);
          await this.#packagesAdmitted();
          this.#requireHolds(attempt);
          await admission.hostCall();
          this.#requireHolds(attempt);
          if (built.name === "grasp.model") {
            try {
              this.#reserveModelCall(
                `${stepKey}:${attempt.number}:${attempt.generation}:${ordinal}`
              );
            } catch (error) {
              await auditAdmissionRefusal(this.#env, calling, {
                ...refused,
                call: built.binding,
                errorCode:
                  workflowResourceErrors.codeOf(error) ?? "internal.unexpected",
                reason: "model_call_limit",
              });
              throw error;
            }
          }
          return await makeCall(this.#env, calling, task.id, built, {
            key: `${stepKey}:${ordinal}`,
            deadline: attempt.deadline,
            requireHolds: () => {
              this.#requireHolds(attempt);
            },
            fromAction: true,
          });
        },
        refused: async (refusal) => {
          await auditAdmissionRefusal(this.#env, calling, {
            ...refused,
            ...refusal,
          });
        },
      }
    );
  }
}

/** The kind of run a sealed build's is, for the host (`RunHost`) to serve. */
export const sealedRun =
  (env: Env, run: HostedSealedRun, memory: SealedRunMemory) =>
  (host: HostControls): SealedRunKind =>
    new SealedRun(env, run, memory, host);

/** A sealed run's kind, and what its run's end checks of it. */
export interface SealedRunKind extends RunKind {
  /** The failure no catch took, if one is pending (`SealedRun`). */
  readonly failureUntaken: StepError | undefined;
}

/**
 * Run `run`, as its activation loaded it (resource-runs.ts: an independent
 * workflow's run, or a test run of its draft's checkpoint), as the run
 * host serves a sealed build's: its lineage, its authority and its share
 * from what its calls go by, which its row and its root's pin.
 */
export const sealedRunFrom = (
  run: Pick<
    HostedResourceRun,
    | "runId"
    | "workflowId"
    | "version"
    | "build"
    | "params"
    | "input"
    | "state"
    | "createdAt"
    | "calling"
    | "maxModelCalls"
    | "maxSleepMs"
  >
): HostedSealedRun => {
  const { runId, calling } = run;
  return {
    runId: runIdSchema.parse(runId),
    ...(calling.rootRunId === runId
      ? {}
      : { rootRunId: runIdSchema.parse(calling.rootRunId) }),
    ...(calling.accountRunId === calling.rootRunId
      ? {}
      : { accountRunId: runIdSchema.parse(calling.accountRunId) }),
    authority: runAuthority(calling),
    shareSubject: calling.principal,
    workflowId: run.workflowId,
    version: run.version,
    build: run.build,
    params: run.params,
    input: run.input,
    state: run.state,
    createdAt: run.createdAt,
    calling,
    maxModelCalls: run.maxModelCalls,
    ...(run.maxSleepMs === undefined ? {} : { maxSleepMs: run.maxSleepMs }),
  };
};

/**
 * The modules a sealed run's isolate loads: its verified build's SDK and
 * generated module (`sealedRunFrom`), and the main module that runs it
 * (code.ts, `runMain`). Only a build generated for the run host
 * (`generatedForRunHost`): any other's module would be run on an engine
 * it wasn't written for.
 */
export const sealedRunModules = ({
  runId,
  build,
}: HostedSealedRun): Record<string, string> => {
  if (!generatedForRunHost(build)) {
    throw new Error(
      `Run ${runId}'s build was generated for another SDK than the run host's`
    );
  }
  return {
    ...build.sdk,
    ...build.modules,
    ...runModules({
      module: generatedModule,
      refusal: "The sealed build doesn't export its workflow.",
    }),
  };
};

/**
 * What a sealed run's main module starts with: its input, only the
 * parameters the build lists as not sensitive, its state's snapshot, and its frozen catalog
 * bindings by alias, each a binding whose `call` goes to the host.
 */
export const sealedRunStart = (run: HostedSealedRun) => ({
  runId: run.runId,
  params: Object.fromEntries(
    run.build.params.flatMap((name) =>
      Object.hasOwn(run.params, name) ? [[name, run.params[name] ?? null]] : []
    )
  ),
  input: run.input,
  state: run.state,
  connections: [...run.calling.bindings.keys()],
  collections: [],
  brains: [],
});
