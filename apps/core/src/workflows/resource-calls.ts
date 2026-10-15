import { jsonSchemaOf } from "@grasp-os/sdk/host";
import { appExportsSchema } from "@grasp-os/shared/apps";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import {
  appIdSchema,
  connectionIdSchema,
  permissionIdSchema,
} from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { writeJson } from "@grasp-os/workflow-expressions/bounded-json";
import { evaluatorLimits } from "@grasp-os/workflow-expressions/limits";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { requireReleaseLoads } from "../app-releases.ts";
import { findApp } from "../apps.ts";
import { auditedBatch, outboxed } from "../audit-outbox.ts";
import { requireStepKey, runStubCall } from "../bindings.ts";
import { appVersions, permissions } from "../db/core/schema.ts";
import { appHost } from "../durable-objects.ts";
import { models } from "../models.ts";
import { authorizeExport } from "../permissions.ts";
import { resolveCatalogKeys } from "../workflow-catalog.ts";
import type { AttemptFence } from "./attempt-fence.ts";
import { schemaOfDescriptor, takesExactly } from "./exact-values.ts";
import {
  requireCallAuthority,
  runAuthority,
  runContext,
} from "./resource-authority.ts";
import type { CallingRun, FrozenCatalogBinding } from "./resource-authority.ts";

// The effects of a run of an independent workflow's sealed build
// (platform specification 13.6): its `grasp.connector`, `grasp.operation`
// and `grasp.model` calls, each through the target its start froze for
// the call's binding, and only through connect, an App's export or the
// model gateway, as every external call and model call of the platform.
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
//   (`authorize`, bindings.ts) and an export's (`authorizeExport`).
// - An effect repeated by a retry or a replay. A replay never calls: the
//   step answers what it recorded. Each effect has its own idempotency
//   key, its step's (`Effect.key`, the run and the task, so the same in
//   every attempt and replay), which connect keys a side effect's stored
//   result by, and an App's export gets as its caller's key, the only one
//   its own connection calls take. A model call's step isn't retried
//   (resource-host.ts): a model request is not idempotent.
// - Arguments or answers that aren't the contract's. Arguments are checked
//   against the binding's catalog contract before anything is sent, and
//   what comes back against it before the run sees it, by the SDK's
//   validator, which must take each exactly as it is
//   (`workflow.call_invalid`); a model's answer against the task's own
//   output schema, as sealed.
// - Restricted data reaching a run that would pass it on. A run never
//   enters restricted mode (restricted.ts): an operation of an App in
//   restricted mode is refused before it is called, and its answer
//   withheld if the App entered it meanwhile (`permission.restricted`).
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
    };

/** The binding kind each call goes through. */
const kindOf = {
  "grasp.operation": "operation",
  "grasp.connector": "connector",
  "grasp.model": "model",
} as const;

/** Keeps `entry` in the audit log, or fails before anything more. */
const audited = async (env: Env, entry: AuditEntry): Promise<void> => {
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [outboxed(db, entry)]);
};

const callInvalid = (issue: string) =>
  workflowResourceErrors.create("workflow.call_invalid", { issues: [issue] });

/**
 * `value`, an RPC call's result, without what the runtime adds to its top
 * level (its disposer, a symbol): only its own enumerable string keys,
 * read once, as JSON has.
 */
const rpcResult = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return [...items];
  }
  return typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : value;
};

/**
 * Refuses `value` unless the schema of `descriptor` (its JSON text) takes
 * it exactly as it is (exact-values.ts): a contract checks what crosses
 * it, never fills in or changes it (`workflow.call_invalid`, naming
 * `what`, never the value). Written once by the bounded writer first, so
 * a value past what a step records, or nested past the evaluator's depth,
 * is refused before anything walks it.
 */
