import { jsonSchemaOf } from "@grasp-os/sdk/host";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import { connectionIdSchema, permissionIdSchema } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { writeJson } from "@grasp-os/workflow-expressions/bounded-json";
import { evaluatorLimits } from "@grasp-os/workflow-expressions/limits";
import { waitUntil } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed } from "../audit-outbox.ts";
import { requireStepKey, runStubCall } from "../bindings.ts";
import { permissions } from "../db/core/schema.ts";
import { models } from "../models.ts";
import {
  approvalServing,
  callApprovedStoreOperation,
} from "../workflow-bindings.ts";
import { resolveCatalogKeys } from "../workflow-catalog.ts";
import type { AttemptFence } from "./attempt-fence.ts";
import { schemaOfDescriptor, takesExactly } from "./exact-values.ts";
import {
  requireCallAuthority,
  runAuthority,
  runContext,
} from "./resource-authority.ts";
import type {
  CallingRun,
  CandidateBinding,
  FrozenCatalogBinding,
} from "./resource-authority.ts";
import {
  callKnowledge,
  callTemplate,
  requireKnowledgeRequest,
} from "./resource-reads.ts";

// The effects of a run of an independent workflow's sealed build
// (platform specification 13.6): its `grasp.connector`, `grasp.operation`
// and `grasp.model` calls, each through the target its start froze for
// the call's binding, and only through connect, a business store's public
// operation (store-operations.ts) or the model gateway, as every external call and model call of the platform.
// Its time and random numbers are the run host's (resource-host.ts).
//
// Threat model, and how each is closed:
//
// - A call naming a target its start didn't freeze. The binding is the
//   build's sealed literal, never the isolate's; it must be one of the
//   catalog bindings the run's start froze, of the call's kind, and the
//   target is the one frozen with it (`makeCall`): there is no lookup by
//   name, and nothing of the call's arguments chooses where it goes.
// - Authority that changed since the start. Every call is decided again
//   as it is made (resource-authority.ts): the principal's role, the
//   approval for the exact version, the permission it names, a trigger's
//   own grant; for a connector, once more just before the call goes to
//   connect, with nothing but the attempt's lease after it. Then the
//   permission itself, as every call of the platform: connect's capability
//   (`authorize`, bindings.ts) and a store operation's (store-operations.ts).
// - An effect repeated by a retry or a replay. A replay never calls: the
//   step answers what it recorded. Each effect has its own idempotency
//   key, its step's (`Effect.key`, the run and the task, so the same in
//   every attempt and replay), which connect keys a side effect's stored
//   result by, and a store operation commits under as its receipt's key.
//   A model call's step isn't retried
//   (resource-host.ts): a model request is not idempotent.
// - Arguments or answers that aren't the contract's. Arguments are checked
//   against the binding's catalog contract before anything is sent, and
//   what comes back against it before the run sees it, by the SDK's
//   validator, which must take each exactly as it is
//   (`workflow.call_invalid`); a model's answer against the task's own
//   output schema, as sealed.
// - Restricted data reaching a run that would pass it on. A run never
//   enters restricted mode once it runs (restricted.ts): for one that
//   isn't restricted, a store operation of a store whose App is
//   restricted is refused before it runs, and its answer withheld if the
//   App entered it meanwhile (`resource.unavailable`, workflow-
//   bindings.ts).
// - A restricted run (one a restricted App started) passing on what its
//   start carried. Its connector calls carry its restricted mode to
//   connect, which holds every one but a native connector's declared
//   reads for its person (`connect.held`; the run waits for their
//   decision, resource-host.ts); its model calls are judged as restricted
//   by the gateway's data rules; and the App owning a store it calls an
//   operation of is restricted before the input reaches it, audited with
//   the run as provenance (`callApprovedStoreOperation`).
// - Sensitive values in what a run records. A binding argument (a
//   sensitive parameter's value, put in by the host) is sent to connect
//   only, and a connector's answer that echoes one is refused
//   (`echoes`), so it never reaches the step's record; the receipts each
//   call leaves in the audit log (started, then its outcome) name the
//   call, its binding, approval, key, person and outcome, never an
//   argument or answer, and errors keep their code and fixed message only
//   (`forIsolate`).

