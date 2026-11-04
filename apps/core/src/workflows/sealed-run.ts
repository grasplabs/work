import { connectErrors } from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { runIdSchema } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import {
  executionErrors,
  paramsStep,
  placeholderOf,
  stepIdempotencyKey,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import type { StepUse } from "@grasp-os/shared/workflows";
import { namedError } from "@grasp-os/workerflow/errors";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed } from "../audit-outbox.ts";
import { memberRole } from "../auth/identity.ts";
import { generatedModule, loadWorkflowBuild } from "../workflow-builds.ts";
import type {
  LoadedBuild,
  SealedCall,
  SealedTask,
  SealedTemplate,
} from "../workflow-builds.ts";
import { AttemptHost, attemptCallLabels } from "./attempt-host.ts";
import type { AttemptCalls } from "./attempt-host.ts";
import { runModules } from "./code.ts";
import type { Settled, StepError } from "./code.ts";
import { emitEvent } from "./emitted-events.ts";
import {
  forIsolate,
  modelCallLimitOf,
  settle,
  unbilledAiWaitOf,
} from "./host.ts";
import type {
  HostControls,
  HostHooks,
  HostedRun,
  RunKind,
  StepAttempt,
} from "./host.ts";
import { admitAttempt } from "./quotas.ts";
import type { AttemptAdmission } from "./quotas.ts";
import { callAction } from "./resource-action.ts";
import { callingRunOf, runAuthority } from "./resource-authority.ts";
import type { CallingRun } from "./resource-authority.ts";
import { auditAdmissionRefusal, makeCall } from "./resource-calls.ts";
import type { BuiltCall, Effect } from "./resource-calls.ts";
import { callCompute } from "./resource-compute.ts";
import { decisionRunOf } from "./resource-decisions.ts";
import { boundedJson } from "./resource-host.ts";
import type { ActionModelCalls, TriedOnceMarks } from "./resource-host.ts";
import { requireResourceRunEvidenceReadable } from "./resource-reads.ts";
import { receiptOf, runOf, workflowOwnerOf } from "./resource-runs.ts";
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
//   (`sealedRunOf`): the build its start's receipt pins, every artifact
//   checked against the manifest and the manifest against the pin
//   (workflow-builds.ts, `loadWorkflowBuild`), and the build's identity
//   against the manifest's, which is the hash its row pins, before its
//   isolate can be loaded with exactly that build's modules
//   (`sealedRunModules`, which takes only the run `sealedRunOf` made). A
//   tampered build never runs (`workflow.version_corrupt`).
// - A step the build doesn't have. Each engine step's name is one of the
//   sealed table's (`stepTableOf`): `<task>:<step>` for a step of a task
//   in no items or branches, `workflow:input` and `workflow:output` where
//   the workflow has them, and the SDK's `$params`. Any other name, or a
//   step run as anything but a `do`, is refused, and fails the run.
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
//   step's record. An error reaches the isolate as its code and fixed
//   message only (host.ts, `forIsolate`): connect words each of its own by
//   code, never with what the tool said, and its details stay in core. The audit log keeps the arguments as the isolate sent
//   them, placeholders and not values, as a digest: it names things and
//   never carries their content (@grasp-os/shared/audit).
// - Authority that changed since the start. Every call is decided again as
//   it is made (`requireCallAuthority`, in `makeCall` and `emitEvent`): a
//   revoked approval, permission or role stops the next call
//   (`workflow.call_denied`). The person the run acts for must still be an
//   active member before every step.
// - An effect repeated. A store operation's, a model's and an action's
//   call goes out at most once per step, whatever its attempts
//   (`TriedOnceMarks`, marked as it goes out, after every check of its
//   own; a later attempt fails as the one that sent it did, and one that
//   provably billed nothing may be sent again); a connector's is keyed in connect under its step's key,
//   and a call connect holds for the person ends its step as held, which
//   runs again once they decided.
// - A run past what it may spend. Its model calls, its actions' included,
//   are held to its ceiling (`maxModelCalls`) as they go out; each call is
//   one of its lineage's host calls; its attempts are admitted as its
//   workflow's (`sealedAdmission`, `workflow-resource:<id>`).

