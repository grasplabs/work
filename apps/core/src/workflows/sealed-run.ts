import { schemaFromDescriptor } from "@grasp-os/runtime/host";
import { connectErrors } from "@grasp-os/shared/connect";
import { decidersSchema } from "@grasp-os/shared/decisions";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { expectedMessageOf, isExpectedError } from "@grasp-os/shared/errors";
import { functionErrors } from "@grasp-os/shared/functions";
import { identifierMaxLength } from "@grasp-os/shared/identifier";
import { runIdSchema } from "@grasp-os/shared/ids";
import { canonicalJson, isRecord } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { sealedBuildLimits } from "@grasp-os/shared/sealed-builds";
import { valueDepth } from "@grasp-os/shared/value-depth";
import {
  workflowResourceErrors,
  workflowStateMaxBytes,
} from "@grasp-os/shared/workflow-resources";
import {
  executionErrors,
  expressionErrors,
  expressionFailed,
  paramsStep,
  placeholderOf,
  stepIdempotencyKey,
  uncatchableFailureName,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import { namedError } from "@grasp-os/workerflow/errors";
import { keepsState } from "@grasp-os/workflow-schema/sealed";
import type {
  SealedCall,
  SealedTask,
  Template,
} from "@grasp-os/workflow-schema/sealed";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed } from "../audit-outbox.ts";
import { memberRole } from "../auth/identity.ts";
import type { DecisionOutcome } from "../decisions/decisions.ts";
import { generatedModule } from "../workflow-builds.ts";
import type { LoadedBuild } from "../workflow-builds.ts";
import { writeWorkflowState } from "../workflow-state.ts";
import { AttemptHost } from "./attempt-host.ts";
import type { AttemptCalls } from "./attempt-host.ts";
import { writeJson } from "./bounded-json.ts";
import { eventTypeKey, matchAttribute } from "./event-envelopes.ts";
import { isMatchKey, matchHashOf } from "./event-matches.ts";
import type { MatchKey } from "./event-matches.ts";
import { fixtureCall, fixtureCalls } from "./fixture-calls.ts";
import {
  fixtureDecisionDeadline,
  fixtureDecisionLookMs,
  fixtureDecisionOutcome,
  openFixtureDecision,
  takeFixtureDecision,
} from "./fixture-decisions.ts";
import type { FixtureDecisionRun } from "./fixture-decisions.ts";
import { forIsolate, isCoreMarker, settle, unbilledAiWaitOf } from "./host.ts";
import type {
  DecisionsKept,
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
import { requireCallAuthority, runAuthority } from "./resource-authority.ts";
import type { CallingRun } from "./resource-authority.ts";
import { makeCall } from "./resource-calls.ts";
import type { BuiltCall, Effect } from "./resource-calls.ts";
import {
  askDeciders,
  callInvalid,
  candidateDecision,
  checkCandidateDecision,
  decisionRunOf,
  openRunDecision,
  promptOf,
  recipientsOf,
  requireDecisionAsk,
  takeDecision,
} from "./resource-decisions.ts";
import type { DecisionAnswer } from "./resource-decisions.ts";
import {
  failureOf,
  matchesFilter,
  notCaught,
  retryable,
} from "./resource-errors.ts";
import type { CaughtError, Failure } from "./resource-errors.ts";
import { inboxOf } from "./run-inboxes.ts";
import { sealedMainModules } from "./sealed-isolate.ts";
import type { Settled, StepError } from "./sealed-isolate.ts";
import { engineStepOf } from "./sealed-steps.ts";

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
//   tampered build never runs (`workflow.version_corrupt`).
// - A step the build doesn't have. The build's code is a handler whose
//   every `ctx` call journals itself (@grasp-os/runtime's workflow-journal.ts)
//   under its step's name: `<task>:<step>` (`enter` or `task`), from a
//   task's second run on, which only a task inside a loop's items has,
//   `<task>:<step>@<n>`, its count of earlier runs, a decision task's parts
//   as `#ask`, `#asked` and `#answer` after its task step,
//   `workflow:output` where the workflow returns a result, and the SDK's
//   `$params`. Each must be one of the sealed table's (`stepTableOf`,
//   `stepNameOf`), run as it runs (a task's step as a `do`, a sleeping
//   task's own as its sleep, an event wait's own as its wait), never
//   beside another step, never again. An `if`, a loop, a `try` and a raise
//   have no steps: their flow is the code's, decided in the isolate from
//   journaled values and the run's frozen data, as a replay decides it
//   again alike (the format's expressions are pure: no clock, no
//   randomness, no globals), every call still held to its template. A
//   listen that isn't an event wait, and a task whose scope names
//   anything but `for` tasks, have no steps in the table. The table holds
//   only what the generator writes (@grasp-os/workflow-schema's
//   sealed.ts): one that holds anything else doesn't load
//   (workflow-builds.ts).
// - A task run out of its order, or more often than its place allows. A
//   task in no loop runs once: its names carry no count. A task inside a
//   loop's items runs again only after its run before, each run once, its
//   next run started only by its first step, every other step of it in
//   the run running now (`#runRefusal`): so its runs go in increasing
//   order, none repeated, and a run's steps stay bounded by its tasks and
//   the run's own step ceiling (`workflow.too_many_steps`), which is what
//   ends a long loop. Which items a loop goes over, and when it stops, is
//   flow, as an `if` is. Each run of a task has names, effects' keys,
//   deadlines and retries of its own.
// - A call outside its task's step, or more than one. A call goes through
//   the host of the attempt whose code makes it (attempt-host.ts), only
//   while that attempt holds its lease and is the step running now, and
//   only from the step of a call task that makes its call (`<task>:task`).
//   Code outside any step has no attempt to call through (sealed-isolate.ts,
//   `workflow.outside_step`), and an attempt's host kept past its step is
//   refused as stale. Each attempt makes one call: a second is refused.
// - A call the build didn't seal. The binding, the operation, and every
//   literal of the sealed template must be the call's exactly; an object
//   must have exactly the template's keys, and an array exactly its
//   length (`matched`). An expression's hole (`slot`) takes any JSON
//   within a step's size and a value's depth: the host fills in no
//   slot, so a placeholder there is data. Every refusal fails the run.
//   Arguments a correct build sends, its slots filled, may still nest
//   past what a call takes (`requireArgumentsDepth`): the run's data put them
//   there, which no save can check, so that is the step's own failure
//   (`workflow.arguments_too_deep`), which a catch may take, not
//   tampering.
// - An App's function the build didn't seal (GRA-1663). The isolate names
//   an App call by its App permission's alias and the function's stable
//   ID, held to the task's sealed `grasp.app` call like any operation;
//   the App's ID is the sealed call's alone, so code can't point a
//   granted function's ID at another App, nor call a function its
//   document doesn't list. What the call may do is then the workflow's
//   own grant on exactly that function, decided as it is made
//   (workflows/app-calls.ts): revoked, the App removed or the function
//   gone, the call fails, whichever version of the workflow runs. A
//   sensitive parameter is never an App call's argument.
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
//   it is made (`requireCallAuthority`, in `makeCall`): a
//   revoked approval, permission or role stops the next call
//   (`workflow.call_denied`). The person the run acts for must still be an
//   active member before every step; a run an App's test started acts for
//   its fixture's principal, whose role nothing changes.
// - An effect repeated. A model's and an action's
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
//   lineage, a test run's as its own, a run an App's test started against
//   its test's own admission, which counts nothing of the organization's.
// - A test's run reaching the organization. A test run of a draft's
//   checkpoint calls nothing: every call is answered from its start's
//   fixtures (resource-calls.ts, `makeCall`, `calling.candidate`). A run
//   an App's test started makes only the calls its test serves
//   (fixture-calls.ts, `fixtureCalls`), refused otherwise before its
//   arguments are matched or audited (`permission.unavailable`); its model
//   calls are answered by its fixture (`fixtureCall`), tried once as a
//   real call is; and `makeCall` refuses every call of it again.
// - A catch taking what it mustn't (spec 13.7). The host keeps its own
//   record of the failure the code hasn't gone on past (`#pending`),
//   mapped by resource-errors.ts from what it knows. A failure the host
//   made keeps its mapping: an attempt one of whose calls the host failed
//   or refused fails with that, whatever its code reports, throws
//   instead, or swallows, a function that rejects rather than reports
//   included. One only the isolate reports is an expression's, a task's
//   data's, or the task's own runtime failure, as the platform's
//   unexpected one (`isolateFailure`): never one no catch may take, so
//   never a host's relabelled. Each is decided on as the engine journaled
//   it, so a replay decides alike (host.ts, `#doStep`). The code's catches
//   are its own JavaScript: what its code is answered with is the
//   failure's code and the platform's words for it, never what its
//   message held (`failureForCode`). The code goes on past a failure (its
//   next step, or ending well) only where a `try` around the failed
//   task's step may take it: one the host lets a catch take, of the code
//   that `try`'s catch names, if it names one (`#takenPending`);
//   anything else is refused, and fails the run with the failure.
//   Whether that catch's `when` holds, and which of the steps it lists
//   run, is flow, as an `if` is. A run whose code fails past a failure no
//   catch may take fails with that failure (`runFailure`).
// - A retry past its limits. The host runs a step's rounds (host.ts,
//   `#retried`), only after a failure that may be tried again
//   (`retryable`) of a task in the list of the one `try` around it whose
//   catch retries (the format's check allows one), whose code the failure
//   has, and where no catch further in takes it first whatever the code
//   says (`retryingTry`). The isolate only says whether that retry's
//   `when` holds and no catch further in takes the failure by its own
//   `when` (a boolean: the innermost catch that takes a failure has it
//   before any retry further out, and only the isolate can evaluate a
//   `when`); the host computes the backoff and the limits itself,
//   recorded (`retryDecided`). Declining a retry only fails the step
//   sooner, to the catch that takes it.
// - A raise forged. A raise is the workflow's own `AppError`, thrown by
//   its code: the run fails with it only when its code is one a raise of
//   the build seals, with that raise's sealed message (`raisedFailure`);
//   an `AppError` of any other code fails the run as the platform's
//   unexpected failure, and no code of the platform's namespaces is ever
//   a raise's (the format's check, and `AppError` itself).
// - Waking early, or a replay waiting otherwise. A literal wait sleeps
//   exactly its sealed length; a deadline's wait until exactly the
//   deadline its task's enter step recorded, at most a year ahead. The
//   isolate computes that deadline as it does any expression, and leaving
//   a wait out is flow, as an `if` is.
// - A decision asked of someone the binding doesn't allow, answered by
//   anyone else, or taken otherwise than it was answered. A decision task
//   (`grasp.decision`) runs as the SDK's `ask` (`ctx.decisions.<alias>.ask`) does: its enter
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
//     it opened (one per run and step). A test's run reaches nobody: a
//     draft's opens none, its outcome the answer its start gave the
//     binding (`candidateDecision`); one an App's test started opens its
//     decision with its test, asking its fixture's principals alone,
//     never among the organization's (fixture-decisions.ts,
//     `openFixtureDecision`). Neither is asked by any notice.
//   - Its task step must record exactly the decision the host opened in
//     it. Its asking step asks only that one, by the host's own notice
//     (`askDeciders`: the isolate learns nobody's address), its authority
//     decided again first, never reminding; once it asked, a failure of
//     the step the host hears of fails it for good, so a retry doesn't
//     ask again (one cut off unheard, its activation lost, may ask once
//     more: a second notice, never a second decision).
//   - Its wait is for that decision only, until its deadline
//     (`decisionWait`). The outcome is read from the decision's row (a
//     test run's from where it keeps them, `decisionsKeptOf`: looked at
//     again every `fixtureDecisionLookMs`, as a test's answer owes no
//     wake), never from the event that wakes the run nor from the
//     isolate, and taken only as the binding still allows it (a test
//     run's as its fixture does: `candidateDecision`,
//     `takeFixtureDecision`; any other's `takeDecision`:
//     authority decided again, whoever answered still covered and never
//     the run's person, what they answered held to the contract's
//     response schema), in the step that records it, so a replay takes it
//     alike. A decision nobody answered before its deadline closes as
//     timed out, and the decision service refuses an answer after that.
// - An event wait with a match taking an event of another match: its
//   enter step records the value it matches (held to the sealed template,
//   text, a number or a boolean), and the wait takes only an event core
//   handed the run for exactly that value (event-waits.ts), which carries
//   the match's hash as an engine attribute.
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
//   task keeps only its sealed `state`'s keys, by its task step alone, and
//   only a call that doesn't wait (`keepsState`), whose record must be its record with `state` beside, of exactly those keys, each
//   value held to its template as a call's (`matched`: literals exact, an
//   expression's value any JSON, never a sensitive parameter) and to the
//   descriptor of the value its key takes, by the SDK's own validator
//   (which generated code runs first, failing its step as data: a value
//   past it here got past the SDK), no marker of core's in it
//   (`#stateChecked`); anything else is tampering: the host holds them to
//   the build, never to the isolate. It is written only as the host
//   records the step (host.ts, `RunKind.stepRecording`): after the host's
//   last check of the attempt, its lease held, so never by an attempt
//   that failed, was refused, caught or held, nor by a failed retry
//   round. It writes under the step's idempotency key, the same on every
//   attempt, round and replay, so it lands once: a crash between the
//   write and the journal writes nothing twice, and a replay of a
//   journaled step writes nothing at all. What lands stands, as the first
//   write: should the engine lose that attempt's result after it (its
//   timeout, or storing it failing), a later attempt's values aren't
//   written, and if every later attempt fails, the step fails with its
//   state kept. More than a workflow's state takes in all fails the step,
//   a test run's too. A refused write (too large, a run that ended) fails
//   the step, after its call's effect as `workflow.failed_after_effect`.
//   A test run, a draft's or one an App's test started, writes nothing,
//   and nor does a restricted run, whose state would carry what it read
//   to the workflow's other runs (restricted.ts): its skip is audited
//   (`workflow.state.withheld`). What a value holds is the build's to
//   decide: its builder seals each key's expression, as they seal what a
//   run writes to an App's data, so state is the company's record of what
//   the workflow's runs computed, which every later run of it reads,
//   whoever it acts for. A task in a loop's items writes once an item,
//   each under its own step's key, one item after another.
// - State changing under a run. A run reads its workflow's state once,
//   as its start is decided (a write or reset landing between that and
//   its admission is the next start's to read), frozen as a snapshot its
//   start's receipt names (a draft's test run's row; state-snapshots.ts),
//   and every activation hands the isolate that same snapshot
//   (`sealedRunStart`), whatever other runs write since. A run an App's
//   test started reads none: nothing of the organization's. The snapshot
//   is whatever the workflow's runs kept, of every version: generated
//   code holds each value it reads to its own build's descriptor, as it
//   does any data. A reset, or the workflow's deletion, leaves the
//   snapshots of runs that already started until retention (a receipt's
//   details) or the sweep of test runs releases them.
// - An attempt longer than sealed. Each is held to its task's timeout,
//   and its engine retries are the host's own (`limitsOf`), whatever its
//   code declares.
// - The run's own files reached past what the build seals (`grasp.files`,
//   `ctx.files.<alias>.<action>`). The permission and the action are
//   the sealed call's: the isolate names neither, and a call through any
//   other binding or of any other action is refused as tampering. Only
//   its arguments are the isolate's (a file's ID, a name, a type, text),
//   which an expression may compute from anything the run read, so the
//   host trusts none of them: every file is looked up by its ID *and* the
//   run's own (run-files.ts), so an ID of another run's file, made up or
//   carried in an event's data, answers `file.not_found`, as a file that
//   isn't there does; a name is a run file's name for its type or is
//   refused; a file is read whole only when it is text of a run file's
//   text types, at most one call's bytes; a write is text of those types
//   only, checked against its type as a connector's kept read is, under the
//   run's and the workflow's limits; a delete takes only a finished file.
//   Every files permission of a run reaches all of the run's files, never
//   another run's: the run scopes them, not the alias. Each call is one of the run's named
//   calls (`makeCall`): its authority decided again, a write gated by
//   what the run may still read (`handsOut`: a file's name and bytes are
//   shown outside the run once it's finished), its receipts kept with the
//   file's ID, type, size and SHA-256, never its name or content. A write
//   writes under the step's key, so an attempt, a round or a replay that
//   writes again answers the file the first wrote, never a second one.
// - The Brain reached past what the build seals (`grasp.brain`,
//   `ctx.brain.<alias>.<action>`). The permission's one collection and
//   the action (search, read, recall) are sealed; what the run reads is
//   what Knowledge's access rules let the run read as a delegate, under
//   the permission, for its person: a document outside the collection, or
//   one the person may not read, is refused as one that isn't there, and
//   restricted data never reaches an unrestricted run (resource-reads.ts).
//   What it read is pinned to the run (run-evidence.ts), so nothing it
//   read leaves the run once the person may no longer read it.
// - A connection call keeping a file, or attaching run files, where it
//   mustn't. Where a read's file goes (`into`) and where a write's
//   attachments come from (`from`) are the sealed call's, each a files
//   permission of the build's: the call's code names them, and a call
//   that names others, or names one the build doesn't, is refused as
//   tampering. Then, as for an action's (resource-calls.ts): `into` only
//   on an action whose contract answers a file (`answersFile`), `from`
//   only on one that takes files (`takesFiles`), each files permission's
//   authority decided again before the call and again as connect sends
//   it; an attachment is a finished file of this run, named by its ID,
//   whose name, type, size and digest are core's own records and whose
//   bytes are read back against that digest; a kept file is typed by its
//   bytes, never by the label it came with.

/** The run an activation loaded (resource-runs.ts, `loadedRun`). */
export interface HostedResourceRun {
  runId: string;
  workflowId: string;
  version: number;
  /** Whom it acts for: the person whose start admitted it. */
  principal: string;
  /** Its input, as its start admitted it. */
  input: Json;
  /** The parameter values its start froze. */
  params: Record<string, Json>;
  /** What its workflow kept between runs, as its start froze it. */
  state: Readonly<Record<string, Json>>;
  /** When it was admitted, in ms. */
  createdAt: number;
  /**
   * For a run a trigger started in another run's lineage: its root and
   * its depth under it, as its row pins them. Unset, the run is its own
   * root, at 0.
   */
  rootRunId?: string;
  depth?: number;
  /**
   * When its lineage's root was admitted, in ms, as the root's row says:
   * no wait of the run's outlasts the lineage's age from then. Unset, the
   * run is its own root: `createdAt`.
   */
  lineageStartedAt?: number;
  /** Its sealed build, verified. */
  build: LoadedBuild;
  /** What its calls go by: its principal, invoker and frozen bindings. */
  calling: CallingRun;
  /** The most model calls it may make: the host's ceiling (resource-runs.ts). */
  maxModelCalls: number;
  /**
   * For a test run (candidate-runs.ts): the longest any one of its waits
   * may last, and the furthest past its start a sleep until a time may end,
   * in ms. One past it fails the run (`workflow.candidate_wait_limit`), so
   * no test run sits waiting for long.
   */
  maxSleepMs?: number;
}

/**
 * The model calls a run made (GRA-700), kept with the run (run-object.ts,
 * `modelCallsIn`): a failed attempt records none, so its calls can't be
 * counted from records on a replay. Each is kept, by its call's key,
 * before it goes out.
 */
export interface RunModelCalls {
  /** How many were kept. */
  count: () => number;
  /** Keeps one, with its call's key: each time it is kept, as made. */
  keep: (key: string) => void;
}

/**
 * The most a call's arguments may take as JSON: two of what a step records
 * (each is one, or the run's input, which a receipt bounds lower), and
 * their framing.
 */
const maxPassedBytes = 2 * platformLimits.stepPayloadBytes + 64;

/**
 * `value` as plain JSON, with its size in UTF-16 code units, if it is
 * plain JSON within `maxPassedBytes` and `maxDepth` (a call's depth by
 * default): written once by the bounded writer, so nothing larger is
 * walked, then read back from that text. `undefined` otherwise.
 */
const boundedJson = (
  value: unknown,
  maxDepth: number = sealedBuildLimits.callDepth
): { value: Json; size: number } | undefined => {
  const written = writeJson(value, {
    maxBytes: maxPassedBytes,
    maxDepth,
    maxNodes: maxPassedBytes,
  });
  if (!written.ok) {
    return undefined;
  }
  const parsed = z.json().safeParse(JSON.parse(written.text));
  return parsed.success
    ? { value: parsed.data, size: written.text.length }
    : undefined;
};

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
   * with the start: the same in every activation.
   */
  readonly state: Readonly<Record<string, Json>>;
  /** What its calls go by: its principal, invoker and frozen bindings. */
  readonly calling: CallingRun;
  /** The most model calls it may make: the host's ceiling. */
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
  /** The model calls it made. */
  modelCalls: RunModelCalls;
}