/** What an effect is, beside its call: its key and the attempt it is of. */
export interface Effect {
  /** Its idempotency key: its step's, in every attempt and replay. */
  readonly key: string;
  /** When its attempt ends: nothing of it acts after. */
  readonly deadline: number;
  /** Its attempt, which every call it starts beyond core checks. */
  readonly fence: AttemptFence;
  /** Throws unless its attempt still holds its lease, nothing awaited. */
  readonly requireHolds: () => void;
  /**
   * Whether one of the workflow's own actions makes it (resource-action.ts):
   * a restricted run's action makes no connector call, whose held decision
   * would outlive the action that can't wait for it.
   */
  readonly fromAction?: boolean;
}

/** A task's call, its arguments built by the host (resource-host.ts). */
export type BuiltCall =
  | {
      readonly name: "grasp.operation";
      readonly binding: string;
      readonly arguments: Json;
    }
  | {
      readonly name: "grasp.connector";
      readonly binding: string;
      readonly operation: string;
      readonly arguments: Json;
      /** The values of the binding arguments the host put in. */
      readonly sensitive: readonly Json[];
    }
  | {
      readonly name: "grasp.model";
      readonly binding: string;
      readonly instructions: Json;
      readonly input: Json;
      /** The task's own output schema, as a descriptor. */
      readonly outputSchema: Json;
      readonly model?: Json;
      readonly maxOutputTokens?: Json;
    }
  | {
      /** A Knowledge collection's search or read, by an action (GRA-700). */
      readonly name: "grasp.knowledge";
      readonly binding: string;
      readonly operation: "search" | "read";
      readonly arguments: Json;
    }
  | {
      /** A pinned template version's content, by an action (GRA-700). */
      readonly name: "grasp.template";
      readonly binding: string;
    };

/** The binding kind each call goes through. */
const kindOf = {
  "grasp.operation": "operation",
  "grasp.connector": "connector",
  "grasp.model": "model",
  "grasp.knowledge": "knowledge",
  "grasp.template": "template",
} as const;

/** Keeps `entry` in the audit log, or fails before anything more. */
const audited = async (env: Env, entry: AuditEntry): Promise<void> => {
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [outboxed(db, entry)]);
};

const callInvalid = (issue: string) =>
  workflowResourceErrors.create("workflow.call_invalid", { issues: [issue] });

/**
 * Refuses `value` unless the schema of `descriptor` (its JSON text) takes
 * it exactly as it is (exact-values.ts): a contract checks what crosses
 * it, never fills in or changes it (`workflow.call_invalid`, naming
 * `what`, never the value). Written once by the bounded writer first, so
 * a value past what a step records, or nested past the evaluator's depth,
 * is refused before anything walks it.
 */
/** `value` as JSON, as much as a step records, or `workflow.call_invalid`. */
const boundedAnswer = (value: unknown, what: string): Json => {
  const written = writeJson(value, {
    maxBytes: platformLimits.stepPayloadBytes,
    maxDepth: evaluatorLimits.maxJsonDepth,
    maxNodes: platformLimits.stepPayloadBytes,
    sortKeys: false,
    safeIntegers: false,
  });
  if (!written.ok) {
    throw callInvalid(
      written.refusal === "too_large"
        ? `${what}: Larger than a step records.`
        : `${what}: Not JSON.`
    );
  }
  const parsed = z.json().safeParse(JSON.parse(written.text));
  if (!parsed.success) {
    throw callInvalid(`${what}: Not JSON.`);
  }
  return parsed.data;
};

export const requireShape = (
  descriptor: string | undefined,
  value: unknown,
  what: string
): Json => {
  const answer = boundedAnswer(value, what);
  if (descriptor === undefined || !takesExactly(descriptor, answer)) {
    throw callInvalid(`${what}: Not what the contract takes.`);
  }
  return answer;
};

/**
 * Whether `value` holds any of `sensitive`, the binding arguments a call
 * was sent with: a string one anywhere in a string or key of it, any
 * other as a whole value of it. An empty string holds nothing.
 */
const echoes = (value: Json, sensitive: readonly Json[]): boolean => {
  const texts = sensitive.filter(
    (secret): secret is string => typeof secret === "string" && secret !== ""
  );
  const others = new Set(
    sensitive
      .filter((secret) => typeof secret !== "string")
      .map((secret) => canonicalJson(secret))
  );
  const holds = (text: string): boolean =>
    texts.some((secret) => text.includes(secret));
  const walk = (node: Json): boolean => {
    if (others.size > 0 && others.has(canonicalJson(node))) {
      return true;
    }
    if (typeof node === "string") {
      return holds(node);
    }
    if (typeof node !== "object" || node === null) {
      return false;
    }
    const list = Array.isArray(node);
    const entries: [string, Json | undefined][] = Object.entries(node);
    return entries.some(
      ([key, item]) => (!list && holds(key)) || walk(item ?? null)
    );
  };
  return walk(value);
};