/** A run of a sealed build, as its activation loaded it (`sealedRunOf`). */
export interface HostedSealedRun extends HostedRun {
  readonly workflowId: string;
  readonly version: number;
  /** Its sealed build, checked against the hash its row pins. */
  readonly build: LoadedBuild;
  /**
   * The parameter values its start froze, sensitive ones included: only
   * those the build lists as not sensitive reach the isolate.
   */
  readonly params: Readonly<Record<string, Json>>;
  /** Its input, as its start admitted it. */
  readonly input: Json;
  /** What its calls go by: its principal, invoker and frozen bindings. */
  readonly calling: CallingRun;
  /** The most model calls it may make: its build's and the host's lower. */
  readonly maxModelCalls: number;
}

/** What a sealed run's kind keeps with the run, across its activations. */
export interface SealedRunMemory {
  /**
   * Which attempts of its steps whose call is tried once never sent it,
   * and what one that did failed with (resource-host.ts, `TriedOnceMarks`).
   */
  triedOnce: TriedOnceMarks;
  /** The model calls it made, its actions' included. */
  modelCalls: ActionModelCalls;
  /** The run's own sandbox session on-prem, once open: its actions' parent. */
  sessionId?: () => string | undefined;
}

/** A step of the sealed table: its task (none for the workflow's own). */
interface SealedStep {
  readonly task?: SealedTask;
  readonly kind: string;
}

/**
 * The steps `build` seals, by engine name: the SDK runs step `name` with
 * key `key` as `name:key`. A task in a `for` or `fork` runs in none of
 * its items or branches here, so its steps are in no table.
 */
const stepTableOf = (build: LoadedBuild): ReadonlyMap<string, SealedStep> => {
  const table = new Map<string, SealedStep>();
  if (build.workflow.input) {
    table.set("workflow:input", { kind: "input" });
  }
  if (build.workflow.output) {
    table.set("workflow:output", { kind: "output" });
  }
  for (const task of build.tasks) {
    if (task.scope.length === 0) {
      for (const kind of task.steps) {
        table.set(`${task.id}:${kind}`, { task, kind });
      }
    }
  }
  return table;
};

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
 * What a tried-once call's attempt failed with when an earlier attempt
 * sent it and kept nothing it failed with: left open (its activation died,
 * the engine timed it out), as the engine's timeout would fail the step.
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

/** A refusal of what the build's code never sends: the run fails with it. */
const tampering = (message: string): Error => {
  const error = workflowErrors.create("workflow.invalid");
  error.message = message;
  return error;
};

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

/** What a sealed run's step completing records: nothing of its own. */
const nothingToRecord = async (): Promise<void> => {
  await Promise.resolve();
};

class SealedRun implements RunKind {
  readonly #env: Env;
  readonly #host: HostControls;
  readonly #memory: SealedRunMemory;
  readonly #steps: ReadonlyMap<string, SealedStep>;
  /** The attempts that made their call: each makes one. */
  readonly #called = new WeakSet<StepAttempt>();
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

  /** Refuses a step the sealed table doesn't have, or not as a `do`. */
  stepRefusal(step: string, use: StepUse): Error | undefined {
    if (use === "do" && (step === paramsStep || this.#steps.has(step))) {
      return undefined;
    }
    return tampering(`Step "${step}" isn't one the build seals.`);
  }

  readonly stepCompleted = nothingToRecord;

  attemptHost(attempt: StepAttempt, admission: AttemptAdmission): AttemptHost {
    // Its code starts: until it sends its call, a later attempt may too.
    if (this.#triesOnce(attempt)) {
      this.#memory.triedOnce.markUnstarted(attempt.key, attempt.number);
    }
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
        await this.#call(attempt, admission, binding, call),
      callModel: async () => await refused(attemptCallLabels.callModel),
      callCollection: async () =>
        await refused(attemptCallLabels.callCollection),
      callBrain: async () => await refused(attemptCallLabels.callBrain),
      callFunction: async () => await refused(attemptCallLabels.callFunction),
      openDecision: async () => await refused(attemptCallLabels.openDecision),
      decisionRecipients: async () =>
        await refused(attemptCallLabels.decisionRecipients),
      readAttachment: async () =>
        await refused(attemptCallLabels.readAttachment),
    };
    return new AttemptHost(
      calls,
      async (call) => await this.#host.leaseRefusal(attempt, call),
      async (call) => await this.#host.hostCallRefusal(attempt, admission, call)
    );
  }