/** A `grasp.decision` call task. */
type DecisionTask = Extract<SealedTask, { kind: "call" }> & {
  call: Extract<SealedCall, { name: "grasp.decision" }>;
};

const isDecisionTask = (task: SealedTask | undefined): task is DecisionTask =>
  task?.kind === "call" && task.call.name === "grasp.decision";

/**
 * The parts the SDK's `ask` runs of a decision task's step besides its
 * opening: asking its people, noting when, and waiting for the answer.
 */
const decisionParts = ["ask", "asked", "answer"] as const;

/** A step of the sealed table: its task (none for the workflow's own). */
interface SealedStep {
  readonly task?: SealedTask;
  readonly kind: string;
}

/** A `for` task. */
type ForTask = Extract<SealedTask, { kind: "for" }>;

/** Whether `task` is a loop: its items run one after another. */
const isLoop = (task: SealedTask | undefined): task is ForTask =>
  task?.kind === "for";

/** The furthest ahead a deadline may be, as the engine sleeps: a year. */
const maxDeadlineMs = sealedBuildLimits.deadlineMs;

/** A `listen` task. */
type ListenTask = Extract<SealedTask, { kind: "listen" }>;

/**
 * Whether `task` is an event wait the run host runs: one that takes the
 * first event of any of its sealed types, through its sealed binding,
 * until its timeout of at most a year.
 */