/** The catalog contract of `binding`, as its fingerprint pins it. */
const contractOf = async (
  env: Env,
  binding: Pick<FrozenCatalogBinding, "contractId" | "fingerprint">
) => {
  const resolved = await resolveCatalogKeys(env, [binding.contractId]);
  const found = resolved.get(binding.contractId);
  if (found?.fingerprint !== binding.fingerprint) {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  return found.contract;
};

/** The workflow's own active permission `id`, as its row has it. */
const workflowPermission = async (env: Env, run: CallingRun, id: string) => {
  const row = await drizzle(env.DB)
    .select({
      objectType: permissions.objectType,
      objectId: permissions.objectId,
      resource: permissions.resource,
    })
    .from(permissions)
    .where(
      and(
        eq(permissions.id, id),
        eq(permissions.subjectType, "workflow"),
        eq(permissions.subjectId, run.workflowId),
        eq(permissions.status, "active")
      )
    )
    .get();
  if (row === undefined) {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  return row;
};

/**
 * Calls connector action `operation` through `binding`'s connection
 * permission, with `args` (binding arguments in), under the effect's key,
 * through connect: its answer, as the contract has it.
 */
const callConnector = async (
  env: Env,
  run: CallingRun,
  binding: FrozenCatalogBinding,
  call: Extract<BuiltCall, { name: "grasp.connector" }>,
  effect: Effect
): Promise<Json> => {
  const { target } = binding;
  if (target.kind !== "connector") {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  const contract = await contractOf(env, binding);
  const shape = Object.hasOwn(contract.operations ?? {}, call.operation)
    ? contract.operations?.[call.operation]
    : undefined;
  if (shape === undefined) {
    throw callInvalid("operation: The contract has no such operation.");
  }
  const input = requireShape(shape.input, call.arguments, "arguments");
  const row = await workflowPermission(env, run, target.permissionId);
  if (row.objectType !== "connection") {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  const result = await runStubCall(
    env,
    // Refused at once, before any check, for a key other than the step's.
    // oxlint-disable-next-line require-await -- a stub's resolver is async by contract; this one has nothing to wait for
    async (key) => {
      requireStepKey(key, effect.key);
      return {
        authority: runAuthority(run),
        notAfter: effect.deadline,
        // A sensitive parameter's value is in its input: connect keeps
        // none of it, so no listing of a lost outcome shows it.
        sensitive: call.sensitive.length > 0,
        // Last, after the permission check and the signing: the run's
        // authority again, then its attempt, nothing awaited after.
        stillAllowed: async () => {
          await requireCallAuthority(env, run, binding);
          effect.requireHolds();
        },
      };
    },
    {
      context: runContext(run),
      permissionId: permissionIdSchema.parse(target.permissionId),
      connection: {
        type: "connection",
        connectionId: connectionIdSchema.parse(row.objectId),
        ...(row.resource === null ? {} : { resource: row.resource }),
      },
    },
    [call.operation, input, { idempotencyKey: effect.key }]
  );
  if (result.pending !== undefined) {
    // Connect answers a workflow's held side effect (a restricted run's)
    // with `connect.held`, whose decision the run waits for
    // (resource-host.ts), never with a held answer: never a success.
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  let output: unknown;
  try {
    output = JSON.parse(result.output);
  } catch {
    throw callInvalid("output: Not JSON.");
  }
  const answer = requireShape(shape.output, output, "output");
  // An answer that echoes a binding argument would put its sensitive
  // value in the step's record, and on into the run: refused, never
  // redacted, so nothing of it is recorded.
  if (echoes(answer, call.sensitive)) {
    throw callInvalid("output: It echoes a sensitive argument.");
  }
  return answer;
};

/**
 * Calls the store operation the approval frozen with `binding` names
 * (`callApprovedStoreOperation`, workflow-bindings.ts), with `args`, as
 * the run's principal, under the effect's key: its answer, as the contract
 * has it. The approval must be the one its start froze, still active for
 * the run's version; the store, its operation and shape are read again for
 * the call, the run's authority and attempt before each protected step,
 * and nothing comes of a store whose App is restricted, before or after
 * the call (`resource.unavailable`).
 */
const callStoreOperation = async (
  env: Env,
  run: CallingRun,
  binding: FrozenCatalogBinding,
  call: Extract<BuiltCall, { name: "grasp.operation" }>,
  effect: Effect
): Promise<Json> => {
  const contract = await contractOf(env, binding);
  const input = requireShape(contract.input, call.arguments, "arguments");
  const approval = await approvalServing(
    env,
    run.workflowId,
    run.version,
    binding
  );
  if (approval?.id !== binding.approval) {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  effect.requireHolds();
  const answer = await callApprovedStoreOperation(
    env,
    {
      id: run.workflowId,
      version: run.version,
      approval,
      restrictedRun: run.restricted ? run.runId : null,
    },
    input,
    {
      // As the run's own receipts name it: an independent run acts as no
      // App, and its person is `principal`.
      actor: { type: "system" },
      principal: run.principal,
      requestId: crypto.randomUUID(),
      deadline: effect.deadline,
      idempotencyKey: effect.key,
      runId: run.runId,
      stillAllowed: async () => {
        await requireCallAuthority(env, run, binding);
        effect.requireHolds();
      },
      requireHolds: effect.requireHolds,
    }
  );
  return requireShape(contract.output, answer, "output");
};

/**
 * Calls the operation `binding`'s target names: a business store's public
 * operation, the only target an operation binding has (workflow-
 * resources.ts). Anything else serves nothing (`workflow.call_denied`).
 */
const callOperation = async (
  env: Env,
  run: CallingRun,
  binding: FrozenCatalogBinding,
  call: Extract<BuiltCall, { name: "grasp.operation" }>,
  effect: Effect
): Promise<Json> => {
  if (binding.target.kind !== "storeOperation") {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  return await callStoreOperation(env, run, binding, call, effect);
};

/** The connections the run's connector bindings reach, for the model rules. */
const connectionsOf = async (env: Env, run: CallingRun): Promise<string[]> => {
  const ids = [...run.bindings.values()].flatMap(({ target }) =>
    target.kind === "connector" ? [target.permissionId] : []
  );
  if (ids.length === 0) {
    return [];
  }
  const rows = await drizzle(env.DB)
    .select({ objectId: permissions.objectId })
    .from(permissions)
    .where(
      and(
        inArray(permissions.id, ids),
        eq(permissions.objectType, "connection")
      )
    );
  return [...new Set(rows.map(({ objectId }) => objectId))];
};

/**
 * What model call `call` asks for, checked as every model call is, a test
 * run's included: its instructions as text, and a whole number above 0 of
 * output tokens if any (`workflow.call_invalid` otherwise).
 */
const requireModelRequest = (
  call: Extract<BuiltCall, { name: "grasp.model" }>
): { instructions: string; tokens: number | undefined } => {
  if (typeof call.instructions !== "string") {
    throw callInvalid("instructions: Give text.");
  }
  const tokens = call.maxOutputTokens;
  if (
    tokens !== undefined &&
    (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 1)
  ) {
    throw callInvalid("maxOutputTokens: Give a whole number above 0.");
  }
  return { instructions: call.instructions, tokens };
};

/**
 * Asks the model `binding`'s target names, through the model gateway, for
 * the task's structured output: its answer, as the task's output schema
 * takes it. The model is the binding's: a task may name it, never another.
 */
const callModel = async (
  env: Env,
  run: CallingRun,
  task: string,
  binding: FrozenCatalogBinding,
  call: Extract<BuiltCall, { name: "grasp.model" }>,
  effect: Effect
): Promise<Json> => {
  const { target } = binding;
  if (target.kind !== "model") {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  const { instructions, tokens } = requireModelRequest(call);
  if (call.model !== undefined && call.model !== target.model) {
    throw callInvalid("model: The binding admits only its own model.");
  }
  const descriptor = JSON.stringify(call.outputSchema);
  const native = schemaOfDescriptor(descriptor);
  // What refused the request, said as it was: the gateway reports any
  // failure of its own hooks as the model's.
  const refused: { by?: unknown } = {};
  // Its attempt's deadline, as a signal: cleared once the call settles, so
  // no timer outlives it.
  const remaining = Math.max(1, Math.floor(effect.deadline - Date.now()));
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new DOMException("The attempt timed out", "TimeoutError"));
  }, remaining);
  let answer: Awaited<ReturnType<ReturnType<typeof models>["call"]>>;
  try {
    answer = await models(env).call({
      model: target.model,
      ...(tokens === undefined ? {} : { maxTokens: tokens }),
      system: instructions,
      input: z.json().parse(call.input),
      schema: z.fromJSONSchema(
        jsonSchemaOf(native.descriptor, { exact: true })
      ),
      purpose: "workflow.step",
      trigger: { type: "system" },
      runStep: { runId: run.runId, step: task },
      connections: await connectionsOf(env, run),
      work: { authority: runAuthority(run), context: runContext(run) },
      // Once the ledger admitted each provider request, the run's authority
      // decided again (it may have gone while the request waited), then its
      // lease, nothing awaited before the request is sent.
      reauthorize: async () => {
        try {
          await requireCallAuthority(env, run, binding);
        } catch (error) {
          refused.by = error;
          throw error;
        }
      },
      beforeSend: effect.requireHolds,
      // One request per call, so the run's limit of model calls
      // (`maxModelCalls`, resource-host.ts) bounds its requests: an answer
      // that doesn't fit the task's schema fails the call, never asks again,
      // and a request the provider refused for a moment isn't sent again
      // either: the step is tried once (spec 13.7), so a refusal fails it.
      askAgain: false,
      providerRetries: false,
      // No longer than its attempt may run, from now through its admission
      // and its request: one past it is cut off, never left running (and
      // paid for) after the attempt timed out.
      timeoutMs: remaining,
      signal: deadline.signal,
    });
  } catch (error) {
    throw refused.by ?? error;
  } finally {
    clearTimeout(timer);
  }
  return requireShape(descriptor, answer.output, "output");
};

/**
 * Why an action's call was refused at its host's own admission
 * (resource-action.ts), before it was ever a named call: a binding its
 * sealed `uses` doesn't list, a connector operation its use doesn't
 * declare, a request of the wrong shape or past its bounds, one past the
 * attempt's calls, or a model call past the run's `maxModelCalls`
 * (resource-host.ts, GRA-700).
 */
export type AdmissionReason =
  | "use_undeclared"
  | "operation_undeclared"
  | "request_invalid"
  | "call_limit"
  | "model_call_limit";

/** An action's call refused at admission, as its evidence names it. */
interface AdmissionRefusal {
  readonly build: string;
  readonly task: string;
  readonly attempt: number;
  readonly generation: number;
  readonly call: string | null;
  readonly errorCode: string;
  readonly reason: AdmissionReason;
}

/** Writes `refusal`'s evidence; logs, never throws, one it can't keep. */
const writeAdmissionRefusal = async (
  env: Env,
  run: CallingRun,
  refusal: AdmissionRefusal
): Promise<void> => {
  try {
    await audited(env, {
      actor: { type: "system" },
      action: "workflow.call.refused",
      target: { type: "workflow_run", id: run.runId },
      detail: {
        workflow: run.workflowId,
        version: run.version,
        person: run.principal,
        // A test run's refusal says so: it was never a run of a version.
        ...(run.candidate === undefined ? {} : { candidate: true }),
        ...refusal,
      },
    });
  } catch (error) {
    log.error("workflow.call.audit_failed", {
      runId: run.runId,
      task: refusal.task,
      errorCode: refusal.errorCode,
      ...errorFields(error),
    });
  }
};

/**
 * Keeps the evidence of an action's call refused at its host's own
 * admission, as `workflow.call.refused`, the event App runs' refused calls
 * leave (workflows/host.ts): what the host knows of the run, its build,
 * task and attempt, never what the isolate sent. `call` is a declared
 * alias, or null: an undeclared one is the isolate's text. An event that
 * can't be kept is logged; the refusal stands either way.
 *
 * The write is the request's own work until it is done (`waitUntil`):
 * `callAction` waits for an action no longer than its attempt's deadline,
 * and a write it stopped waiting for still finishes rather than ending
 * with the call. Every refusal path goes through here, so none can skip it.
 */
export const auditAdmissionRefusal = async (
  env: Env,
  run: CallingRun,
  refusal: AdmissionRefusal
): Promise<void> => {
  const writing = writeAdmissionRefusal(env, run, refusal);
  waitUntil(writing);
  await writing;
};

/**
 * What `call` of a test run answers: the answer its start gave the call's
 * binding, checked as a real call checks what it sends and what comes back
 * (against the catalog contract the checkpoint was checked against, still
 * as it was, or the task's own output schema), so a test run passes only
 * what a run of the published version would. Nothing of it leaves core.
 */
const candidateAnswer = async (
  env: Env,
  bindings: ReadonlyMap<string, CandidateBinding>,
  call: BuiltCall
): Promise<Json> => {
  const binding = bindings.get(call.binding);
  if (binding?.kind !== kindOf[call.name]) {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  const { answer } = binding;
  if (answer === undefined) {
    throw workflowResourceErrors.create("workflow.candidate_unfixtured");
  }
  switch (call.name) {
    case "grasp.connector": {
      const contract = await contractOf(env, binding);
      const shape = Object.hasOwn(contract.operations ?? {}, call.operation)
        ? contract.operations?.[call.operation]
        : undefined;
      if (shape === undefined) {
        throw callInvalid("operation: The contract has no such operation.");
      }
      requireShape(shape.input, call.arguments, "arguments");
      return requireShape(shape.output, answer, "output");
    }
    case "grasp.operation": {
      const contract = await contractOf(env, binding);
      requireShape(contract.input, call.arguments, "arguments");
      return requireShape(contract.output, answer, "output");
    }
    case "grasp.model": {
      requireModelRequest(call);
      return requireShape(JSON.stringify(call.outputSchema), answer, "output");
    }
    case "grasp.knowledge": {
      requireKnowledgeRequest(call);
      return boundedAnswer(answer, "output");
    }
    case "grasp.template": {
      return boundedAnswer(answer, "output");
    }
    default: {
      return call satisfies never;
    }
  }
};

/**
 * Makes `call`, a task's named call with its arguments built, as task
 * `task` of `run`, for `effect`: through the binding its start froze for
 * the call's alias, once the authority behind it was decided again
 * (`requireCallAuthority`). Leaves its receipt in the audit log, whatever
 * came of it: the call, its binding, approval and key, and its outcome by
 * code, never an argument or answer.
 */
export const makeCall = async (
  env: Env,
  run: CallingRun,
  task: string,
  call: BuiltCall,
  effect: Effect
): Promise<Json> => {
  // A test run of a draft's checkpoint calls nothing: whatever the call,
  // its answer is the one the run's start gave its binding, before any
  // binding, authority or receipt is looked at, so nothing of it can
  // reach connect, a model, an App, a store or Knowledge.
  if (run.candidate !== undefined) {
    return await candidateAnswer(env, run.candidate, call);
  }
  const binding = run.bindings.get(call.binding);
  if (binding?.kind !== kindOf[call.name]) {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  const receipt = (outcome: string): AuditEntry => ({
    actor: { type: "system" },
    action: "workflow.run.called",
    target: { type: "workflow_run", id: run.runId },
    detail: {
      workflow: run.workflowId,
      version: run.version,
      task,
      call: call.name,
      binding: binding.alias,
      approval: binding.approval,
      key: effect.key,
      person: run.principal,
      outcome,
    },
  });
  // The outcome's receipt follows the started one, which is kept before
  // anything is sent: a failure to keep it is logged, never put in place
  // of what the call came to.
  const outcomeKept = async (outcome: string): Promise<void> => {
    try {
      await audited(env, receipt(outcome));
    } catch (error) {
      log.error("workflow.run_receipt_unkept", {
        runId: run.runId,
        task,
        outcome,
        ...errorFields(error),
      });
    }
  };
  let output: Json;
  try {
    // Refused before anything is decided or sent, and kept as the call's
    // receipt: connect would hold it for a decision no action waits for.
    if (
      effect.fromAction === true &&
      run.restricted &&
      call.name === "grasp.connector"
    ) {
      throw workflowResourceErrors.create("workflow.action_restricted");
    }
    await requireCallAuthority(env, run, binding);
    // Kept before the call goes out, or it doesn't go: a call that took
    // effect always has its receipt, whatever happens after.
    await audited(env, receipt("started"));
    switch (call.name) {
      case "grasp.connector": {
        output = await callConnector(env, run, binding, call, effect);
        break;
      }
      case "grasp.operation": {
        output = await callOperation(env, run, binding, call, effect);
        break;
      }
      case "grasp.model": {
        output = await callModel(env, run, task, binding, call, effect);
        break;
      }
      case "grasp.knowledge": {
        output = await callKnowledge(env, run, binding, call);
        break;
      }
      case "grasp.template": {
        output = await callTemplate(env, binding);
        break;
      }
      default: {
        return call satisfies never;
      }
    }
  } catch (error) {
    await outcomeKept(
      isExpectedError(error) ? error.code : "internal.unexpected"
    );
    throw error;
  }
  await outcomeKept("done");
  return output;
};