  /** Whether `attempt`'s step makes a call tried once. */
  #triesOnce(attempt: StepAttempt): boolean {
    const { task, kind } = this.#steps.get(attempt.step) ?? {};
    return (
      kind === "task" &&
      task?.kind === "call" &&
      triedOnceCalls.has(task.call.name)
    );
  }

  /**
   * Refuses `attempt` of a step whose call is tried once when an earlier
   * attempt of it may have sent it: every one not marked as never having
   * sent it (`TriedOnceMarks.unstarted`), an attempt cut off before its
   * code ran included. It fails as the one that sent it did.
   */
  #requireNoneSent(attempt: StepAttempt): void {
    const marks = this.#memory.triedOnce;
    for (let earlier = 1; earlier < attempt.number; earlier += 1) {
      if (!marks.unstarted(attempt.key, earlier)) {
        throw triedBefore(marks.failureOf(attempt.key, earlier) ?? leftOpen);
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
      const { task, kind } = this.#steps.get(attempt.step) ?? {};
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
    const marks = this.#memory.triedOnce;
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
              marks.markStarted(attempt.key, attempt.number);
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
      if (once && !marks.unstarted(attempt.key, attempt.number)) {
        if (
          call.name === "grasp.model" &&
          unbilledAiWaitOf(error) !== undefined
        ) {
          // Provably billed nothing: the step's next run may ask again.
          marks.markUnstarted(attempt.key, attempt.number);
        } else {
          marks.keepFailure(attempt.key, attempt.number, forIsolate(error));
        }
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
          throw error;
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
  (host: HostControls): RunKind =>
    new SealedRun(env, run, memory, host);

/**
 * Run `runId` as its activation runs it, from its row and its start's
 * receipt: its sealed build loaded against the manifest the receipt pins,
 * every artifact and the build's identity checked against it, before any
 * of its code can run (`workflow.version_corrupt`). A run that has ended runs nothing
 * (`workflow.run_ended`).
 */
export const sealedRunOf = async (
  env: Env,
  runId: string
): Promise<HostedSealedRun> => {
  const row = await runOf(env, runId);
  const receipt = row === undefined ? undefined : await receiptOf(env, runId);
  if (
    row === undefined ||
    receipt?.manifestHash !== row.manifestHash ||
    receipt.input === null ||
    receipt.params === null
  ) {
    throw new Error(`Run ${runId}'s receipt doesn't admit it`);
  }
  // The receipt pins the manifest, and the row the build hash the start
  // read from that same manifest, both immutable: so the build's identity,
  // checked against the manifest's, is the row's too.
  const build = await loadWorkflowBuild(
    env,
    row.workflowResourceId,
    row.version,
    row.manifestHash
  );
  const calling = await callingRunOf(env, row.workflowResourceId, runId);
  if (calling === undefined) {
    throw workflowResourceErrors.create("workflow.run_ended");
  }
  const ceiling = modelCallLimitOf(env);
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
    workflowId: row.workflowResourceId,
    version: row.version,
    build,
    params: z.record(z.string(), z.json()).parse(JSON.parse(receipt.params)),
    input: z.json().parse(JSON.parse(receipt.input)),
    calling,
    maxModelCalls: Math.min(ceiling, build.limits.maxModelCalls ?? ceiling),
  };
};

/**
 * The modules a sealed run's isolate loads: its verified build's SDK and
 * generated module (`sealedRunOf`), and the main module that runs it
 * (code.ts, `runMain`).
 */
export const sealedRunModules = ({
  build,
}: HostedSealedRun): Record<string, string> => ({
  ...build.sdk,
  ...build.modules,
  ...runModules({
    module: generatedModule,
    refusal: "The sealed build doesn't export its workflow.",
  }),
});

/**
 * What a sealed run's main module starts with: its input, only the
 * parameters the build lists as not sensitive, and its frozen catalog
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
  connections: [...run.calling.bindings.keys()],
  collections: [],
  brains: [],
});

/**
 * Admits each attempt of `run` as its workflow's (`workflow-resource:<id>`),
 * against its account's lineage (quotas.ts).
 */
export const sealedAdmission =
  (env: Env, run: HostedSealedRun): NonNullable<HostHooks["admitAttempt"]> =>
  async (attempt) =>
    await admitAttempt(
      env,
      {
        run: run.runId,
        root: run.calling.accountRunId,
        resource: workflowOwnerOf(run.workflowId),
      },
      attempt
    );