const isEventWait = (task: SealedTask | undefined): task is ListenTask =>
  task?.kind === "listen" && task.timeoutMs <= maxDeadlineMs;

/**
 * The steps `build` seals, by `<task>:<kind>`, the run counts of their
 * engine names left out (`stepNameOf`): the workflow's output, and every
 * task's, outside loops or inside them. A listen that isn't an event wait,
 * and a task whose scope names anything but loops, have no steps here, so
 * they never run.
 */
const stepTableOf = (build: LoadedBuild): ReadonlyMap<string, SealedStep> => {
  const table = new Map<string, SealedStep>();
  if (build.workflow.output) {
    table.set("workflow:output", { kind: "output" });
  }
  const tasks = new Map(build.tasks.map((task) => [task.id, task]));
  for (const task of build.tasks) {
    const runs =
      (task.kind !== "listen" || isEventWait(task)) &&
      task.scope.every((id) => isLoop(tasks.get(id)));
    if (runs) {
      for (const kind of task.steps) {
        table.set(`${task.id}:${kind}`, { task, kind });
      }
      // The SDK's `ask`'s parts of a decision task's own step (the SDK's
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
 * An engine step name, read: its task, its part, its run's count (from
 * its second run on, `@<count>`), and the SDK's part of a decision's
 * step (`#ask`), if any (sealed-steps.ts, `engineStepOf`).
 */
interface StepName {
  readonly id: string;
  readonly kind: string;
  readonly count: number;
  readonly part?: string;
}

/** Engine step `step` read; nothing for one that isn't in exactly that form. */
const stepNameOf = (step: string): StepName | undefined => {
  const named = engineStepOf(step);
  if (named === undefined) {
    return undefined;
  }
  return {
    id: named.task,
    kind: named.kind,
    count: named.count,
    ...(named.part === "" ? {} : { part: named.part.slice(1) }),
  };
};

/** A step of the sealed table, as run in the run of its task `path` names. */
interface ResolvedStep extends SealedStep {
  /**
   * Which run of its task it is, for a task inside a loop's items (`[n]`,
   * from 0); none for any other, which runs once.
   */
  readonly path: readonly number[];
}

/**
 * Where task `id` runs in run `path` of it: `id`, then `@<n>` inside a
 * loop's items. One place per run of a task.
 */
const placeOf = (id: string, path: readonly number[]): string =>
  path.length === 0 ? id : `${id}@${path.join("/")}`;

/** What an event wait's enter step records, with a match: the value it matches. */
const matchRecordSchema = z.strictObject({ key: z.json() });

/** Whether `task` is an event wait with a match, whose enter step records it. */
const matchesBy = (
  task: SealedTask | undefined
): task is Extract<SealedTask, { kind: "listen" }> =>
  task?.kind === "listen" && task.listen.match !== undefined;

/** The sealed calls a task's step makes through a binding. */
type BoundCall = Extract<
  SealedCall,
  {
    name:
      | "grasp.connector"
      | "grasp.app"
      | "grasp.model"
      | "grasp.files"
      | "grasp.brain";
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
  readonly arguments: Template;
}

/** The call template of `call`; none for a call the isolate never makes. */
const callTemplateOf = (call: SealedCall): CallTemplate | undefined => {
  switch (call.name) {
    case "grasp.connector":
    case "grasp.files":
    case "grasp.brain": {
      return { call, operation: call.operation, arguments: call.arguments };
    }
    // An App's function: the isolate names it by its stable ID alone; its
    // App's ID is the sealed call's, never the isolate's to say.
    case "grasp.app": {
      return { call, operation: call.function, arguments: call.arguments };
    }
    case "grasp.model": {
      return {
        call,
        operation: call.name,
        arguments: {
          object: [
            ["instructions", call.instructions],
            ["input", call.input],
          ],
        },
      };
    }
    // Made by the host.
    case "grasp.sleepUntil":
    case "grasp.decision": {
      return undefined;
    }
    default: {
      return call satisfies never;
    }
  }
};

/** The calls whose step makes them once only (spec 13.7): a model request. */
const triedOnceCalls: ReadonlySet<SealedCall["name"]> = new Set([
  "grasp.model",
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
 * code kept, a timeout's code `function.deadline_exceeded`.
 */
const triedBefore = (failure: StepError): Error =>
  namedError(
    "NonRetryableError",
    failure.message,
    failure.code ??
      (failure.name === "TimeoutError"
        ? "function.deadline_exceeded"
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
 * Whether `task` sleeps until a deadline its enter step records: a
 * `grasp.sleepUntil` call.
 */
const sleepsUntil = (task: SealedTask): boolean =>
  task.kind === "call" && task.call.name === "grasp.sleepUntil";

/** The longest a retry's backoff may sleep, as the engine sleeps: a year. */
const maxRetryDelayMs = sealedBuildLimits.deadlineMs;

/** What a deadline's enter step records. */
const deadlineRecordSchema = z.object({ until: z.int().min(0) });

/** What a decision task's enter step records. */
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

/** How the SDK opens a decision (the SDK's `ask`). */
const openingSchema = z.strictObject({
  step: z.string(),
  from: z.string(),
  // The host's own: it asks the prompt its enter step recorded (which the
  // SDK passes trimmed), until the sealed timeout's deadline.
  description: z.unknown(),
  timeout: z.unknown(),
});

/** As long as a decision's wait may be: its deadline comes first. */
const maxDecisionWaitMs = sealedBuildLimits.deadlineMs;

/** What a decision asks, as its task's enter step recorded it. */
interface DecisionAsks {
  /** Its recipients as deciders (`recipientsOf`). */
  readonly recipients: readonly string[];
  readonly prompt: string;
  readonly input: Json;
}

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

/**
 * What a run whose code failed with `error` fails with, by what `build`
 * seals as its raises: an `AppError` of a code one of its raises throws,
 * with that raise's sealed message (never the isolate's words); nothing
 * for any other code, which the run's own mapping takes
 * (`SealedRun.runFailure`). So a workflow raises only what its build
 * seals, and passes nothing off as the platform's: a raise's code is
 * never in a platform namespace (the format's check, and `AppError`).
 */
const raisedFailure = (
  build: LoadedBuild,
  error: StepError
): StepError | undefined => {
  const raise = build.tasks.find(
    (task): task is Extract<SealedTask, { kind: "raise" }> =>
      task.kind === "raise" && task.error.code === error.code
  );
  return raise === undefined
    ? undefined
    : {
        name: "AppError",
        message: raise.error.message,
        code: raise.error.code,
      };
};

/**
 * The codes the workflow SDK fails a run's code with outside any step,
 * each in fixed words: never the isolate's, which could quote what the
 * run read.
 */
const sdkFailures: ReadonlyMap<string, string> = new Map([
  [expressionFailed, expectedMessageOf(expressionFailed) ?? taskFailed],
  [
    "workflow.collection_invalid",
    expectedMessageOf("workflow.collection_invalid") ?? taskFailed,
  ],
  [
    "workflow.invalid_input",
    "The run's arguments don't fit its workflow's args.",
  ],
  ["workflow.invalid_param", "A parameter's value doesn't fit its type."],
  [
    "workflow.invalid_step_call",
    "The workflow's code called the SDK otherwise than it takes.",
  ],
  [
    "workflow.invalid_definition",
    "The workflow's code defines it otherwise than the SDK takes.",
  ],
]);

/** The run's failure of SDK code `code`, in its fixed words. */
const sdkFailure = (code: string): StepError => ({
  name: "Error",
  message: sdkFailures.get(code) ?? taskFailed,
  code,
});

/**
 * Whether a catch or its retry policy decides with no condition of its
 * own (`when`): the isolate has nothing to decide for it.
 */
const unconditional = (conditions: { when?: number } | undefined): boolean =>
  conditions !== undefined && conditions.when === undefined;

/** The backoff before round `round + 1` of `policy`. */
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
  return policy.delayMs * factor;
};

/** Round `round + 1` of `policy` after its backoff: none past a year. */
const scheduled = (
  policy: NonNullable<Extract<SealedTask, { kind: "try" }>["catch"]["retry"]>,
  round: number
): RetryDecision => {
  const delayMs = backoffOf(policy, round);
  return delayMs > maxRetryDelayMs
    ? { retry: false, delayMs: 0 }
    : { retry: true, delayMs };
};

/**
 * The retry of a failure, `error`, of a task in the lists of `tries`
 * (innermost first), after round `round`: the one try around it whose
 * catch retries (the format's check allows one), when its code filter
 * has the error and no catch further in takes it first whatever the
 * code says (one whose filter has it, with no `when`); undefined when
 * none retries it. A catch further in with a `when` is the isolate's to
 * decide: its retry choice is false when one takes the failure
 * (workflow-schema's generate.ts, `takesOf`).
 */
export const retryingTry = (
  tries: readonly Extract<SealedTask, { kind: "try" }>[],
  error: CaughtError
): Extract<SealedTask, { kind: "try" }> | undefined => {
  const at = tries.findIndex((around) => around.catch.retry !== undefined);
  const around = tries[at];
  if (around === undefined || !matchesFilter(error, around.catch.code)) {
    return undefined;
  }
  const takenFirst = tries
    .slice(0, at)
    .some(
      (inner) =>
        matchesFilter(error, inner.catch.code) && unconditional(inner.catch)
    );
  return takenFirst ? undefined : around;
};

/**
 * What the isolate's retry `choice` of round `round` decides for
 * `around`, the try whose catch retries the failure (`retryingTry`):
 * whether its retry's `when` holds, a boolean (`undefined` when its code
 * failed to choose: no retry). Anything else is tampering. It retries
 * while the policy has rounds left, after its backoff, and none past a
 * year. The isolate may decline a retry its policy has no `when` for:
 * the step then fails sooner, as it would past its rounds.
 */
export const retryDecided = (
  around: Extract<SealedTask, { kind: "try" }>,
  round: number,
  choice: unknown
): RetryDecision => {
  const stop = { retry: false, delayMs: 0 };
  if (choice === undefined) {
    return stop;
  }
  if (typeof choice !== "boolean") {
    throw tampering("A retry's choice is whether its retry holds.");
  }
  const policy = around.catch.retry;
  return choice && policy !== undefined && round < policy.attempts
    ? scheduled(policy, round)
    : stop;
};

/**
 * What a deadline's enter step whose record is `value` fails with, if its
 * deadline isn't one: a time in ms since the epoch, at most a year ahead.
 */
const deadlineUnfit = (value: unknown, now: number): StepError | undefined => {
  const until = deadlineRecordSchema.safeParse(value).data?.until;
  return until !== undefined && until - now <= maxDeadlineMs
    ? undefined
    : forIsolate(
        workflowResourceErrors.create("workflow.call_invalid", {
          issues: ["until: Give a time in milliseconds at most a year ahead."],
        })
      );
};

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
 * nothing but for the task step of a task that keeps state (`keepsState`)
 * whose sealed `state` names a key.
 */
const keepsOf = (
  task: SealedTask | undefined,
  kind: string | undefined
): Keeps | undefined =>
  task?.state === undefined ||
  Object.keys(task.state).length === 0 ||
  kind !== "task" ||
  !keepsState(task)
    ? undefined
    : { task, kept: task.state };

const utf8 = new TextEncoder();

/**
 * What a state step records: its record as it would be otherwise (its
 * `output`, and whatever else its step records), with what it keeps by
 * key as `state` beside.
 */
const stateRecordSchema = z.looseObject({
  output: z.json(),
  state: z.record(z.string(), z.json()),
});

/** Whether `value` is a list. */
const isList = (value: Json): value is readonly Json[] => Array.isArray(value);

/**
 * How deep a sealed literal nests: none for a scalar, one past its
 * deepest item for a list or an object. A literal is the build's, within
 * a definition's data depth, so the recursion is bounded.
 */
const nestingOf = (value: Json): number => {
  if (typeof value !== "object" || value === null) {
    return 0;
  }
  let deepest = 0;
  for (const item of isList(value) ? value : Object.values(value)) {
    if (item !== undefined) {
      deepest = Math.max(deepest, nestingOf(item));
    }
  }
  return 1 + deepest;
};

/**
 * Throws `workflow.arguments_too_deep` for sealed arguments `sent` nested
 * past a call's depth (`boundedJson`'s, `sealedBuildLimits.callDepth`;
 * within its size already, so depth is all it can refuse): matched, so only
 * their slots, the run's data, can nest them so deep.
 */
const requireArgumentsDepth = (sent: Json): void => {
  if (boundedJson(sent) === undefined) {
    throw workflowResourceErrors.create("workflow.arguments_too_deep");
  }
};

/**
 * The deepest arguments a correct build sends by `template`: each literal
 * as deep as it is, each slot an evaluation's result, at most a
 * value's depth (`valueDepth`), and each sensitive parameter its placeholder. Deeper
 * is tampering, refused before anything walks it.
 */
const deepestSent = (template: Template): number => {
  if ("literal" in template) {
    return nestingOf(template.literal);
  }
  if ("slot" in template) {
    return valueDepth;
  }
  if ("param" in template) {
    return 1;
  }
  const items =
    "array" in template
      ? template.array
      : template.object.map(([, item]) => item);
  return 1 + Math.max(0, ...items.map(deepestSent));
};

/**
 * Whether an object's entry of `template` may be missing from what the
 * isolate sent: only a slot's, whose expression gave `undefined`, which
 * JSON leaves out of an object (the SDK's `jsonValue`, as
 * `JSON.stringify` does), as an optional field of a value's schema may
 * be left out. A literal, a sensitive parameter, an object or a list is
 * always there: the code writes each as it is sealed.
 */
const mayBeLeftOut = (template: Template): boolean => "slot" in template;

/**
 * `sent`, the arguments the isolate sent, matched against `template` at
 * `path`: each literal exactly, an object's keys exactly (but a slot's,
 * which may be left out: `mayBeLeftOut`), an array's
 * length exactly, a slot any JSON within a value's depth (the host
 * fills in no slot, so what looks like a placeholder there is data), and
 * a sensitive parameter's place only that parameter's placeholder, its value put in
 * by `fill` (none where no sensitive parameter may be) and kept in
 * `sensitive`. Throws `tampering` for anything else.
 */
const matched = (
  template: Template,
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
    // An evaluation's result, never deeper than a value may nest.
    if (boundedJson(sent, valueDepth) === undefined) {
      throw tampering(`${path} nests deeper than an expression's result may.`);
    }
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
    Object.keys(sent).some((key) => !keys.has(key)) ||
    template.object.some(
      ([key, item]) => !(Object.hasOwn(sent, key) || mayBeLeftOut(item))
    )
  ) {
    throw tampering(`${path} hasn't exactly the keys the build sealed.`);
  }
  // Own data properties, in the template's order: no key, `__proto__`
  // included, is anything else.
  const object: Record<string, Json> = {};
  for (const [key, item] of template.object) {
    if (!Object.hasOwn(sent, key)) {
      continue;
    }
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
});

/** How a connection binding's stub sends a call: `[operation, arguments, options]`. */
const sentCallSchema = z.union([
  z.tuple([z.string(), z.unknown()]),
  z.tuple([z.string(), z.unknown(), z.undefined()]),
  // A connection call's files permissions (`into`, `from`), which must be
  // its sealed call's.
  z.tuple([
    z.string(),
    z.unknown(),
    z.strictObject({
      into: z.string().max(64).optional(),
      from: z.string().max(64).optional(),
    }),
  ]),
]);

/**
 * Why a call of step `step` names otherwise than its sealed `template`, or
 * nothing: its binding, its operation, and the files permissions it sent
 * (`files`, its third part), which must be exactly the sealed call's:
 * none on any call but a connector's, and on a connector's its `into` and
 * `from`, each there or not alike.
 */
const namedOtherwise = (
  step: string,
  { call, operation }: CallTemplate,
  binding: unknown,
  sent: string,
  files: { into?: string; from?: string } | undefined
): string | undefined => {
  if (binding !== call.binding) {
    return `Step "${step}" calls only binding ${call.binding}.`;
  }
  if (sent !== operation) {
    return `Step "${step}" calls only ${operation}.`;
  }
  const sealed =
    call.name === "grasp.connector"
      ? { into: call.into, from: call.from }
      : { into: undefined, from: undefined };
  return files?.into === sealed.into && files?.from === sealed.from
    ? undefined
    : `Step "${step}" keeps and attaches files only where its build says.`;
};

/** `run`, as a test's run's decisions and calls take it (fixture-decisions.ts). */
const fixtureRunOf = ({
  runId,
  workflowId,
  version,
  calling,
  createdAt,
}: HostedSealedRun): FixtureDecisionRun => ({
  runId,
  workflowId,
  version,
  principal: calling.principal,
  createdAt,
});

/** The prefix of the decision a draft's test run opens nowhere. */
const candidateDecisionPrefix = "candidate:";

/** The decision a draft's test run "opens" through binding `alias`. */
const candidateDecisionOf = (alias: string): string =>
  `${candidateDecisionPrefix}${alias}`;

/** Its deadline: the run's longest wait past its start. */
const candidateDeadlineOf = ({
  createdAt,
  maxSleepMs,
}: HostedSealedRun): number => createdAt + (maxSleepMs ?? 0);

/**
 * Where `run`'s decisions are kept, for a test's run (`RunKind.decisionsKept`):
 * a draft's, answered at once from its start's fixtures, opened nowhere;
 * one an App's test started, with its test, answered by its fixture's
 * principals. None for any other run: decisions.ts keeps them.
 */
const decisionsKeptOf = (
  env: Env,
  run: HostedSealedRun
): DecisionsKept | undefined => {
  const { calling, runId } = run;
  const { candidate } = calling;
  if (candidate !== undefined) {
    return {
      outcome: async (decision) => {
        const alias = decision.startsWith(candidateDecisionPrefix)
          ? decision.slice(candidateDecisionPrefix.length)
          : "";
        const { approved, by, value } = await candidateDecision(
          env,
          candidate,
          alias
        );
        return { answered: true, approved, by, payload: value };
      },
      deadline: async () => await Promise.resolve(candidateDeadlineOf(run)),
      // Never waited on: its first look finds it answered.
      lookMs: fixtureDecisionLookMs,
    };
  }
  if (calling.fixture === true) {
    return {
      outcome: async (decision, close) =>
        await fixtureDecisionOutcome(env, runId, decision, close),
      deadline: async (decision) =>
        await fixtureDecisionDeadline(env, runId, decision),
      lookMs: fixtureDecisionLookMs,
    };
  }
  return undefined;
};

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
  /**
   * The failure the code hasn't gone on past yet, fresh or replayed, as
   * this activation reaches the steps (`stepEnded`): the code goes on
   * past it only where a catch around its task may take it
   * (`#takenPending`).
   */
  #pending: Failure | undefined;
  /** The pending failure as the engine journaled it (`failureUntaken`). */
  #pendingError: StepError | undefined;
  /** The task whose step failed with the pending failure. */
  #pendingTask: SealedTask | undefined;
  /**
   * Each sleeping task's deadline, as its enter step recorded it, by the
   * place it runs in (`placeOf`): each item of a loop has its own.
   */
  readonly #deadlines = new Map<string, number>();
  /** What each decision task asks, as its enter step recorded it. */
  readonly #asks = new Map<string, DecisionAsks>();
  /**
   * The value each event wait with a match matches, as its enter step
   * recorded it, by the place it runs in.
   */
  readonly #matchKeys = new Map<string, MatchKey>();
  /** The decision each decision task's step opened, as it recorded it. */
  readonly #opened = new Map<string, string>();
  /** The decision each attempt of a decision task's step opened. */
  readonly #openings = new WeakMap<
    StepAttempt,
    { decision: string; deadline: number }
  >();
  /**
   * The run of each task inside a loop's items running now, by its ID
   * (`#runRefusal`): its steps carry it (`@<n>`), and only its first
   * step starts the next, so its runs go in order, each once.
   */
  readonly #runs = new Map<string, number>();
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
  readonly decisionsKept: DecisionsKept | undefined;
  readonly aiWaitRun: RunKind["aiWaitRun"];
  readonly stepsAudited: boolean;

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
    this.decisionsKept = decisionsKeptOf(env, run);
    this.aiWaitRun = { runId: run.runId };
    this.stepsAudited = run.calling.fixture !== true;
  }

  /**
   * The person the run acts for must still be an active member: a test's
   * run acts for its fixture's principal, whose role nothing changes.
   */
  async requirePerson(): Promise<void> {
    const { calling } = this.run;
    if (calling.fixture === true) {
      return;
    }
    if ((await memberRole(this.#env.DB, calling.principal)) === undefined) {
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
    return this.#pending === undefined || this.#takenPending()
      ? undefined
      : this.#pendingError;
  }

  /**
   * What the run fails with when its code fails with `error`, which only
   * the isolate reports, so nothing of it is trusted but what the host
   * can hold to the build: the failure pending that no catch may take, as
   * the engine journaled it (its code threw it on, or failed past it); an
   * `AppError` of a code its build seals as a raise, as sealed
   * (`raisedFailure`); one of the few codes the SDK itself fails a run's
   * code with outside a step (`sdkFailures`), in the platform's words; and
   * anything else as the platform's unexpected failure (`isolateFailure`):
   * a code of the platform's namespaces, a malformed one, a message it
   * chose. A failure of the build's code with no code (a timeout it
   * claims too) is `expression.failed`: outside a step, the generated
   * code only evaluates its expressions and hands their values to the
   * SDK. What the host itself failed the run with (a CPU kill) never comes
   * here (resource-runs.ts).
   */
  runFailure(error: StepError): StepError {
    const pending = this.#pendingError;
    if (
      pending !== undefined &&
      this.#pending !== undefined &&
      (!this.#takenPending() || error.code === pending.code)
    ) {
      return pending;
    }
    const raised = raisedFailure(this.run.build, error);
    if (raised !== undefined) {
      return raised;
    }
    if (error.code === undefined) {
      return sdkFailure(expressionFailed);
    }
    return error.code !== undefined && sdkFailures.has(error.code)
      ? sdkFailure(error.code)
      : isolateFailure({ name: "Error", message: taskFailed });
  }

  /**
   * The task whose step's failure the run ends with, when `failure` is that
   * very failure (`failureUntaken`, `runFailure`): the one pending, which
   * the code threw on or failed past. None for any other: a failure
   * outside every step (an `if`'s condition, a raise), or one a catch took
   * before another step ran. A catch's own failure of the pending code,
   * before any step past it, is taken for the step's rethrown
   * (`runFailure`): the isolate can't tell the two apart.
   */
  endingTask(failure: StepError): string | undefined {
    return failure === this.#pendingError ? this.#pendingTask?.id : undefined;
  }

  /**
   * Whether a catch around the task whose step failed may take the
   * failure pending: one the host lets a catch take (`failureOf`), of a
   * task in the list of a `try` whose code filter it has. Which of them
   * takes it, and whether its `when` holds, is the code's, as an `if`
   * is: what runs after is held to the build all the same.
   */
  #takenPending(): boolean {
    const pending = this.#pending;
    const task = this.#pendingTask;
    if (pending?.catchable !== true || task === undefined) {
      return false;
    }
    return triesAround(this.run.build, task).some((around) =>
      matchesFilter(pending.error, around.catch.code)
    );
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
   * and an event wait's own as its wait; a run of its task out of their
   * order (`#runRefusal`). While a failure is pending, any step where no
   * catch around its task may take it (`#takenPending`): the code goes
   * on past a failure only where its build catches it. While another
   * step runs, any step; a step that started already, again. A step it
   * lets start runs until it ends (`stepEnded`).
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
    if (this.#pending !== undefined) {
      if (!this.#takenPending()) {
        return tampering(
          "A run goes on past a failure only where a catch around its step takes it."
        );
      }
      this.#pending = undefined;
      this.#pendingError = undefined;
      this.#pendingTask = undefined;
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
      const refusal = this.#runRefusal(sealed);
      if (refusal !== undefined) {
        return tampering(refusal);
      }
    }
    this.#started.add(step);
    this.#running = step;
    return undefined;
  }

  /**
   * Engine step `step` as the sealed table has it, in the run of its task
   * its name says: a count (`@<n>`) only of a task inside a loop's items.
   * Nothing for any other name.
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
    const inLoop = (sealed.task?.scope.length ?? 0) > 0;
    if (!inLoop && name.count > 0) {
      return undefined;
    }
    return { ...sealed, path: inLoop ? [name.count] : [] };
  }

  /**
   * Why `step` may not run in the run of its task its name says, or
   * nothing: a task inside a loop's items runs again only after its run
   * before, each run once, the next started only by its task's first
   * step (`SealedTask.steps`), every other step of it in the run running
   * now. So its runs go in increasing order, none repeated, and a run's
   * steps stay bounded by its tasks and the run's own step ceiling.
   */
  #runRefusal({ task, kind, path }: ResolvedStep): string | undefined {
    const [count] = path;
    if (task === undefined || count === undefined) {
      return undefined;
    }
    const current = this.#runs.get(task.id) ?? -1;
    const [first] = task.steps;
    if (count === current + 1 && kind === first) {
      this.#runs.set(task.id, count);
      return undefined;
    }
    // Another step of the run running now: a step started already is
    // refused as such (`#started`).
    return count === current
      ? undefined
      : `Run ${count} of task "${task.id}" doesn't run now: its runs go in increasing order, each once.`;
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
      return kind !== "answer" && !sleeps && !listens;
    }
    if (use === "listen") {
      return listens;
    }
    if (use === "waitForDecision") {
      return kind === "answer";
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
   * task's timeout.
   */
  limitsOf(step: string): StepLimits {
    const task = this.#stepOf(step)?.task;
    // A listen's timeout is how long it waits for its events, never how
    // long an attempt of its steps may take.
    if (task?.timeoutMs === undefined || task.kind === "listen") {
      return { retries: sealedRetries };
    }
    return { retries: sealedRetries, timeout: task.timeoutMs };
  }

  /**
   * What `attempt` settled with, as the host takes it: the failure the
   * host made of its calls, if any; a failure only its code reports, as
   * `isolateFailure` maps it; a deadline's enter step only with a
   * deadline at most a year ahead.
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
   * `workflow.failed_after_effect`, which no catch takes, as a catch
   * would take it as a call that didn't; otherwise as `isolateFailure`
   * maps it.
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
    return cut ? error : isolateFailure(error);
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
    if (isDecisionTask(task)) {
      return await this.#decisionRecordChecked(attempt, task, kind, value);
    }
    if (kind === "enter" && task !== undefined) {
      const entered = await this.#enterChecked(attempt, task, value);
      if (entered !== undefined) {
        return entered;
      }
    }
    const keeps = keepsOf(task, kind);
    return keeps === undefined
      ? { ok: true, value }
      : await this.#stateChecked(attempt, keeps, value);
  }

  /**
   * What an enter step of `task` records, `value`, settles as, when its
   * task holds it to anything: a deadline's (`deadlineUnfit`), an event
   * wait's match (`#matchKeyChecked`).
   */
  async #enterChecked(
    attempt: StepAttempt,
    task: SealedTask,
    value: unknown
  ): Promise<Settled<unknown> | undefined> {
    if (matchesBy(task)) {
      return await this.#matchKeyChecked(attempt, task, value);
    }
    const unfit = sleepsUntil(task)
      ? deadlineUnfit(value, this.#host.now())
      : undefined;
    return unfit === undefined ? undefined : { ok: false, error: unfit };
  }

  /**
   * An event wait's enter step's record with a match, `value`: `{ key }`,
   * the key held to the build's template as a call's arguments are
   * (`matched`, no sensitive parameter: core keeps its hash), anything
   * else tampering; one that isn't text, a number or a boolean
   * (`isMatchKey`) fails the step, as an expression giving the wrong kind
   * of value does.
   */
  async #matchKeyChecked(
    attempt: StepAttempt,
    task: ListenTask,
    value: unknown
  ): Promise<Settled<unknown>> {
    const record = matchRecordSchema.safeParse(value);
    const sealed = task.listen.match;
    try {
      if (!record.success || sealed === undefined) {
        throw tampering(`Task "${task.id}"'s enter step records { key }.`);
      }
      matched(sealed.equals, record.data.key, "match.equals", undefined, []);
    } catch (error) {
      return await this.#refused(
        attempt,
        error instanceof Error ? error.message : "The match isn't sealed."
      );
    }
    return isMatchKey(record.data.key)
      ? { ok: true, value }
      : {
          ok: false,
          error: forIsolate(
            workflowResourceErrors.create("workflow.call_invalid", {
              issues: [
                "match.equals: Give text, a number or a boolean, of at most 512 characters.",
              ],
            })
          ),
        };
  }

  /**
   * A state step's record, `value`, of task `task`, which keeps `kept`
   * (`keepsOf`): its record with `state` beside (`stateRecordSchema`),
   * `state` with exactly the sealed keys (but one whose value is a slot
   * that gave `undefined`, left out and not written), each value held to its template
   * as a call's arguments are (`matched`, no sensitive parameter
   * anywhere) and to its sealed descriptor, by the SDK's validator, no
   * marker of core's in any. Anything else is tampering. More than a
   * workflow's state takes in all fails the step. What it keeps is
   * written once its step is recorded (`stepRecording`).
   */
  async #stateChecked(
    attempt: StepAttempt,
    { task, kept }: Keeps,
    value: unknown
  ): Promise<Settled<unknown>> {
    const record = stateRecordSchema.safeParse(value);
    const given = record.success ? Object.entries(record.data.state) : [];
    const state = record.success ? record.data.state : {};
    if (
      !record.success ||
      // Every sealed key, but one whose value is a slot that gave
      // `undefined` (`mayBeLeftOut`): nothing written to it.
      Object.entries(kept).some(
        ([key, shape]) =>
          !(Object.hasOwn(state, key) || mayBeLeftOut(shape.template))
      ) ||
      given.some(
        ([key, each]) => !Object.hasOwn(kept, key) || isCoreMarker(each)
      )
    ) {
      return await this.#refused(
        attempt,
        `Task "${task.id}"'s step records its output with its state beside, of exactly the keys the build sealed.`,
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
    // what its snapshot holds besides, so a draft's test fails a step
    // whose state passes the cap with its snapshot (not with what its own
    // earlier steps kept, which it never wrote).
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
   * task `task` records, `value`: its enter step's (`#decisionEntered`), and its task step's,
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
      // As deciders already, so its code's `from` (the SDK's `ask`, a
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
   * Notes how step `step` ended, fresh or replayed: a deadline's enter
   * step's deadline is kept for its sleep, an event wait's match for its
   * wait, a decision's asks and opening for its parts; a failure, past
   * its retries, is pending, as a catch would see it (one of no task's,
   * or an event wait's, none may take), until the code goes on past it
   * (`stepRefusal`) or ends (`failureUntaken`, `runFailure`).
   */
  stepEnded(step: string, outcome: Settled<unknown>): void {
    if (this.#running === step) {
      this.#running = undefined;
    }
    const sealed = this.#stepOf(step);
    const task = sealed?.task;
    if (!outcome.ok) {
      this.#pendingError = outcome.error;
      this.#pendingTask = task;
      this.#pending = this.#failureOfStep(step, outcome.error);
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
   * What step `step`'s failure `error` is to a catch (`failureOf`), the
   * one reading of it both the host's record and what its code hears
   * take. An event wait's failure is the host's refusal of the wait (its
   * binding's authority, its person, a test run's limit), asked again on
   * every replay and never journaled before it: a catch taking it would
   * let a replay after a revocation take a path the run never took, so
   * none does.
   */
  #failureOfStep(step: string, error: StepError): Failure {
    const sealed = this.#stepOf(step);
    const task = sealed?.task;
    return task === undefined || (sealed?.kind === "task" && isEventWait(task))
      ? notCaught()
      : failureOf(error, task, false);
  }

  /**
   * The failure step `step` answers its code with: what a catch reads of
   * it (`failureOf`: its code and the platform's words, never what the
   * step's own message held), so nothing a failure's message quoted
   * reaches a catch, which would hand it on; one no catch may take as the
   * host failed it, since the run ends with it whatever its code does.
   */
  failureForCode(step: string, error: StepError): StepError {
    const failure = this.#failureOfStep(step, error);
    // One no catch may take ends the run, whatever the code does: its
    // words are the host's own (a refusal's, a timeout's), as the run ends
    // with them, and its name tells the SDK to throw it on from any catch
    // (`uncatchableFailureName`), so honest code never goes on past it.
    return failure.catchable
      ? {
          name: error.name,
          message: failure.error.message,
          code: failure.error.code,
        }
      : { ...error, name: uncatchableFailureName };
  }

  /**
   * Keeps what task `task`'s enter step at `place` recorded, `value`: a
   * deadline's, for its sleep; an event wait's match, for its wait.
   */
  #entered(task: SealedTask, place: string, value: unknown): void {
    if (sleepsUntil(task)) {
      const until = deadlineRecordSchema.safeParse(value).data?.until;
      if (until !== undefined) {
        this.#deadlines.set(place, until);
      }
    } else if (task.kind === "listen" && task.listen.match !== undefined) {
      const key = matchRecordSchema.safeParse(value).data?.key;
      if (isMatchKey(key)) {
        this.#matchKeys.set(place, key);
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
      const { approved, by, value } = await this.#taken(task, outcome);
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
    const sealed = this.#stepOf(step);
    const task = sealed?.task;
    if (sealed === undefined || !isEventWait(task)) {
      throw new Error(`Step "${step}" is no event wait's`);
    }
    const { binding, filters, match } = task.listen;
    await this.#requireEventAuthority(binding);
    if (match === undefined) {
      return {
        match: await Promise.all(
          filters.map(async ({ type }) => ({
            type: await eventTypeKey(binding, type),
          }))
        ),
        timeoutMs: task.timeoutMs,
      };
    }
    // With a match, only an event core handed the run for exactly the
    // value its enter step recorded, which carries that match
    // (event-waits.ts): no other event of its binding and types.
    const key = this.#matchKeys.get(placeOf(task.id, sealed.path));
    if (key === undefined) {
      throw new Error(`Step "${step}" matches nothing its enter step recorded`);
    }
    const matchHash = await matchHashOf(match.field, key);
    const { calling } = this.run;
    const real = calling.candidate === undefined && calling.fixture !== true;
    const types = filters.map(({ type }) => type);
    return {
      match: await Promise.all(
        types.map(async (type) => ({
          type: await eventTypeKey(binding, type),
          attributes: { [matchAttribute]: matchHash },
        }))
      ),
      timeoutMs: task.timeoutMs,
      // A test run's events are its fixtures': nothing outside reaches it.
      ...(real
        ? {
            enter: async (until: number) => {
              // Loaded as it is reached: it admits to the run's inbox,
              // whose engine runs this host.
              const { enterMatchWait } = await import("./event-waits.ts");
              await enterMatchWait(
                this.#env,
                { run: calling, step, binding, types, matchHash },
                until
              );
            },
            left: async () => {
              const { leaveMatchWait } = await import("./event-waits.ts");
              await leaveMatchWait(this.#env, calling.runId, step);
            },
          }
        : {}),
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
   * The answer of decision task `task`, once its decision was answered as
   * `outcome`: a draft's test run's from its start's fixtures, one an
   * App's test started as its fixture allows, any other's as its binding
   * still allows (`takeDecision`).
   */
  async #taken(
    task: DecisionTask,
    outcome: DecisionOutcome
  ): Promise<DecisionAnswer> {
    const { calling } = this.run;
    const { binding } = task.call;
    if (calling.candidate !== undefined) {
      return await candidateDecision(this.#env, calling.candidate, binding);
    }
    if (calling.fixture === true) {
      return await takeFixtureDecision(
        this.#env,
        fixtureRunOf(this.run),
        binding,
        outcome
      );
    }
    return await takeDecision(this.#env, calling, task.id, binding, outcome);
  }

  /**
   * The retry the host may run of step `step` after round `round` failed
   * with `error`: one that may be tried again (`retryable`), of a task in
   * the list of the try whose catch retries it (`retryingTry`), with
   * rounds left. Its code says whether its retry's `when` holds (`retry:
   * true` where it has none); the host holds that to the policy.
   */
  retryOffer(
    step: string,
    error: StepError,
    round: number
  ): RetryOffer | undefined {
    const sealed = this.#stepOf(step);
    const task = sealed?.task;
    // Only a call's own step, which the SDK runs with the call's `retry`:
    // a decision's, a wait's and a deadline's steps are retried by the
    // engine alone.
    if (
      task === undefined ||
      sealed?.kind !== "task" ||
      task.kind !== "call" ||
      callTemplateOf(task.call) === undefined
    ) {
      return undefined;
    }
    const failure = failureOf(error, task, false);
    if (!failure.catchable || !retryable(failure, task)) {
      return undefined;
    }
    const around = retryingTry(
      triesAround(this.run.build, task),
      failure.error
    );
    if (around === undefined || round >= (around.catch.retry?.attempts ?? 0)) {
      return undefined;
    }
    return {
      error: { ...failure.error },
      decided: (choice) => retryDecided(around, round, choice),
    };
  }

  /** Refuses `attempt` as tampering, `message` its refusal: its failure. */
  async #refused(
    attempt: StepAttempt,
    message: string,
    call = "record"
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
    const calls: AttemptCalls = {
      callConnection: async (binding, call) =>
        this.#answered(
          attempt,
          await this.#call(attempt, admission, binding, call)
        ),
      openDecision: async (request) =>
        this.#noted(attempt, await this.#openDecision(attempt, request)),
      askDecision: async (decision) =>
        this.#noted(attempt, await this.#askDecision(attempt, decision)),
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
   * Opens the decision of decision task step `attempt`, as the SDK's `ask`
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
      const { calling, createdAt } = this.run;
      const built = {
        binding: call.binding,
        recipients: [...asks.recipients],
        prompt: asks.prompt,
        input: asks.input,
        ...(call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs }),
      };
      // A test run of a draft's checkpoint reaches no person: its decision
      // is the answer its start gave the binding (`candidateDecision`,
      // checked here), opened nowhere (`decisionsKeptOf`).
      if (calling.candidate !== undefined) {
        // Asked as a real run's is (its input the contract's, never of the
        // run's own person), so a draft passes only what a run would.
        await checkCandidateDecision(
          this.#env,
          calling.candidate,
          built,
          calling.principal
        );
        await candidateDecision(this.#env, calling.candidate, call.binding);
        const opened = {
          decision: candidateDecisionOf(call.binding),
          deadline: candidateDeadlineOf(this.run),
        };
        this.#openings.set(attempt, opened);
        return opened;
      }
      // A run an App's test started asks its fixture's principals alone,
      // its decision kept with its test, never the organization's
      // (fixture-decisions.ts).
      if (calling.fixture === true) {
        this.#requireHolds(attempt);
        const opened = await openFixtureDecision(
          this.#env,
          fixtureRunOf(this.run),
          task.id,
          // Kept by its step's name with its key decoded (`review:task@0`),
          // as its test finds a loop item's decision by the indices after
          // `@` (`respond`'s `at`). The table admitted the name, and only
          // its one canonical encoding (`stepNameOf`), so decoding keeps
          // one decision per step.
          decodeURIComponent(attempt.step),
          built,
          this.#host.now()
        );
        this.#requireHolds(attempt);
        this.#openings.set(attempt, opened);
        return opened;
      }
      this.#requireHolds(attempt);
      const opened = await openRunDecision(
        this.#env,
        { ...calling, createdAt },
        task.id,
        attempt.step,
        built
      );
      this.#requireHolds(attempt);
      this.#openings.set(attempt, opened);
      return opened;
    });
  }

  /**
   * Asks the people of the decision decision task step `attempt` (its
   * `#ask`) is for, by the host's own notice (`askDeciders`): only the
   * decision its task step opened, and only while its binding's authority
   * still holds. Its code learns nobody's address: it is answered
   * nothing.
   */
  async #askDecision(
    attempt: StepAttempt,
    decision: unknown
  ): Promise<Settled<null>> {
    return await settle(async () => {
      this.#host.requireUntampered();
      await this.#host.requireCurrent(attempt, "decision");
      const { task, place } = await this.#decisionStep(attempt, "ask");
      const opened = this.#opened.get(place);
      if (opened === undefined || decision !== opened) {
        return await this.#host.refuseIn(
          attempt,
          tampering(`Task "${task.id}" asks once, for the decision it opened.`),
          "decision"
        );
      }
      const { calling } = this.run;
      // A test's run tells nobody: its fixture's principals answer through
      // its test, and a draft's run asked nobody.
      if (calling.candidate !== undefined || calling.fixture === true) {
        return null;
      }
      // Its people are shown what it asks: never once its binding was
      // revoked, or its run's evidence can't be read, since it opened.
      await requireDecisionAsk(this.#env, calling, task.id, task.call.binding);
      this.#requireHolds(attempt);
      await askDeciders(this.#env, calling, opened);
      // Its people were told: a later failure of the step the host hears
      // of fails it for good, so no retry asks them again.
      this.#effected.add(attempt);
      return null;
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
      const args = sent.success
        ? boundedJson(sent.data[1], deepestSent(template.arguments))
        : undefined;
      if (!sent.success || args === undefined) {
        return await refuse(
          "A call sends its operation and JSON arguments within a step's size and the depth its build allows."
        );
      }
      const named = namedOtherwise(
        attempt.step,
        template,
        binding,
        sent.data[0],
        sent.data[2]
      );
      if (named !== undefined) {
        return await refuse(named);
      }
      const { params, calling } = this.run;
      // A test's run reaches only the model calls its test serves
      // (fixture-calls.ts): never a connection or an event. Refused before its arguments are matched,
      // its sensitive values put in or it is audited, so nothing says a
      // call went out.
      if (calling.fixture === true && !fixtureCalls.has(template.call.name)) {
        throw functionErrors.create("permission.unavailable");
      }
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
      requireArgumentsDepth(args.value);
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
   * arguments as the isolate sent them, placeholders and not values. A
   * test's run keeps none (`stepsAudited`): its calls are its fixture's.
   */
  async #auditCall(
    attempt: StepAttempt,
    template: CallTemplate,
    sent: Json
  ): Promise<void> {
    if (!this.stepsAudited) {
      return;
    }
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
    const { calling } = this.run;
    switch (call.name) {
      case "grasp.connector": {
        const built: BuiltCall = {
          name: call.name,
          binding: call.binding,
          operation: call.operation,
          arguments: value,
          sensitive,
          // The build's files permissions alone: never the isolate's.
          ...(call.into === undefined ? {} : { into: call.into }),
          ...(call.from === undefined ? {} : { from: call.from }),
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
      case "grasp.model": {
        const parts = modelArgumentsSchema.parse(value);
        this.#reserveModelCall(
          `${effect.key}:${attempt.number}:${attempt.generation}`
        );
        try {
          return await this.#madeOrServed(
            task,
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
      case "grasp.app": {
        // The App and the function by the IDs the build seals; the run's
        // grant on that function is decided as the call is made, and
        // again before each protected step of it (workflows/app-calls.ts).
        // Its effect's key is its step's, the same in every attempt, so a
        // mutation retried answers its stored receipt.
        return await makeCall(
          this.#env,
          calling,
          task.id,
          {
            name: "grasp.app",
            app: call.app,
            function: call.function,
            arguments: value,
          },
          effect
        );
      }
      case "grasp.files": {
        return await makeCall(
          this.#env,
          calling,
          task.id,
          {
            name: call.name,
            binding: call.binding,
            operation: call.operation,
            arguments: value,
          },
          effect
        );
      }
      case "grasp.brain": {
        return await makeCall(
          this.#env,
          calling,
          task.id,
          {
            name: "grasp.knowledge",
            binding: call.binding,
            operation: call.operation,
            arguments: value,
          },
          effect
        );
      }
      default: {
        return call satisfies never;
      }
    }
  }

  /**
   * A model call, made as a resource run's is; for a run an App's test
   * started, served by its test instead (fixture-calls.ts): the answer
   * its fixture gives.
   */
  async #madeOrServed(
    task: SealedTask,
    built: BuiltCall,
    effect: Effect
  ): Promise<Json> {
    const { calling } = this.run;
    if (calling.fixture !== true) {
      return await makeCall(this.#env, calling, task.id, built, effect);
    }
    // Tried once as a real call is: `fixtureCall` marks it as it goes out
    // (`SentCalls`), so no later attempt of its step sends it again.
    return await fixtureCall(
      this.#env,
      fixtureRunOf(this.run),
      task.id,
      built,
      effect
    );
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
}

/** The kind of run a sealed build's is, for the host (`RunHost`) to serve. */
export const sealedRun =
  (env: Env, run: HostedSealedRun, memory: SealedRunMemory) =>
  (host: HostControls): SealedRunKind =>
    new SealedRun(env, run, memory, host);

/** A sealed run's kind, and what its run's end checks of it. */
export interface SealedRunKind extends RunKind {
  /**
   * The failure no catch may take, if one is pending as the run's code
   * ends well (`SealedRun`).
   */
  readonly failureUntaken: StepError | undefined;
  /** What the run fails with when its code fails with `error` (`SealedRun`). */
  runFailure: (error: StepError) => StepError;
  /** The task whose step's failure `failure` is, if the run ends with it. */
  endingTask: (failure: StepError) => string | undefined;
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
 * (sealed-isolate.ts, `mainSource`).
 */
export const sealedRunModules = ({
  build,
}: HostedSealedRun): Record<string, string> => ({
  ...build.sdk,
  ...build.modules,
  ...sealedMainModules({
    module: generatedModule,
    refusal: "The sealed build doesn't export its workflow.",
  }),
});

/**
 * The aliases `build`'s calls go through: each sealed task's binding. A
 * run's frozen bindings are these; a test run binds none, its calls
 * answered from its start's fixtures or served by its test.
 */
const callAliasesOf = (build: LoadedBuild): string[] => [
  ...new Set(
    build.tasks.flatMap((task) =>
      task.kind === "call" && "binding" in task.call ? [task.call.binding] : []
    )
  ),
];

/**
 * What a sealed run's main module starts with: its input, only the
 * parameters the build lists as not sensitive, the aliases its calls
 * go through (`callAliasesOf`), each a binding whose `call` goes to the
 * host, which checks it against the sealed template and the run's
 * authority, its inboxes' reply addresses by alias (run-inboxes.ts), and
 * its state's snapshot, the same on every activation.
 */
export const sealedRunStart = async (env: Env, run: HostedSealedRun) => ({
  runId: run.runId,
  startedAt: run.createdAt,
  inbox: await inboxOf(env, run),
  params: Object.fromEntries(
    run.build.params.flatMap((name) =>
      Object.hasOwn(run.params, name) ? [[name, run.params[name] ?? null]] : []
    )
  ),
  input: run.input,
  state: run.state,
  connections: callAliasesOf(run.build),
});