const requireShape = (
  descriptor: string | undefined,
  value: unknown,
  what: string
): Json => {
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
  if (
    descriptor === undefined ||
    !parsed.success ||
    !takesExactly(descriptor, parsed.data)
  ) {
    throw callInvalid(`${what}: Not what the contract takes.`);
  }
  return parsed.data;
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
const contractOf = async (env: Env, binding: FrozenCatalogBinding) => {
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
    // Connect holds a workflow's side effect only in restricted mode,
    // which a run never enters: never a success.
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

/** The export `name` of App `app`'s version `version`, if there is one. */
const exportOf = async (
  env: Env,
  app: string,
  version: number,
  name: string
) => {
  const row = await drizzle(env.DB)
    .select({ exports: appVersions.exports })
    .from(appVersions)
    .where(and(eq(appVersions.appId, app), eq(appVersions.version, version)))
    .get();
  const exported = appExportsSchema.safeParse(row?.exports ?? {}).data;
  return exported !== undefined && Object.hasOwn(exported, name)
    ? exported[name]
    : undefined;
};

/** An operation call refused because the release it pins isn't current. */
const releaseNotCurrent = () =>
  workflowResourceErrors.create("workflow.call_release_not_current");

/**
 * Calls the export `binding`'s operation target names, at the App version
 * it pins, with `args`, for the run's principal, under the effect's key:
 * its answer, as the contract has it. Refused
 * (`workflow.call_release_not_current`) once that version isn't the App's
 * current one.
 */
const callOperation = async (
  env: Env,
  run: CallingRun,
  binding: FrozenCatalogBinding,
  call: Extract<BuiltCall, { name: "grasp.operation" }>,
  effect: Effect
): Promise<Json> => {
  const { target } = binding;
  if (target.kind !== "operation") {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  const contract = await contractOf(env, binding);
  const input = requireShape(contract.input, call.arguments, "arguments");
  const row = await workflowPermission(env, run, target.permissionId);
  const app = appIdSchema.safeParse(row.objectId);
  if (row.objectType !== "app" || !app.success) {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  try {
    // The release the approval pins: sealed, not revoked, intact.
    await requireReleaseLoads(env, app.data, target.appVersion);
  } catch (error) {
    if (isExpectedError(error)) {
      throw workflowResourceErrors.create("workflow.call_denied");
    }
    throw error;
  }
  const exported = await exportOf(
    env,
    app.data,
    target.appVersion,
    target.export
  );
  if (exported === undefined) {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  const authority = runAuthority(run);
  await authorizeExport(
    env,
    authority,
    app.data,
    { method: target.export, access: exported.access },
    permissionIdSchema.parse(target.permissionId)
  );
  // The App's host runs only its current version, on data that version's
  // schema shapes: a release no longer current (an upgrade or a rollback
  // since the approval) can't safely run against it, so the call is
  // refused, saying what to do, rather than routed to that release.
  const notCurrent = async (): Promise<boolean> => {
    const { currentVersion } = await findApp(env, app.data);
    return currentVersion !== target.appVersion;
  };
  if (await notCurrent()) {
    throw releaseNotCurrent();
  }
  const host = appHost(env, app.data);
  if (await host.isRestricted()) {
    throw permissionErrors.create("permission.restricted");
  }
  effect.requireHolds();
  let answer: unknown;
  try {
    answer = await host.call(
      {
        userId: run.principal,
        mode: "workflow",
        idempotencyKey: effect.key,
        fence: effect.fence,
        admission: {
          type: "workflowRun",
          workflow: run.workflowId,
          run: run.runId,
          alias: binding.alias,
        },
      },
      target.export,
      [input],
      {
        version: target.appVersion,
        chain: [],
        // A run's call holds no App's turn while it waits for one.
        holding: [],
        deadline: effect.deadline,
        readOnly: exported.access === "read",
        // Recorded once the App pinned the call to the version, before its
        // method runs: if it can't be, the method doesn't run.
        onPinned: async () => {
          // Decided again as the App takes the call: its authority may have
          // gone while the call waited for the App's turn, and the export
          // may change the App's data without a stub call that would ask.
          await requireCallAuthority(env, run, binding);
          effect.requireHolds();
          await audited(env, {
            actor: { type: "app", appId: app.data, part: "server" },
            action: "app.called",
            target: { type: "workflow_run", id: run.runId },
            detail: {
              method: target.export,
              access: exported.access,
              version: target.appVersion,
              workflow: run.workflowId,
              person: run.principal,
            },
          });
        },
      }
    );
  } catch (error) {
    // Another version made current as the call went out: said as such.
    if (
      isExpectedError(error) &&
      error.code === "app.conflict" &&
      (await notCurrent())
    ) {
      throw releaseNotCurrent();
    }
    throw error;
  }
  // The App may have read restricted data as it answered: withheld.
  if (await host.isRestricted()) {
    throw permissionErrors.create("permission.restricted");
  }
  return requireShape(contract.output, rpcResult(answer), "output");
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
 * Asks the model `binding`'s target names, through the model gateway, for
 * the task's structured output: its answer, as the task's output schema
 * takes it. The model is the binding's: a task may name it, never another.
 */
const callModel = async (
  env: Env,
  run: CallingRun,
  binding: FrozenCatalogBinding,
  call: Extract<BuiltCall, { name: "grasp.model" }>,
  effect: Effect
): Promise<Json> => {
  const { target } = binding;
  if (target.kind !== "model") {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  if (typeof call.instructions !== "string") {
    throw callInvalid("instructions: Give text.");
  }
  if (call.model !== undefined && call.model !== target.model) {
    throw callInvalid("model: The binding admits only its own model.");
  }
  const tokens = call.maxOutputTokens;
  if (
    tokens !== undefined &&
    (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 1)
  ) {
    throw callInvalid("maxOutputTokens: Give a whole number above 0.");
  }
  const descriptor = JSON.stringify(call.outputSchema);
  const native = schemaOfDescriptor(descriptor);
  // What refused the request, said as it was: the gateway reports any
  // failure of its own hooks as the model's.
  const refused: { by?: unknown } = {};
  let answer: Awaited<ReturnType<ReturnType<typeof models>["call"]>>;
  try {
    answer = await models(env).call({
      model: target.model,
      ...(tokens === undefined ? {} : { maxTokens: tokens }),
      system: call.instructions,
      input: z.json().parse(call.input),
      schema: z.fromJSONSchema(
        jsonSchemaOf(native.descriptor, { exact: true })
      ),
      purpose: "workflow.step",
      trigger: { type: "system" },
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
    });
  } catch (error) {
    throw refused.by ?? error;
  }
  return requireShape(descriptor, answer.output, "output");
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
        output = await callModel(env, run, binding, call, effect);
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
