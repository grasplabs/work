import { AppError } from "@grasp-os/sdk";
import type {
  AnyResource,
  JsonValue,
  ResourceKind,
  ValueSchema,
} from "@grasp-os/sdk";
import {
  schemaFromDescriptor,
  schemaHash,
  appErrorDetailsOf,
} from "@grasp-os/sdk/host";
import type { AppManifest, OperationManifest } from "@grasp-os/sdk/host";
import type { OperationChannel } from "@grasp-os/sdk/runner";
import { appCallLimits } from "@grasp-os/shared/apps";
import { deadline as timeLimit, whenAborted } from "@grasp-os/shared/deadline";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { internalErrors, isExpectedError } from "@grasp-os/shared/errors";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  appErrorDetailsMaxBytes,
  appErrorMessageMaxLength,
  invocationMaxReads,
  isAppErrorCode,
  knowledgeSearchMaxLength,
  operationInputMaxBytes,
  operationResultMaxBytes,
  stagedReadMaxBytes,
  streamMaxEmits,
  streamProgressMaxBytes,
} from "@grasp-os/shared/operation-limits";
import {
  categoryOf,
  effectErrors,
  isPlatformCode,
  isRetryableCode,
  jsonOf,
  jsonWithin,
  operationErrors,
} from "@grasp-os/shared/operations";
import type {
  AppErrorPayload,
  OperationResult,
} from "@grasp-os/shared/operations";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { mintRecordId } from "@grasp-os/shared/record-ids";
import { statisticMaxGroups } from "@grasp-os/shared/statistics";
import {
  readRequestSchema,
  writeRequestSchema,
} from "@grasp-os/shared/store-queries";
import type { ReadScope } from "@grasp-os/shared/store-queries";
import {
  commitMaxWrites,
  dataErrors,
  stagedMaxBytes,
} from "@grasp-os/shared/stores";
import type {
  StagedWrites,
  StoreFields,
  WriterRoles,
} from "@grasp-os/shared/stores";
import {
  idempotencyKeySchema,
  submissionErrors,
} from "@grasp-os/shared/submissions";
import { executionErrors } from "@grasp-os/shared/workflows";
import { z } from "zod";

import { callMaxNested, queryMaxReruns } from "./call-limits.ts";
import { CallTree } from "./call-tree.ts";
import type { RunnerCall } from "./call-tree.ts";
import type { OpenStore } from "./data-stores.ts";
import { openChannel } from "./operation-channel.ts";
import type { OpenChannel } from "./operation-channel.ts";
import { sandboxVerdictOf } from "./sandbox-session.ts";
import { SandboxUnavailableError } from "./sandboxed.ts";
import { readConsistently, StoreReader } from "./store-reader.ts";

// Core's operation host (spec 7.4, 7.5, 9.2, 9.5, 32.1): runs one of an
// App's server functions for one caller, through the trusted host, and
// answers what it returned or why it failed, as an `OperationResult`.
// App code runs where the runner puts it (`Runner`; the SDK's
// `runFunction`) and holds nothing but its invocation's channel
// (operation-channel.ts); everything that decides what the call may do is
// here. Threat model, and how each is closed:
//
// - A caller names a function it can't call: only the App's public tree
//   is reachable from outside, by path and kind; an internal path, an
//   unknown one and one of another kind are refused the same way
//   (`operation.not_found`, `operation.kind_mismatch`), before anything
//   runs.
// - A caller sends too much, or what isn't JSON: the input is read as
//   JSON and measured (128 KiB of UTF-8, `operationInputMaxBytes`) before
//   it is validated; then validated by the descriptor the App's
//   inspection recorded, never by App code, and the handler gets the
//   normalized value.
// - A caller or App code picks whom the call is for: the read scope
//   (principal, role flags, consumer) comes only from the invocation core
//   resolved (`Invocation`), and the schema hash from the App's pinned
//   manifest, hashed here; no channel method takes any of them.
// - A query writes, a mutation reaches outside, an action holds the
//   database: each kind's channel has only its capabilities, whatever the
//   App code sends (operation-channel.ts): an action reaches data only
//   through the App's queries and mutations it lists, each an invocation
//   of its own.
// - A function's access is widened past its declaration: every read and
//   staged write is checked against the verbs inspection gave the
//   function (its kind and `operationAccess`, narrowing only), and the
//   store checks every read and commit against the pinned schema's own
//   access for the caller's roles, so neither check alone decides.
// - A mutation writes what its schema doesn't allow: every staged write is
//   validated against the pinned table's fields (an insert with its
//   defaults, a patch never with them, managed fields and unknown fields
//   refused), and its record ID, for an insert, is minted here.
// - A mutation commits on authority it lost while it ran: the caller is
//   authorized again just before its commit, and the commit carries the
//   roles found then, which the store enforces in the commit's
//   transaction.
// - A mutation commits on stale reads: its commit carries its guards
//   (revisions it asserted) and its read set (the generation of every
//   table it read); the store refuses either moved on. A read set moved
//   on runs the mutation again (`queryMaxReruns` times, then the
//   retryable `mutation.concurrent_change`); a guard never does.
// - A submission is repeated or forged: its receipt is claimed under a
//   key core makes from the caller's idempotency key and a scope it
//   resolved (the store derives the receipt's ID; nobody names one), and
//   its outcome, what the mutation returned included, is answered again
//   to the same key and input.
// - A function answers what its contract doesn't allow: the return is
//   read as JSON, measured, validated, and must already be in its
//   normalized form (`contract.invalid_return`), so the caller gets
//   exactly what the contract says.
// - A caller who lost the right keeps reaching outside: every resource
//   request is admitted by the same `authorize` a mutation's commit is
//   (`admit`), whatever it checks (the release not revoked, the caller's
//   roles, what admitted the caller), so the two gates can't drift apart.
// - A streaming action's progress (spec 10.7.6) is a way out of its
//   contract: a streaming action runs only through the streaming path,
//   and any other only through the single-answer one, refused the other
//   way round (`operation.mode_mismatch`), nested calls included; each
//   snapshot is read as JSON, measured (`streamProgressMaxBytes`),
//   validated by the action's `stream` descriptor and must already be
//   normalized, as a return is (`contract.invalid_progress`), and one
//   invocation emits at most `streamMaxEmits`. Only the invocation the
//   caller named emits: a streaming action can't be nested, and the
//   channel of anything it calls has no `emit`.
// - A cancelled stream goes on acting: cancellation stops the run as its
//   deadline does (its channel ends, so nothing more it starts is
//   admitted, and nothing it staged commits) and refuses every later
//   emit; every mutation it runs checks for it just before its commit,
//   and every resource request just before it is sent. What it already
//   committed or dispatched stays, and its derived keys answer those again
//   to a call under the same key, never twice.
// - A cancel claims an outcome it can't know: one that lands while an
//   effect the run started is still under way (a nested mutation
//   committing, a request out) answers the uncertain
//   `operation.outcome_unknown`, never a definite `operation.cancelled`
//   that would invite running it again under a new key.
// - A failure leaks what it shouldn't: a caller gets an `AppErrorPayload`
//   and nothing more. An `AppError` App code threw keeps its code (never
//   a platform one), message and bounded details; a platform error
//   counts only if this invocation's channel raised it (App code can't
//   pass a made-up `data.conflict` off as the store's); anything else is
//   `internal.unexpected` with the request ID, its cause logged.

/** Who an invocation is for, as core resolved it: never App code. */
export interface Invocation {
  /** The person the call acts for, who owns what it inserts. */
  readonly principal: string;
  /** The App and version it comes through, which cursors are bound to. */
  readonly consumer: {
    readonly resourceId: string;
    readonly resourceVersion: number;
  };
  /** The App's store. */
  readonly store: OpenStore;
  /** The ID of this request, which a failure carries for the logs. */
  readonly requestId: string;
  /** When the call must end, in milliseconds since the epoch. */
  readonly deadline: number;
  /** The workflow run the call is made in, whose life keeps its receipt. */
  readonly runId: string | null;
  /**
   * Another App or a workflow calling the store's public operation
   * (store-operations.ts), by ID and version: each commit names it, in the
   * store, for as long as the store is. None for the App's own calls.
   */
  readonly writer?: {
    readonly resourceId: string;
    readonly resourceVersion: number;
  };
  /**
   * The caller's roles in the App, read again on each call; throws when
   * they may no longer use it. The one admission (`admit`): called as the
   * call starts, just before each mutation commits and before each
   * resource request, so whatever it checks holds before all three.
   */
  readonly authorize: () => Promise<WriterRoles>;
  /** How core binds the App's resources for this call; none bound without it. */
  readonly resources?: ResourceBindings;
  /**
   * Told what a query the caller named read, once its reads stand as one
   * state of the store (`readConsistently`): the generation of each table
   * it read, which a live query watches (query-subscriptions.ts).
   */
  readonly observeReads?: (readSet: Record<string, number>) => void;
}

/**
 * Runs a registered function's handler over a channel: the SDK's
 * `runFunction` with the App's registration, wherever its code runs.
 */
export type Runner = (
  path: string,
  args: Json,
  channel: OperationChannel,
  /**
   * Aborted once the host stops waiting for the run (its deadline): a
   * runner that can end the run then does, and frees what it held (an
   * on-prem sandbox session's process, app-functions.ts).
   */
  signal?: AbortSignal,
  /**
   * The call it runs in: one object for every function one caller's call
   * runs, nested or not, so a runner may run them together (on-prem, in
   * the sandbox session of the function the caller named).
   */
  call?: RunnerCall
) => Promise<unknown>;

/** An App as the host runs it: its inspected manifest and its runner. */
export interface HostedApp {
  readonly manifest: AppManifest;
  readonly run: Runner;
}

/** A function as its caller names it: its public path and kind. */
export interface OperationReference {
  readonly path: string;
  readonly kind: string;
}

/**
 * Where a streaming action's progress goes (spec 10.7.6): the caller's,
 * for the one invocation it named.
 */
export interface ProgressSink {
  /**
   * Takes one snapshot, validated and normalized: the caller keeps only
   * the latest, so a snapshot no one read yet is replaced, never queued.
   */
  readonly publish: (progress: Json) => void;
}

/** What a caller may pass along with a call. */
export interface CallOptions {
  /** A mutation's submission key: one per logical submission, reused by retries. */
  readonly idempotencyKey?: string;
  /**
   * On-prem, the sandbox session (its call ID) of the call this one is
   * made from (a Code Mode run's): its functions' session is that one's
   * child (`CallTree.parentSession`).
   */
  readonly parentSession?: string;
  /**
   * For a streaming action, and only for one: where its progress goes.
   * Without it a streaming action is refused, and with it any other.
   */
  readonly progress?: ProgressSink;
  /**
   * Aborted once the caller cancels the call: every run in it stops as at
   * its deadline, and what it answers says what is known (`stoppedCode`).
   */
  readonly cancelled?: AbortSignal;
  /**
   * Told of each effect the call made, or may have made, at any depth: a
   * mutation or an action it called, a resource request. A request a
   * busy model budget refused before sending it isn't one. A caller that
   * keeps the call's outcome keeps it once one was told, since running it
   * again would act on what that effect changed.
   */
  readonly onEffect?: () => void;
  /** A budget it shares with other calls (`sharedBudget`), not its own. */
  readonly budget?: SharedBudget;
}

/** A table of the App's schema, as staged writes are checked against it. */
interface CheckedTable {
  readonly fields: Readonly<Record<string, ValueDescriptorLike>>;
  /** The whole record's fields, with their defaults: an insert, a replacement. */
  readonly whole: ValueSchema<unknown, unknown>;
}

/** A descriptor as the manifest holds it. */
type ValueDescriptorLike = OperationManifest["args"];

/** What the host derives from a manifest once. */
interface Compiled {
  readonly hash: Promise<string>;
  /** Each function's receipt contract, once computed (`contractIdOf`). */
  readonly contracts: Map<string, Promise<string>>;
  readonly args: ReadonlyMap<string, ValueSchema<unknown, unknown>>;
  readonly returns: ReadonlyMap<string, ValueSchema<unknown, unknown>>;
  /** Each streaming action's progress snapshot. */
  readonly streams: ReadonlyMap<string, ValueSchema<unknown, unknown>>;
  readonly tables: ReadonlyMap<string, CheckedTable>;
}

const compiledApps = new WeakMap<AppManifest, Compiled>();

const schemaOfDescriptor = (
  descriptor: unknown
): ValueSchema<unknown, unknown> =>
  schemaFromDescriptor(JSON.stringify(descriptor));

/** The strict object of `fields`, as a descriptor. */
const objectOf = (fields: Readonly<Record<string, unknown>>) => ({
  descriptorVersion: 1,
  kind: "object",
  presence: "required",
  nullable: false,
  fields,
});

/** What the host checks `manifest`'s calls and writes with, derived once. */
const compiledOf = (manifest: AppManifest): Compiled => {
  const known = compiledApps.get(manifest);
  if (known !== undefined) {
    return known;
  }
  const args = new Map<string, ValueSchema<unknown, unknown>>();
  const returns = new Map<string, ValueSchema<unknown, unknown>>();
  const streams = new Map<string, ValueSchema<unknown, unknown>>();
  for (const [path, operation] of Object.entries(manifest.operations)) {
    args.set(path, schemaOfDescriptor(operation.args));
    returns.set(path, schemaOfDescriptor(operation.returns));
    if (operation.stream !== null) {
      streams.set(path, schemaOfDescriptor(operation.stream));
    }
  }
  const tables = new Map<string, CheckedTable>();
  for (const [name, table] of Object.entries(manifest.schema.tables)) {
    tables.set(name, {
      fields: table.fields,
      whole: schemaOfDescriptor(objectOf(table.fields)),
    });
  }
  const compiled: Compiled = {
    hash: schemaHash(manifest.schema),
    contracts: new Map(),
    args,
    returns,
    streams,
    tables,
  };
  compiledApps.set(manifest, compiled);
  return compiled;
};

const encoder = new TextEncoder();

/** The bytes of `value`'s JSON text, as UTF-8. */
const bytesOf = (value: Json): number =>
  encoder.encode(JSON.stringify(value)).byteLength;

/** Issues as an error's details say them: `path: message`, never a value. */
const issuesOf = (
  issues: readonly {
    readonly path?: readonly unknown[];
    readonly message: string;
  }[]
): string[] =>
  issues.map(({ path = [], message }) =>
    path.length === 0 ? message : `${path.map(String).join(".")}: ${message}`
  );

/**
 * Errors the host made or got from its own subsystems (the store, the
 * App's roles, the channel's capabilities): the only expected errors a
 * caller gets as they are (`payloadOf`). An error with an expected code
 * that App code made, or one its getters threw while the host read what
 * it returned, is never among them.
 */
const hostErrors = new WeakSet<object>();

/** `error`, branded as the host's. */
const hostError = <Failure extends Error>(error: Failure): Failure => {
  hostErrors.add(error);
  return error;
};

/** Brands an expected error the host raised to App code (the channel's). */
const trust = (error: Error): void => {
  hostErrors.add(error);
};

/**
 * Runs `work`, host code that touches no App value, branding the expected
 * errors it throws as the host's.
 */
const trusted = async <Answer>(
  work: () => Answer | Promise<Answer>
): Promise<Answer> => {
  try {
    return await work();
  } catch (error) {
    if (isExpectedError(error)) {
      hostErrors.add(error);
    }
    throw error;
  }
};

/**
 * The admission every protected step of a call runs, and the only one:
 * the call's start, each mutation's commit and each resource request all
 * call this, so what must hold before one of them (the release not
 * revoked, the caller's current roles, what admitted the caller) is the
 * invocation's `authorize` alone and can't differ between them. Its
 * refusal is the host's.
 */
const admit = async (invocation: Invocation): Promise<WriterRoles> =>
  await trusted(invocation.authorize);

/**
 * Runs `work`, which reads a value App code made: whatever it throws (a
 * getter's error among them) becomes an unexpected failure, logged.
 */
const fromApp = <Answer>(work: () => Answer): Answer => {
  try {
    return work();
  } catch (error) {
    log.error("operation.app_value_threw", errorFields(error));
    throw Object.assign(new Error("Unexpected failure"), { unexpected: true });
  }
};

/**
 * The function `reference` names in the App's public tree, of its kind:
 * refused the same way whether it is internal or doesn't exist.
 */
const publicOperation = (
  manifest: AppManifest,
  reference: OperationReference,
  streaming: boolean
): OperationManifest => {
  const { path, kind } = reference;
  const operation =
    typeof path === "string" && Object.hasOwn(manifest.operations, path)
      ? manifest.operations[path]
      : undefined;
  if (operation === undefined || operation.visibility !== "public") {
    throw operationErrors.create("operation.not_found");
  }
  if (operation.kind !== kind) {
    throw operationErrors.create("operation.kind_mismatch");
  }
  // A streaming action runs only where its progress has somewhere to go,
  // and any other only where it answers once (spec 10.7.6).
  if ((operation.stream !== null) !== streaming) {
    throw operationErrors.create("operation.mode_mismatch");
  }
  return operation;
};

/**
 * `args` as the function's `args` normalize them, read as JSON and bounded:
 * measured as they are read, so input past the limit costs no more than
 * the limit to refuse. The bytes a call carries over the wire, before any
 * of this, are bounded where calls enter core, as text, before they are
 * parsed (`callAppFunction`, app-functions.ts).
 */
const admittedArgs = (
  compiled: Compiled,
  operation: OperationManifest,
  args: unknown
): Json => {
  const read = jsonWithin(args, operationInputMaxBytes);
  if (read === "too_large") {
    throw operationErrors.create("contract.input_too_large", {
      maxBytes: operationInputMaxBytes,
    });
  }
  if (read === undefined) {
    throw operationErrors.create("contract.invalid_args", {
      issues: ["The arguments aren't JSON"],
    });
  }
  const schema = compiled.args.get(operation.path);
  const result = schema?.["~standard"].validate(read.json);
  if (result === undefined || result.issues !== undefined) {
    throw operationErrors.create("contract.invalid_args", {
      issues: issuesOf(result?.issues ?? []),
    });
  }
  const normalized = jsonOf(result.value);
  if (normalized === undefined) {
    throw new Error("A validated value isn't JSON");
  }
  return normalized;
};

/**
 * What a handler returned, if its contract allows it exactly: JSON within
 * the public operation output limit (`operationResultMaxBytes`), valid,
 * and already as the contract normalizes it (no default left out,
 * nothing to trim). The value is App code's: reading it can run
 * its getters, so anything reading it throws becomes `internal.unexpected`
 * (`fromApp`), never an error the caller would take for the host's.
 */
const checkedReturn = (
  compiled: Compiled,
  operation: OperationManifest,
  value: unknown
): Json => {
  const read = fromApp(() => jsonWithin(value, operationResultMaxBytes));
  if (read === "too_large") {
    throw hostError(
      operationErrors.create("contract.result_too_large", {
        maxBytes: operationResultMaxBytes,
      })
    );
  }
  if (read === undefined) {
    throw hostError(
      operationErrors.create("contract.invalid_return", {
        issues: ["The value isn't JSON"],
      })
    );
  }
  const { json } = read;
  const result = compiled.returns
    .get(operation.path)
    ?.["~standard"].validate(json);
  if (result === undefined || result.issues !== undefined) {
    throw hostError(
      operationErrors.create("contract.invalid_return", {
        issues: issuesOf(result?.issues ?? []),
      })
    );
  }
  const normalized = jsonOf(result.value);
  if (
    normalized === undefined ||
    canonicalJson(normalized) !== canonicalJson(json)
  ) {
    throw hostError(
      operationErrors.create("contract.invalid_return", {
        issues: ["The value isn't in the form its contract normalizes it to"],
      })
    );
  }
  return json;
};

/**
 * A progress snapshot a streaming action emitted, if its `stream`
 * descriptor allows it exactly, as `checkedReturn` reads a return: JSON
 * within `streamProgressMaxBytes`, valid, and already normalized. It
 * arrives over the channel as the channel's own JSON copy, so reading it
 * runs no App code. Refused as the expected error the channel raises to
 * App code, which `ctx.emit` rejects with.
 */
const checkedProgress = (
  compiled: Compiled,
  operation: OperationManifest,
  value: unknown
): Json => {
  const read = jsonWithin(value, streamProgressMaxBytes);
  if (read === "too_large") {
    throw operationErrors.create("contract.progress_too_large", {
      maxBytes: streamProgressMaxBytes,
    });
  }
  const json = read?.json;
  const result =
    json === undefined
      ? undefined
      : compiled.streams.get(operation.path)?.["~standard"].validate(json);
  if (result === undefined || result.issues !== undefined) {
    throw operationErrors.create("contract.invalid_progress", {
      issues: issuesOf(result?.issues ?? [{ message: "The value isn't JSON" }]),
    });
  }
  const normalized = jsonOf(result.value);
  if (
    json === undefined ||
    normalized === undefined ||
    canonicalJson(normalized) !== canonicalJson(json)
  ) {
    throw operationErrors.create("contract.invalid_progress", {
      issues: ["The value isn't in the form its schema normalizes it to"],
    });
  }
  return json;
};

/**
 * The receipt contract of `operation`: its path and a fingerprint of its
 * argument and return descriptors, which a compatible revision of the App
 * keeps, so a retry across such an upgrade gets the outcome it had (spec
 * 9.5: the receipt identity holds the contract ID and version, and host
 * contract IDs survive compatible revisions, 7.1).
 */
const contractIdOf = async (
  compiled: Compiled,
  operation: OperationManifest
): Promise<string> => {
  const known = compiled.contracts.get(operation.path);
  if (known !== undefined) {
    return await known;
  }
  const made = (async () => {
    const hash = await sha256Hex(
      canonicalJson(
        // Descriptors are JSON data, as the manifest holds them.
        jsonOf({ args: operation.args, returns: operation.returns }) ?? null
      )
    );
    return `${operation.path}@${hash.slice(0, 32)}`;
  })();
  compiled.contracts.set(operation.path, made);
  return await made;
};

/** Domain failures App code threw, as the host rebuilt them: code and details. */
const domainFailures = new WeakMap<
  object,
  { readonly code: string; readonly details: Json | undefined }
>();

/**
 * `error` as a run of App code may end with it: a failure the host
 * decided (its own branded errors, a rebuilt domain failure, an
 * unexpected one), or anything else, which nothing decided and so is
 * unexpected. What a run throws passes through this before any host code
 * that brands errors can see it.
 */
const sealed = (error: unknown): unknown => {
  if (
    typeof error === "object" &&
    error !== null &&
    (hostErrors.has(error) ||
      domainFailures.has(error) ||
      Object.hasOwn(error, "unexpected"))
  ) {
    return error;
  }
  log.error("operation.unsealed_failure", errorFields(error));
  return Object.assign(new Error("Unexpected failure"), { unexpected: true });
};

/** The SDK's own refusals of a query or write App code built wrongly. */
const sdkDefinitionCodes: ReadonlySet<unknown> = new Set([
  "query.unknown_table",
  "query.unknown_index",
  "query.invalid_range",
  "query.invalid_filter",
  "query.invalid_terminal",
]);

/** A property of something App code threw, read without trusting it. */
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

/**
 * What App code's failure `thrown` becomes, decided by the host (see the
 * header): a domain failure the host rebuilt from a valid `AppError`, an
 * expected error `open`'s channel raised, `contract.invalid_query` for
 * the SDK's own refusals, or `internal.unexpected`.
 */
const failureOf = (
  thrown: unknown,
  open: OpenChannel,
  requestId: string,
  path: string
): Error => {
  // Every read of what App code threw may run its getters: what they
  // throw is an unexpected failure, never taken for the host's.
  let failure: {
    code: unknown;
    message: unknown;
    name: unknown;
    details: unknown;
  };
  try {
    failure = {
      code: field(thrown, "code"),
      message: field(thrown, "message"),
      name: field(thrown, "name"),
      details: field(thrown, "details"),
    };
  } catch (error) {
    log.error("operation.failure_threw", {
      requestId,
      path,
      ...errorFields(error),
    });
    return Object.assign(new Error("Unexpected failure"), { unexpected: true });
  }
  const { code, message, name } = failure;
  if (name === "AppError" && isAppErrorCode(code) && !isPlatformCode(code)) {
    const details = fromApp(() =>
      failure.details === undefined
        ? undefined
        : appErrorDetailsOf(failure.details)
    );
    if (
      typeof message !== "string" ||
      message.length === 0 ||
      message.length > appErrorMessageMaxLength ||
      (failure.details !== undefined && details === undefined)
    ) {
      return hostError(
        operationErrors.create("contract.invalid_error", {
          maxMessageLength: appErrorMessageMaxLength,
          maxDetailsBytes: appErrorDetailsMaxBytes,
        })
      );
    }
    const domain = new Error(message);
    domainFailures.set(domain, { code, details });
    return domain;
  }
  if (typeof code === "string" && isPlatformCode(code)) {
    const raised = open.raised(code);
    if (raised !== undefined) {
      return hostError(raised);
    }
  }
  if (sdkDefinitionCodes.has(code)) {
    return hostError(operationErrors.create("contract.invalid_query"));
  }
  log.error("operation.failed", {
    requestId,
    path,
    code: typeof code === "string" ? code : undefined,
  });
  return Object.assign(new Error("Unexpected failure"), { unexpected: true });
};

/** The error each verdict of the sandbox's becomes for a function's caller. */
const sandboxCodes = {
  cpu: "operation.cpu_exceeded",
  memory: "operation.memory_exceeded",
  deadline: "operation.deadline_exceeded",
  refused: "operation.sandbox_refused",
  busy: "operation.sandbox_busy",
  call_limit: "operation.call_limit",
  ended: "operation.ended",
} as const;

const isSandboxVerdict = (
  verdict: string | undefined
): verdict is keyof typeof sandboxCodes =>
  verdict !== undefined && Object.hasOwn(sandboxCodes, verdict);

/**
 * What a function the on-prem sandbox ended fails with, or undefined for
 * any other failure: the App's (CPU time, memory, deadline, what its code
 * sent) or the platform's, to try again (its share of the sandbox in use,
 * the sandbox down). A crash stays `internal.unexpected`. Only what core
 * made: never a property App code may set on an error it throws.
 */
const sandboxFailureOf = (
  thrown: unknown,
  { requestId, path, depth }: { requestId: string; path: string; depth: number }
): Error | undefined => {
  if (thrown instanceof SandboxUnavailableError) {
    log.error("operation.sandbox_unavailable", {
      requestId,
      path,
      depth,
      ...errorFields(thrown),
    });
    // Only a call that surely never started ran nothing, to try again; one
    // that may have started is an unknown outcome, never to repeat blindly.
    return hostError(
      operationErrors.create(
        thrown.started
          ? "operation.sandbox_lost"
          : "operation.sandbox_unavailable"
      )
    );
  }
  const verdict = sandboxVerdictOf(thrown);
  if (!isSandboxVerdict(verdict)) {
    return undefined;
  }
  // Every function of the call running in the process logs its own: the
  // deepest of them was running when it was ended, its callers waiting.
  log.warn("operation.sandbox_ended", { requestId, path, depth, verdict });
  return hostError(operationErrors.create(sandboxCodes[verdict]));
};

/** A JSON object: `Array.isArray` doesn't narrow a readonly array type. */
type JsonObject = Readonly<Record<string, Json | undefined>>;

const isJsonObject = (json: Json | undefined): json is JsonObject =>
  typeof json === "object" && json !== null && !Array.isArray(json);

const isJsonArray = (json: Json | undefined): json is readonly Json[] =>
  Array.isArray(json);

/** The entries of JSON object `json` whose keys `keep` keeps. */
const entriesOf = (
  json: Readonly<Record<string, Json | undefined>>,
  keep: (key: string) => boolean = () => true
): Record<string, Json> =>
  Object.fromEntries(
    Object.entries(json).filter(
      (entry): entry is [string, Json] =>
        keep(entry[0]) && entry[1] !== undefined
    )
  );

/** The details of an expected error a caller may get: JSON, bounded, the host's only. */
const safeDetails = (details: unknown): Json | undefined => {
  const json = jsonOf(details);
  if (!isJsonObject(json)) {
    return undefined;
  }
  // The generations a read depended on are the host's own.
  const rest = entriesOf(json, (key) => key !== "generations");
  return bytesOf(rest) <= appErrorDetailsMaxBytes ? rest : undefined;
};

/** What a caller gets of `error`, in request `requestId`. */
const payloadOf = (
  error: unknown,
  requestId: string,
  path: string
): AppErrorPayload => {
  const domain = error instanceof Error ? domainFailures.get(error) : undefined;
  if (error instanceof Error && domain !== undefined) {
    const { code, details } = domain;
    return {
      code,
      message: error.message,
      category: "domain",
      retryable: false,
      requestId,
      ...(details === undefined ? {} : { details }),
    };
  }
  // Only an expected error the host made or got from its own subsystems
  // counts: one with a platform code from anywhere else is unexpected.
  // The opaque failure a channel raised carries its request ID in its
  // details; the payload has it at the top, as for any other.
  if (
    isExpectedError(error) &&
    hostErrors.has(error) &&
    error.code !== "internal.unexpected"
  ) {
    const details = safeDetails(error.details);
    return {
      code: error.code,
      message: error.message,
      category: categoryOf(error.code),
      retryable: isRetryableCode(error.code),
      requestId,
      ...(details === undefined ? {} : { details }),
    };
  }
  if (error instanceof Error && !Object.hasOwn(error, "unexpected")) {
    log.error("operation.failed", { requestId, path, ...errorFields(error) });
  }
  return {
    code: "internal.unexpected",
    message: "Something went wrong.",
    category: "operational",
    retryable: false,
    requestId,
  };
};

/** The App's verbs on `table` for `operation`; a table the schema hasn't is unknown. */
const verbsOf = (operation: OperationManifest, table: string) => {
  const verbs = Object.hasOwn(operation.tables, table)
    ? operation.tables[table]
    : undefined;
  if (verbs === undefined) {
    throw dataErrors.create("data.unknown_table", { table });
  }
  return verbs;
};

/** One read for `operation`, if it may read the table, through `reader`. */
const readFor = async (
  operation: OperationManifest,
  reader: StoreReader,
  request: unknown
): Promise<unknown> => {
  const read = dataErrors.parse(
    "data.invalid_query",
    readRequestSchema,
    request
  );
  const table = read.kind === "get" ? read.table : read.query.table;
  if (!verbsOf(operation, table).read) {
    throw dataErrors.create("data.access_denied", { table });
  }
  return await reader.read(read);
};

/**
 * A run's own copy of the admitted arguments: App code can change what it
 * is handed, and a run that comes again (a stale read set, a role change)
 * must get them as admitted, as their hash in the receipt says.
 */
const fresh = (args: Json): Json => structuredClone(args);

/** Settles `promise`, without throwing: what it answered or threw. */
const settle = async (
  promise: Promise<unknown>
): Promise<{ value: unknown } | { thrown: unknown }> => {
  try {
    return { value: await promise };
  } catch (error) {
    return { thrown: error };
  }
};

/** The writes a mutation stages, checked one at a time as App code stages them. */
interface Staging {
  /** When they were staged: the time the records they change are stamped with. */
  readonly stagedAt: number;
  /** The bytes of the writes staged so far, as UTF-8 JSON. */
  readonly bytes: () => number;
  readonly stage: (request: unknown) => Promise<unknown>;
  /**
   * The first write the host refused to stage, if any: App code may not
   * have waited for it, or may have caught it, but its change set lost a
   * write, so the mutation can't commit as though it hadn't.
   */
  readonly refused: () => Error | undefined;
  /**
   * Remembers a refused write: told by the channel, wherever the write
   * was refused (at its boundary, before staging, included).
   */
  readonly remember: (error: Error) => void;
  readonly preview: () => StagedWrites | undefined;
  readonly writes: () => StagedWrites["writes"];
}

/** A field's descriptor as a patch checks a value of it: present, no default. */
const presentField = (
  descriptor: ValueDescriptorLike
): Record<string, unknown> => {
  const kept = Object.entries(descriptor).filter(
    ([key]) => key !== "defaultValue" && key !== "presence"
  );
  return Object.fromEntries([...kept, ["presence", "required"]]);
};

/** `fields` as `schema` normalizes them, or `data.invalid` saying why not. */
const validFields = (
  schema: ValueSchema<unknown, unknown>,
  table: string,
  fields: unknown
): StoreFields => {
  const result = schema["~standard"].validate(fields);
  if (result.issues !== undefined) {
    throw dataErrors.create("data.invalid", {
      table,
      issues: issuesOf(result.issues),
    });
  }
  const json = jsonOf(result.value);
  if (!isJsonObject(json)) {
    throw new Error("Validated fields aren't an object");
  }
  return entriesOf(json);
};

/** The verb of each kind of write. */
const verbOf = {
  insert: "insert",
  patch: "update",
  replace: "update",
  delete: "delete",
} as const;

/** A new staging of a mutation's writes, at `stagedAt`. */
const stagingFor = (
  compiled: Compiled,
  operation: OperationManifest,
  stagedAt: number
): Staging => {
  const writes: StagedWrites["writes"] = [];
  let staged = 2;
  /**
   * Stages `write`, refused (`mutation.too_large`) when it would take the
   * staged writes past `stagedMaxBytes`, so what a mutation stages always
   * fits its commit, with its result.
   */
  const push = (write: StagedWrites["writes"][number]): void => {
    const bytes = bytesOf(write) + 1;
    if (staged + bytes > stagedMaxBytes) {
      throw operationErrors.create("mutation.too_large", {
        maxStagedBytes: stagedMaxBytes,
      });
    }
    staged += bytes;
    writes.push(write);
  };
  let refused: Error | undefined;
  const stage = async (request: unknown): Promise<unknown> => {
    const write = operationErrors.parse(
      "contract.invalid_write",
      writeRequestSchema,
      request
    );
    const verbs = verbsOf(operation, write.table);
    if (!verbs[verbOf[write.kind]]) {
      throw dataErrors.create("data.write_denied", { table: write.table });
    }
    if (writes.length >= commitMaxWrites) {
      throw dataErrors.create("data.invalid", {
        table: write.table,
        issues: [`A mutation stages at most ${commitMaxWrites} writes`],
      });
    }
    const table = compiled.tables.get(write.table);
    if (table === undefined) {
      throw dataErrors.create("data.unknown_table", { table: write.table });
    }
    if (write.kind === "insert") {
      const id = mintRecordId(stagedAt);
      push({
        op: "insert",
        table: write.table,
        id,
        fields: validFields(table.whole, write.table, write.fields),
      });
      return await Promise.resolve(id);
    }
    if (write.kind === "replace") {
      push({
        op: "replace",
        table: write.table,
        id: write.id,
        fields: validFields(table.whole, write.table, write.fields),
        expectedRevision: write.expectedRevision,
      });
      return null;
    }
    if (write.kind === "delete") {
      push({
        op: "delete",
        table: write.table,
        id: write.id,
        expectedRevision: write.expectedRevision,
      });
      return null;
    }
    const named: Record<string, unknown> = {};
    for (const name of Object.keys(write.fields)) {
      const descriptor = Object.hasOwn(table.fields, name)
        ? table.fields[name]
        : undefined;
      // An unknown field (a managed one included) is left out of the
      // object checked, which then refuses it as a key it doesn't have.
      if (descriptor !== undefined) {
        named[name] = presentField(descriptor);
      }
    }
    const fields = validFields(
      schemaOfDescriptor(objectOf(named)),
      write.table,
      write.fields
    );
    const unset = [...new Set(write.unset)];
    for (const name of write.unset) {
      const descriptor = Object.hasOwn(table.fields, name)
        ? table.fields[name]
        : undefined;
      if (
        descriptor?.presence !== "optional" ||
        Object.hasOwn(fields, name) ||
        unset.length !== write.unset.length
      ) {
        throw dataErrors.create("data.invalid", {
          table: write.table,
          issues: [
            `unset: Optional fields only, each once, none the patch also sets`,
          ],
        });
      }
    }
    push({
      op: "patch",
      table: write.table,
      id: write.id,
      fields,
      unset,
      expectedRevision: write.expectedRevision,
    });
    return null;
  };
  return {
    stagedAt,
    bytes: () => staged,
    stage,
    refused: () => refused,
    remember: (error: Error) => {
      refused ??= error;
    },
    preview: () =>
      writes.length === 0 ? undefined : { stagedAt, writes: [...writes] },
    writes: () => [...writes],
  };
};

/** What a resource's adapter is told of the request it serves. */
export interface ResourceContext {
  readonly requestId: string;
  /** When the call must end, in milliseconds since the epoch. */
  readonly deadline: number;
  /**
   * The request's own key, derived from the action's call key and its
   * place among the action's requests: the same each time the same call
   * is made again, so an idempotent provider contract never repeats an
   * effect, and never one App code chose.
   */
  readonly idempotencyKey: string;
  /**
   * On-prem, the sandbox session, by its call ID, the caller's function
   * runs in: a call the adapter makes of another App's function runs in a
   * child of it (a shared store's operation, resource-store.ts), never
   * waiting for a process the caller holds while it waits.
   */
  readonly session?: string;
}

/**
 * A resource as core bound it for an invocation: an approved resource of
 * the kind declared, the contract it serves, and its adapter, which
 * reaches the provider (connect, the model gateway, knowledge) and never
 * hands App code a key, token or unrestricted fetch.
 */
export interface BoundResource {
  readonly kind: ResourceKind;
  /** The contract a connector's or a template's binding serves; null otherwise. */
  readonly contract: string | null;
  readonly call: (
    method: string,
    args: readonly Json[],
    context: ResourceContext
  ) => Promise<unknown>;
}

/**
 * How core binds a declared resource for an invocation, under the App's
 * grants: the bound resource, or undefined when there is no approved
 * binding. A declaration alone grants nothing.
 */
export type ResourceBindings = (
  declaration: AnyResource
) => Promise<BoundResource | undefined>;

/** A knowledge search's request, as the declaration's client sends it. */
const knowledgeSearchSchema = z.strictObject({
  text: z.string().min(1).max(knowledgeSearchMaxLength),
  limit: z.number().int().min(1).max(20).optional(),
});

/** A knowledge read's request. */
const knowledgeReadSchema = z.strictObject({ id: z.string().min(1).max(256) });

/** A model request. */
const modelRequestSchema = z.strictObject({
  prompt: z.string().min(1).max(100_000),
  instructions: z.string().max(20_000).optional(),
});

/** Each knowledge operation's request. */
const knowledgeRequests = {
  search: knowledgeSearchSchema,
  read: knowledgeReadSchema,
} as const;

/** A request a resource's declaration doesn't allow. */
const notAllowed = () => operationErrors.create("resource.not_allowed");

/** An answer a resource's contract doesn't allow. */
const invalidResult = () =>
  operationErrors.create("contract.invalid_resource_result");

/** What a knowledge search answers: hits of exactly a title and an excerpt. */
const knowledgeHitsSchema = z
  .array(z.strictObject({ title: z.string(), excerpt: z.string() }))
  .max(20);

/** What a knowledge read answers. */
const knowledgeDocumentSchema = z.strictObject({
  title: z.string(),
  text: z.string(),
});

/**
 * Whether a statistics read of `query` reads one of the App's own measures,
 * or a platform measure `declaration` lists. Anything else it names, a
 * measure that isn't one or none, is left to the read's own check.
 */
const readsDeclaredMeasure = (
  declaration: Extract<AnyResource, { "~resource": "statistics" }>,
  query: JsonObject
): boolean => {
  const { measure } = query;
  return (
    typeof measure !== "string" ||
    !measure.startsWith("platform.") ||
    declaration.platform.some((declared) => declared === measure)
  );
};

/**
 * Whether `method` with `args` is one of the operations a statistics
 * `declaration` declares, with one object: a point, or a query of the
 * App's own measures or of a platform measure (any `platform.` one: an
 * App's own has no dot) it lists.
 */
const allowsStatistics = (
  declaration: Extract<AnyResource, { "~resource": "statistics" }>,
  method: unknown,
  args: readonly Json[]
): boolean => {
  const [first] = args;
  return (
    (method === "record" || method === "read") &&
    declaration.operations.some((operation) => operation === method) &&
    args.length === 1 &&
    isJsonObject(first) &&
    (method === "record" || readsDeclaredMeasure(declaration, first))
  );
};

/** What a statistics read answers, checked as the contract allows it. */
const statisticGroupSchema = z.strictObject({
  dimensions: z.record(z.string(), z.string().nullable()),
  count: z.number(),
  sum: z.number(),
  min: z.number(),
  max: z.number(),
});

const statisticAnswerSchema = z.strictObject({
  measure: z.string(),
  from: z.string(),
  to: z.string(),
  groups: z.array(statisticGroupSchema).max(statisticMaxGroups),
  truncated: z.boolean(),
  unavailable: z.array(z.string()).optional(),
  computation: z.string().nullable().optional(),
});

/**
 * Whether `method` with `args` is a `call` of one name `declares`, with an
 * object of arguments: a connector's action, a store's operation.
 */
const isNamedCall = (
  method: unknown,
  args: readonly Json[],
  declares: (name: string) => boolean
): boolean => {
  const [name, callArgs] = args;
  return (
    method === "call" &&
    args.length === 2 &&
    typeof name === "string" &&
    declares(name) &&
    isJsonObject(callArgs)
  );
};

/**
 * The request `method` with `args` makes of `declaration`, if the
 * declaration allows it: a connector one of its declared actions with an
 * object of arguments, knowledge one of its declared operations, a model
 * a prompt, a template a read. `resource.not_allowed` otherwise.
 */
const allowedRequest = (
  declaration: AnyResource,
  method: unknown,
  args: readonly Json[]
): void => {
  const [first] = args;
  const kind = declaration["~resource"];
  let allowed: boolean;
  if (declaration["~resource"] === "connector") {
    const { actions } = declaration;
    allowed = isNamedCall(method, args, (name) => actions.includes(name));
  } else if (declaration["~resource"] === "knowledge") {
    const schema =
      method === "search" || method === "read"
        ? knowledgeRequests[method]
        : undefined;
    allowed =
      schema !== undefined &&
      declaration.operations.some((operation) => operation === method) &&
      args.length === 1;
    // A declared operation asked with a request outside its contract (a
    // search text past Knowledge's limit, say): arguments that don't fit.
    if (allowed && schema?.safeParse(first).success !== true) {
      throw operationErrors.create("contract.invalid_args");
    }
  } else if (kind === "model") {
    allowed =
      method === "generate" &&
      args.length === 1 &&
      modelRequestSchema.safeParse(first).success;
  } else if (declaration["~resource"] === "store") {
    const { operations } = declaration;
    allowed = isNamedCall(method, args, (path) =>
      Object.hasOwn(operations, path)
    );
  } else if (declaration["~resource"] === "statistics") {
    allowed = allowsStatistics(declaration, method, args);
  } else {
    allowed = method === "read" && args.length === 0;
  }
  if (!allowed) {
    throw notAllowed();
  }
};

/** Whether `result` fits `descriptor` and is already in its normalized form. */
const isNormalized = (descriptor: unknown, result: Json): boolean => {
  const checked = schemaOfDescriptor(descriptor)["~standard"].validate(result);
  const normalized =
    checked.issues === undefined ? jsonOf(checked.value) : undefined;
  return (
    normalized !== undefined &&
    canonicalJson(normalized) === canonicalJson(result)
  );
};

/**
 * What a resource answered, if its contract allows it: a model's structured
 * output (or text), knowledge's hits or document, a template's pinned
 * version of the declared contract. A connector's answer is checked as JSON
 * here; its action's own descriptor comes with generated connector
 * contracts.
 */
const checkedResourceResult = (
  declaration: AnyResource,
  method: string,
  args: readonly Json[],
  result: Json
): Json => {
  let valid: boolean;
  if (declaration["~resource"] === "model") {
    const { structuredOutput } = declaration;
    valid =
      structuredOutput === null
        ? typeof result === "string"
        : isNormalized(structuredOutput, result);
  } else if (declaration["~resource"] === "store") {
    // The declared operation's return, already normalized, as the store's
    // own contract answered it (`allowedRequest` found the path).
    const [path] = args;
    const shape =
      typeof path === "string" && Object.hasOwn(declaration.operations, path)
        ? declaration.operations[path]
        : undefined;
    valid = shape !== undefined && isNormalized(shape.returns, result);
  } else if (declaration["~resource"] === "knowledge") {
    valid = (
      method === "search" ? knowledgeHitsSchema : knowledgeDocumentSchema
    ).safeParse(result).success;
  } else if (declaration["~resource"] === "statistics") {
    valid =
      method === "record"
        ? result === null
        : statisticAnswerSchema.safeParse(result).success;
  } else if (declaration["~resource"] === "template") {
    valid = z
      .strictObject({
        contract: z.literal(declaration.contract),
        version: z.number().int().min(1),
        content: z.json(),
      })
      .safeParse(result).success;
  } else {
    valid = true;
  }
  if (!valid) {
    throw invalidResult();
  }
  return result;
};

/**
 * What a provider's failure becomes, from an allow-list: an outcome the
 * provider couldn't confirm (`effect.outcome_unknown`, connect's
 * `connect.outcome_unknown` included) as that, kept so nobody repeats the
 * effect under a fresh key; a binding whose grant was revoked
 * (`permission.denied`) as `resource.unavailable`; a refusal a binding's
 * adapter made in the host's words (an unavailable resource, a budget used
 * up, an effect held for its person, an item it doesn't have, arguments or
 * an answer its contract doesn't allow) as that; anything else
 * `internal.unexpected`, its cause logged. Never the provider's own code,
 * message or details (a connection's ID, the provider's status).
 */
const busyDetailsSchema = z.object({
  retryAfterSeconds: z.int().positive().max(3600),
});

/** What a shared store operation's failure tells App code: the store's code. */
const storeFailureSchema = z.object({
  code: z.string().min(1).max(200),
});

/** What a busy budget's refusal tells App code: when to ask again, if known. */
const busyDetails = (
  details: unknown
): { retryAfterSeconds: number } | undefined =>
  busyDetailsSchema.safeParse(details).data;

/** A used-up budget's wait: until it resets, a month at most. */
const exhaustedDetailsSchema = z.object({
  retryAfterSeconds: z
    .int()
    .positive()
    .max(31 * 24 * 60 * 60),
});

/** Which bound of a resource's a request reached, and when to ask again. */
const limitDetailsSchema = z.strictObject({
  limit: z.enum(["call", "minute", "day"]),
  retryAfterSeconds: z.int().positive().max(60).optional(),
});

/** What a binding's adapter may refuse a request with, in the host's words. */
const adapterRefusals = [
  "resource.unavailable",
  "resource.not_allowed",
  "resource.awaiting_confirmation",
  "resource.item_not_found",
  "resource.invalid_args",
  "resource.declined",
  "resource.idempotency_conflict",
  "contract.invalid_resource_result",
] as const;

const isAdapterRefusal = (
  code: string | undefined
): code is (typeof adapterRefusals)[number] =>
  adapterRefusals.some((refusal) => refusal === code);

const providerFailure = (error: unknown, requestId: string): Error => {
  const code = isExpectedError(error) ? error.code : undefined;
  if (code === "effect.outcome_unknown" || code === "connect.outcome_unknown") {
    return hostError(effectErrors.create("effect.outcome_unknown"));
  }
  if (code === "permission.denied") {
    return hostError(operationErrors.create("resource.unavailable"));
  }
  // A workflow run's attempt let go of before the request left core
  // (`BindingCaller.requireHolds`): nothing was sent.
  if (code === "execution.stale_attempt") {
    return hostError(executionErrors.create("execution.stale_attempt"));
  }
  // What a binding's adapter, core's own code, says of a request it
  // refused or couldn't complete, each in the operation host's own words.
  if (isAdapterRefusal(code)) {
    return hostError(operationErrors.create(code));
  }
  // A shared store operation's own answer (store-operations.ts), or its
  // failing for now, worth trying again: its code alone, which its
  // contract gives every caller.
  if (code === "resource.operation_failed" || code === "resource.busy") {
    const details = storeFailureSchema.safeParse(
      isExpectedError(error) ? error.details : undefined
    );
    return hostError(
      operationErrors.create(
        code,
        details.success ? { code: details.data.code } : undefined
      )
    );
  }
  // A budget busy with requests under way, a full share of the requests in
  // flight, a provider's rate: worth trying again, after the wait the
  // gateway computed, the only detail passed on.
  if (
    code === "resource.budget_busy" ||
    code === "resource.queued" ||
    code === "resource.rate_limited"
  ) {
    return hostError(
      operationErrors.create(
        code,
        busyDetails(isExpectedError(error) ? error.details : undefined)
      )
    );
  }
  // A bound of the resource's reached: which one, and for a minute's, when
  // it starts again, the only details passed on.
  if (code === "resource.limit_reached") {
    return hostError(
      operationErrors.create(
        code,
        limitDetailsSchema.safeParse(
          isExpectedError(error) ? error.details : undefined
        ).data
      )
    );
  }
  // Used up: when it resets, if it does, the only detail passed on.
  if (code === "resource.budget_exhausted") {
    return hostError(
      operationErrors.create(
        code,
        exhaustedDetailsSchema.safeParse(
          isExpectedError(error) ? error.details : undefined
        ).data
      )
    );
  }
  log.error("operation.resource_failed", {
    requestId,
    code,
    ...errorFields(error),
  });
  return hostError(internalErrors.create("internal.unexpected", { requestId }));
};

/**
 * The most bytes of a resource's answer to one request, as UTF-8 JSON:
 * what a workflow step may carry, not a public operation's output. It
 * reaches App code, never the caller as it is: what the action returns is
 * held to the output limit (`checkedReturn`), so a larger answer must be
 * cut down or paginated first.
 */
const resourceResultMaxBytes = platformLimits.stepPayloadBytes;

/**
 * One request of a resource an action declared and uses, as `alias`
 * names it: only a use its declaration allows (`allowedRequest`), its
 * arguments JSON within the operation input limit, through the binding
 * core resolved for it, which must be of the declared kind and serve the
 * declared contract (`resource.unavailable` otherwise, and without a
 * binding). Its answer is checked against the contract before App code
 * gets it. A provider's own failure reaches App code only as an expected
 * error the adapter raised (`effect.outcome_unknown` among them), never
 * as its message.
 */
/**
 * Refuses, with `operation.cancelled`, once `run`'s call is cancelled:
 * checked just before an effect (a mutation's commit, a resource request)
 * so a cancel that lands first stops it for certain.
 */
const requireNotCancelled = (run: Run): void => {
  if (run.cancelled?.aborted === true) {
    throw hostError(operationErrors.create("operation.cancelled"));
  }
};

const resourceCall = async (
  run: Run,
  operation: OperationManifest,
  request: { alias: unknown; method: unknown; args: unknown },
  key: readonly string[]
): Promise<Json> => {
  const { alias, method } = request;
  const declared = operation.uses.some(
    (use) => use.type === "resource" && use.alias === alias
  );
  const declaration =
    declared &&
    typeof alias === "string" &&
    Object.hasOwn(run.app.manifest.resources, alias)
      ? run.app.manifest.resources[alias]
      : undefined;
  if (declaration === undefined || typeof method !== "string") {
    throw operationErrors.create("resource.not_allowed");
  }
  const args = jsonOf(request.args);
  if (args === undefined || !isJsonArray(args)) {
    throw operationErrors.create("resource.not_allowed");
  }
  if (bytesOf(args) > operationInputMaxBytes) {
    throw operationErrors.create("contract.input_too_large", {
      maxBytes: operationInputMaxBytes,
    });
  }
  allowedRequest(declaration, method, args);
  // The one gate (`admit`): the same admission a mutation's commit runs,
  // so a request is made only while the caller may still act.
  await admit(run.invocation);
  // Core's own resolution: what it refuses with is the host's.
  const bound = await trusted(
    async () => await run.invocation.resources?.(declaration)
  );
  const contract =
    declaration["~resource"] === "connector" ||
    declaration["~resource"] === "template"
      ? declaration.contract
      : null;
  if (
    bound === undefined ||
    bound.kind !== declaration["~resource"] ||
    bound.contract !== contract
  ) {
    throw operationErrors.create("resource.unavailable");
  }
  // Cancelled meanwhile: nothing is sent.
  requireNotCancelled(run);
  let answered: unknown;
  try {
    answered = await bound.call(method, args, {
      requestId: run.invocation.requestId,
      deadline: run.invocation.deadline,
      idempotencyKey: key.join(":"),
      ...(run.call.session === undefined ? {} : { session: run.call.session }),
    });
  } catch (error) {
    throw providerFailure(error, run.invocation.requestId);
  }
  const result = jsonOf(answered);
  if (result === undefined || bytesOf(result) > resourceResultMaxBytes) {
    throw operationErrors.create("contract.invalid_resource_result");
  }
  return checkedResourceResult(declaration, method, args, result);
};

/** What one run of a function may still read: its reads, and staged bytes sent. */
interface ReadBudget {
  reads: number;
  shipped: number;
}

/** A new run's read budget. */
const readBudget = (): ReadBudget => ({ reads: 0, shipped: 0 });

/**
 * Spends one read of `budget`, sending `staged` bytes of staged writes
 * with it: `operation.read_limit` past `invocationMaxReads` reads or
 * `stagedReadMaxBytes` sent, so one call can't make the store apply its
 * staged writes without end. The budget is the whole call's, its nested
 * functions' reads with the one it named (`runReads`): each invocation
 * alone is held to its host calls first (operation-channel.ts).
 */
const spendRead = (budget: ReadBudget, staged: number): void => {
  budget.reads += 1;
  budget.shipped += staged;
  if (
    budget.reads > invocationMaxReads ||
    budget.shipped > stagedReadMaxBytes
  ) {
    throw operationErrors.create("operation.read_limit", {
      maxReads: invocationMaxReads,
      maxStagedBytes: stagedReadMaxBytes,
    });
  }
};

/** Whether two role readings differ. */
const rolesDiffer = (one: WriterRoles, other: WriterRoles): boolean =>
  one.appMember !== other.appMember || one.appBuilder !== other.appBuilder;

/** The read scope of an invocation: core's, and the pinned schema's hash. */
const scopeOf = async (
  compiled: Compiled,
  invocation: Invocation,
  roles: WriterRoles
): Promise<ReadScope> => ({
  schemaHash: await compiled.hash,
  principal: invocation.principal,
  appMember: roles.appMember,
  appBuilder: roles.appBuilder,
  consumer: { ...invocation.consumer },
});

/**
 * How deep functions may call each other within one call: the caller's
 * own function and three nested in it, as calls between Apps
 * (`appCallLimits.depth`).
 */
export const callMaxDepth = appCallLimits.depth;

/** One function's run, and where it sits in the call it belongs to. */
interface Run {
  readonly app: HostedApp;
  readonly compiled: Compiled;
  readonly invocation: Invocation;
  /** How many functions it is nested in: 0 for the one the caller named. */
  readonly depth: number;
  /** What the whole call may still do, shared by every function in it. */
  readonly budget: CallBudget;
  /** The caller's call, as its runner knows it: the same at any depth. */
  readonly call: CallTree;
  /**
   * Aborted once the caller cancels its call (`CallOptions.cancelled`):
   * every run in the call stops as at its deadline.
   */
  readonly cancelled?: AbortSignal;
  /** Told of each effect the call makes (`CallOptions.onEffect`). */
  readonly onEffect?: () => void;
  /** Where its progress goes: only for the streaming action the caller named. */
  readonly progress?: ProgressSink;
}

/** The most resource requests one call may make, at any depth. */
export const callMaxResourceRequests = 32;

/**
 * What one call, with everything nested in it, may still do: its nested
 * calls, its resource requests, and one read budget (reads and staged
 * bytes sent) shared by every function it runs.
 */
interface CallBudget {
  nested: number;
  requests: number;
  /**
   * The current run's reads: each run of the call's own function (a
   * query run again for stale reads, a mutation's next attempt) starts a
   * fresh one, which everything nested in that run shares. The limits are
   * per run, as their names say; the bounded number of reruns bounds the
   * whole call.
   */
  reads: ReadBudget;
  /**
   * One budget for several calls, reads included, never renewed: a
   * paginated list's window, every page and every rerun of it
   * (`sharedBudget`, query-windows.ts).
   */
  readonly shared: boolean;
}

/** What several calls share, given as `CallOptions.budget`. */
export type SharedBudget = CallBudget;

/**
 * The read budget of a run of `run`'s function: a fresh one, shared by
 * what it calls, when it is the call's own function; the run it is nested
 * in's otherwise, so nested calls never multiply what one run reads.
 */
const runReads = (run: Run): ReadBudget => {
  if (run.depth === 0 && !run.budget.shared) {
    run.budget.reads = readBudget();
  }
  return run.budget.reads;
};

/** A new call's budget. */
const callBudget = (): CallBudget => ({
  nested: 0,
  requests: 0,
  reads: readBudget(),
  shared: false,
});

/**
 * A budget several calls share (`CallOptions.budget`): what they read,
 * nest and request together stays within what one call may.
 */
export const sharedBudget = (): SharedBudget => ({
  ...callBudget(),
  shared: true,
});

/** Spends one nested call, or one resource request, of `budget`. */
const spendCall = (budget: CallBudget, what: "nested" | "requests"): void => {
  budget[what] += 1;
  if (
    budget.nested > callMaxNested ||
    budget.requests > callMaxResourceRequests
  ) {
    throw operationErrors.create("operation.call_limit", {
      maxNested: callMaxNested,
      maxResourceRequests: callMaxResourceRequests,
    });
  }
};

/**
 * `capabilities`, each use tracked while it runs: once the handler has
 * settled (`settle`), a new use is refused (`operation.ended`), and
 * `settle` waits for those still running, at most until `deadline`
 * (past which the store refuses whatever they would commit). It answers
 * the failure of the first that was still running when the handler
 * settled and then failed: one the handler never waited for, so it could
 * neither handle it nor report it. One the handler waited for is its own
 * to have handled, and doesn't fail the run again. One stopped at the
 * deadline (`operation.deadline_exceeded`, nested calls sharing it) is
 * answered as unfinished, the handler's own failure.
 */
const trackedCalls = (
  capabilities: Capabilities,
  deadline: number
): {
  capabilities: Capabilities;
  settle: () => Promise<unknown>;
} => {
  let handlerSettled = false;
  const running = new Set<Promise<unknown>>();
  let unfinished: { error: unknown } | undefined;
  let pastDeadline = false;
  const track = <Args extends unknown[]>(
    use: ((...args: Args) => Promise<unknown>) | undefined
  ) =>
    use === undefined
      ? undefined
      : async (...args: Args): Promise<unknown> => {
          if (handlerSettled) {
            throw operationErrors.create("operation.ended");
          }
          const call = use(...args);
          const watched = (async () => {
            try {
              await call;
            } catch (error) {
              if (!handlerSettled) {
                return;
              }
              // Left running and stopped at the deadline: the handler's
              // own failure is that it left the call unfinished, as when
              // the wait for it runs out (the host's error, never one to
              // read as App code's).
              if (
                operationErrors.codeOf(error) === "operation.deadline_exceeded"
              ) {
                pastDeadline = true;
              } else {
                unfinished ??= { error };
              }
            }
          })();
          running.add(watched);
          try {
            return await call;
          } finally {
            running.delete(watched);
          }
        };
  return {
    capabilities: {
      read: track(capabilities.read),
      write: track(capabilities.write),
      call: track(capabilities.call),
      resource: track(capabilities.resource),
      emit: track(capabilities.emit),
    },
    settle: async () => {
      handlerSettled = true;
      while (running.size > 0) {
        const left = deadline - Date.now();
        if (left <= 0) {
          throw hostError(operationErrors.create("operation.unfinished_call"));
        }
        // The timer is cleared once the calls settle first, so no wait is
        // left pending past the run.
        const timer = new AbortController();
        // oxlint-disable-next-line no-await-in-loop -- until none is left
        await Promise.race([
          Promise.allSettled(running),
          scheduler.wait(left, { signal: timer.signal }).catch(() => null),
        ]);
        timer.abort();
      }
      if (pastDeadline) {
        throw hostError(operationErrors.create("operation.unfinished_call"));
      }
      return unfinished?.error;
    },
  };
};

/**
 * `work`, or "expired" once `deadline` (ms since the epoch) passes first:
 * the sandbox limits CPU, not time, so a handler awaiting a long timer
 * would otherwise hold its call and channel open. Nested calls share their
 * caller's invocation, so they run to the same deadline. It stops waiting,
 * not the isolate: a busy loop runs on until the runtime's CPU limit ends
 * it, which plain workerd (on-prem) doesn't enforce (sandbox.ts, GRA-449).
 */
const untilDeadline = async <Answer>(
  work: Promise<Answer>,
  at: number,
  cancelled?: AbortSignal
): Promise<Answer | "expired" | "cancelled"> => {
  const limit = timeLimit(Math.max(0, at - Date.now()));
  try {
    return await Promise.race([
      work,
      whenAborted(limit.signal).catch(() => "expired" as const),
      ...(cancelled === undefined
        ? []
        : [whenAborted(cancelled).catch(() => "cancelled" as const)]),
    ]);
  } finally {
    limit.clear();
  }
};

/** `work`'s value, or "cancelled" once `cancelled` aborts first. */
const untilCancelled = async <Answer>(
  work: Promise<Answer>,
  cancelled: AbortSignal | undefined
): Promise<{ readonly value: Answer } | "cancelled"> => {
  // Never rejecting: a failure that comes after the cancel won is dropped,
  // not left unhandled.
  const settled = (async () => {
    try {
      return { value: await work };
    } catch (error) {
      return { error };
    }
  })();
  const first = await Promise.race([
    settled,
    ...(cancelled === undefined
      ? []
      : [whenAborted(cancelled).catch(() => "cancelled" as const)]),
  ]);
  if (first === "cancelled") {
    return first;
  }
  if ("error" in first) {
    throw first.error;
  }
  return first;
};

/** Thrown by a run whose failure came from stale reads: run it again. */
const staleRun = new Error("A run's reads went stale");

/** The capabilities one handler's channel gets, besides its refusals. */
interface Capabilities {
  /** Told of every refused or failed use, as the channel's `refused`. */
  readonly onRefused?: (
    name: "read" | "write" | "call" | "resource" | "emit",
    error: Error
  ) => void;
  readonly read?: (request: unknown) => Promise<unknown>;
  readonly write?: (request: unknown) => Promise<unknown>;
  readonly call?: (
    kind: unknown,
    path: unknown,
    args: unknown
  ) => Promise<unknown>;
  readonly resource?: (
    alias: unknown,
    method: unknown,
    args: unknown
  ) => Promise<unknown>;
  readonly emit?: (progress: unknown) => Promise<unknown>;
  /**
   * Whether an effect it started (a mutation or action it called, a
   * resource request) is still under way: a cancel that lands then can't
   * say what happened (`operation.outcome_unknown`).
   */
  readonly effectsInFlight?: () => boolean;
}

/** Why each kind's channel refuses what it hasn't. */
const refusalsOf = {
  query: {
    write: "operation.read_only",
    call: "operation.read_only",
    resource: "operation.no_resources",
    emit: "operation.no_stream",
  },
  mutation: { resource: "operation.no_resources", emit: "operation.no_stream" },
  action: {
    read: "operation.no_database",
    write: "operation.no_database",
    emit: "operation.no_stream",
  },
} as const;

/**
 * Why a run stopped early: its deadline, or a cancel. A cancel that lands
 * while an effect it started is still under way (a mutation committing, a
 * request out) can't say whether that effect happened: uncertain, never
 * a definite `operation.cancelled` that would invite running it again.
 */
const stoppedCode = (
  outcome: "expired" | "cancelled",
  capabilities: Capabilities
):
  | "operation.deadline_exceeded"
  | "operation.cancelled"
  | "operation.outcome_unknown" => {
  if (outcome === "expired") {
    return "operation.deadline_exceeded";
  }
  return capabilities.effectsInFlight?.() === true
    ? "operation.outcome_unknown"
    : "operation.cancelled";
};

/** How long a run stopped at its deadline gets to let go of what it held. */
const letGoMs = 1000;

/**
 * Waits, a little, for a run stopped at its deadline to let go of what it
 * holds (an on-prem sandbox process, which its runner frees when the run's
 * signal aborts): past the answer, the request that frees it may itself be
 * cancelled.
 */
const letGo = async (ran: Promise<unknown>): Promise<void> => {
  await Promise.race([ran, scheduler.wait(letGoMs)]);
};

/**
 * Runs `operation`'s handler with `args` over a channel of `capabilities`,
 * ended once it settles, and answers its checked return; a failure as the
 * host decides it (`failureOf`). `stale` says, for a failure, whether the
 * run's reads went stale, which makes it a run to repeat rather than a
 * failure: thrown as `Stale`.
 */
const runHandler = async (
  run: Run,
  operation: OperationManifest,
  args: Json,
  capabilities: Capabilities,
  stale?: () => Promise<boolean>
): Promise<Json> => {
  const calls = trackedCalls(capabilities, run.invocation.deadline);
  const open = openChannel({
    requestId: run.invocation.requestId,
    path: operation.path,
    ...calls.capabilities,
    trust,
    ...(capabilities.onRefused === undefined
      ? {}
      : { refused: capabilities.onRefused }),
    refusals: refusalsOf[operation.kind],
  });
  const stopped = new AbortController();
  const ran = settle(
    run.app.run(operation.path, fresh(args), open.channel, stopped.signal, {
      tree: run.call,
      nested: run.depth > 0,
    })
  );
  let expired = false;
  try {
    const outcome = await untilDeadline(
      ran,
      run.invocation.deadline,
      run.cancelled
    );
    if (outcome === "expired" || outcome === "cancelled") {
      expired = true;
      // Stopped at its deadline, or cancelled: its channel ends as this
      // returns (the `finally` below), so nothing it still does reaches
      // the store, and what it staged never commits.
      throw hostError(
        operationErrors.create(stoppedCode(outcome, capabilities))
      );
    }
    // What it started and didn't wait for still runs: the run ends once
    // that has settled, and fails with what failed of it. A cancel stops
    // that wait too, saying what is known of what still ran.
    const left = await untilCancelled(calls.settle(), run.cancelled);
    if (left === "cancelled") {
      expired = true;
      throw hostError(
        operationErrors.create(stoppedCode("cancelled", capabilities))
      );
    }
    const unfinished = left.value;
    if ("thrown" in outcome) {
      if (stale !== undefined && (await stale())) {
        throw staleRun;
      }
      const sandboxed = sandboxFailureOf(outcome.thrown, {
        requestId: run.invocation.requestId,
        path: operation.path,
        depth: run.depth,
      });
      if (sandboxed !== undefined) {
        throw sandboxed;
      }
      throw failureOf(
        outcome.thrown,
        open,
        run.invocation.requestId,
        operation.path
      );
    }
    if (unfinished !== undefined) {
      // A call it left running may have failed on reads a commit made
      // stale, as its handler may: then it is a run to repeat too.
      if (stale !== undefined && (await stale())) {
        throw staleRun;
      }
      throw failureOf(
        unfinished,
        open,
        run.invocation.requestId,
        operation.path
      );
    }
    return checkedReturn(run.compiled, operation, outcome.value);
  } catch (error) {
    if (error === staleRun) {
      throw error;
    }
    throw sealed(error);
  } finally {
    // Past its deadline or done, the run is over: what still runs of it
    // ends with its channel.
    stopped.abort();
    open.end();
    if (expired) {
      await letGo(ran);
    }
    // Its session, on-prem, which the function its caller named opened and
    // which went on after it answered: it ends now, as the run is over, and
    // is waited for a little, so it asks the supervisor to free its process
    // while this request still can.
    if (run.depth === 0) {
      await run.call.sessionEnded(letGoMs);
    }
  }
};

/**
 * A query a mutation runs: its handler over the mutation's own reader, so
 * it sees the staged writes and its reads count in the mutation's guards
 * and read set, each read narrowed to what both functions may read.
 */
const stagedQuery = async (
  run: Run,
  caller: OperationManifest,
  callee: OperationManifest,
  args: Json,
  reader: StoreReader,
  spend: () => void
): Promise<Json> => {
  // A mutation runs queries only (inspection and `nestedCall` see to it):
  // checked again here, where anything else would see its staged state.
  if (callee.kind !== "query") {
    throw operationErrors.create("operation.kind_mismatch");
  }
  const narrowed: OperationManifest = {
    ...callee,
    tables: Object.fromEntries(
      Object.entries(callee.tables).map(([table, verbs]) => [
        table,
        {
          ...verbs,
          read: verbs.read && (caller.tables[table]?.read ?? false),
        },
      ])
    ),
  };
  return await runHandler(run, narrowed, args, {
    read: async (request) => {
      spend();
      return await readFor(narrowed, reader, request);
    },
  });
};

/**
 * What a failure becomes for App code that called the failing function:
 * a domain failure the `AppError` it was (App code may handle it or throw
 * it on), an expected platform error as it is, anything else
 * `internal.unexpected`, its cause logged already.
 */
const forCaller = (error: unknown, requestId: string): Error => {
  const domain = error instanceof Error ? domainFailures.get(error) : undefined;
  if (error instanceof Error && domain !== undefined) {
    // A fresh `AppError` each time, of the SDK's own class (what App code
    // catches with `instanceof` when it runs in this isolate; across one,
    // the SDK's runner rebuilds it): nothing the host keeps, so nothing
    // App code does to it reaches a caller.
    // SAFETY: details a domain failure carries are JSON, as
    // `appErrorDetailsOf` copied them.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const details = structuredClone(domain.details) as JsonValue | undefined;
    return new AppError(domain.code, error.message, details);
  }
  if (isExpectedError(error) && hostErrors.has(error)) {
    return error;
  }
  const opaque = internalErrors.create("internal.unexpected", { requestId });
  opaque.stack = undefined;
  return opaque;
};

/**
 * Runs the function at `path` that `operation` calls with `args`, as
 * `kind` (`runQuery`, `runMutation`, `runAction`): only one it lists in
 * its `uses`, of that kind, within the call's depth, under the call's
 * principal and the callee's own access. A mutation's query runs in the
 * mutation's staged state, its reads through `reader`, narrowed to what
 * both may read; an action's calls are invocations of their own, each
 * authorized again and each mutation committed on its own under a
 * receipt derived from the action's key (`derived`).
 */
const startNested = async (
  run: Run,
  operation: OperationManifest,
  request: { kind: unknown; path: unknown; args: unknown },
  within:
    | {
        readonly type: "mutation";
        readonly reader: StoreReader;
        /** Spends one of the mutation's reads (`spendRead`). */
        readonly spend: () => void;
      }
    | {
        readonly type: "action";
        readonly derived: () => Promise<readonly string[]>;
      }
): Promise<Json> => {
  const { kind, path, args } = request;
  const used = operation.uses.find(
    (use) => use.type === "function" && use.path === path
  );
  const callee =
    used !== undefined && typeof path === "string"
      ? run.app.manifest.operations[path]
      : undefined;
  if (callee === undefined) {
    throw operationErrors.create("operation.not_found");
  }
  if (callee.kind !== kind) {
    throw operationErrors.create("operation.kind_mismatch");
  }
  if (run.depth + 1 > callMaxDepth) {
    throw operationErrors.create("operation.depth_exceeded", {
      maxDepth: callMaxDepth,
    });
  }
  // A streaming action runs only for a screen following it (spec 10.7.6):
  // nested, its progress would have no one to go to.
  if (callee.stream !== null) {
    throw operationErrors.create("operation.mode_mismatch");
  }
  spendCall(run.budget, "nested");
  const admitted = admittedArgs(run.compiled, callee, args);
  // Cancelled with the call, but never emitting: its progress would be
  // another function's to send.
  const { progress: _progress, ...inherited } = run;
  const nested: Run = { ...inherited, depth: run.depth + 1 };
  try {
    if (within.type === "mutation") {
      return await stagedQuery(
        nested,
        operation,
        callee,
        admitted,
        within.reader,
        within.spend
      );
    }
    // oxlint-disable-next-line no-use-before-define -- an action's calls run functions of every kind, actions among them
    return await execute(
      nested,
      callee,
      admitted,
      // A query needs no key: only what changes something holds a place.
      callee.kind === "query" ? [] : await within.derived()
    );
  } catch (error) {
    throw forCaller(error, run.invocation.requestId);
  }
};

/**
 * A function nested in `run`'s, started: counted by the call it runs in
 * from now (`CallTree`), so a session that call's functions share stays
 * open for it while it's still authorized or claimed.
 */
const nestedCall = async (
  ...args: Parameters<typeof startNested>
): Promise<Json> => {
  const work = startNested(...args);
  args[0].call.track(work);
  return await work;
};

/** Runs a query: its reads one state of the store (`readConsistently`). */
const runQuery = async (
  run: Run,
  operation: OperationManifest,
  args: Json
): Promise<Json> => {
  const { invocation, compiled } = run;
  const scope = await trusted(
    async () => await scopeOf(compiled, invocation, await admit(invocation))
  );
  return await trusted(
    async () =>
      await readConsistently(
        invocation.store,
        scope,
        async (reader) => {
          const budget = runReads(run);
          return await runHandler(run, operation, args, {
            read: async (request) => {
              spendRead(budget, 0);
              return await readFor(operation, reader, request);
            },
          });
        },
        run.depth === 0 ? invocation.observeReads : undefined
      )
  );
};

/**
 * Runs a mutation under its receipt (`key`): claimed first (a submission
 * that committed already answers its outcome), run, its return checked,
 * the caller authorized again, then committed with its guards and read
 * set; run again when a commit finds its reads stale.
 */
const runMutation = async (
  run: Run,
  operation: OperationManifest,
  args: Json,
  key: readonly string[]
): Promise<Json> => {
  const { invocation, compiled } = run;
  const { store } = invocation;
  let roles = await admit(invocation);
  const claimed = await trusted(
    async () =>
      await store.claim({
        scope: {
          principal: invocation.principal,
          resource: invocation.consumer.resourceId,
          binding: null,
          // The contract, not the App's version: a retry across an upgrade
          // that kept the function's contract gets the outcome it had.
          contractId: await contractIdOf(compiled, operation),
          contractVersion: 1,
          operationKind: "mutation",
        },
        key: [...key],
        inputHash: await sha256Hex(canonicalJson(args)),
        runId: invocation.runId,
        deadline: invocation.deadline,
      })
  );
  if ("outcome" in claimed) {
    return claimed.outcome.result;
  }
  for (let attempt = 0; attempt <= queryMaxReruns; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one run after the other
    const scope = await scopeOf(compiled, invocation, roles);
    const staging = stagingFor(compiled, operation, Date.now());
    const reader = new StoreReader(store, scope, staging.preview);
    const budget = runReads(run);
    const spend = () => {
      spendRead(budget, staging.bytes());
    };
    let value: Json;
    try {
      // One run after the other: a rerun exists only because the last
      // one's reads went stale.
      // oxlint-disable-next-line no-await-in-loop -- see above
      value = await runHandler(
        run,
        operation,
        args,
        {
          read: async (request) => {
            spend();
            return await readFor(operation, reader, request);
          },
          write: staging.stage,
          // Any write refused, at the channel's boundary or in staging,
          // fails the mutation (`refused`); calls and resources stay
          // catchable.
          onRefused: (name, error) => {
            if (name === "write") {
              staging.remember(error);
            }
          },
          call: async (kind, path, callArgs) =>
            await nestedCall(
              run,
              operation,
              { kind, path, args: callArgs },
              { type: "mutation", reader, spend }
            ),
        },
        // A failure torn reads may have caused is a stale run too.
        async () => !(await trusted(async () => await reader.isCurrent()))
      );
    } catch (error) {
      if (error === staleRun) {
        continue;
      }
      throw error;
    }
    const refusedWrite = staging.refused();
    if (refusedWrite !== undefined) {
      throw sealed(hostError(refusedWrite));
    }
    // The gate, then the commit: a revocation, a membership ended or a
    // grant made between the two (an admin granting for a later version,
    // which leaves this one unapproved, `requireApprovedVersion`) doesn't
    // stop this commit; the next protected step is refused. It can't be
    // atomic with it: what the gate reads lives in core's D1 and the write
    // in the store's own Durable Object, with no transaction across the
    // two. The window is bounded to a call already admitted (accepted on
    // GRA-500, as the store's on GRA-506, store-operations.ts).
    // oxlint-disable-next-line no-await-in-loop -- see above
    const current = await admit(invocation);
    // Its reads were scoped for roles the caller no longer has: run again
    // under the roles they have, so nothing read under the old ones is
    // committed or kept with the receipt.
    if (rolesDiffer(current, roles)) {
      roles = current;
      continue;
    }
    // Cancelled meanwhile: nothing it staged commits.
    requireNotCancelled(run);
    try {
      // oxlint-disable-next-line no-await-in-loop -- see above
      const committed = await trusted(
        async () =>
          await store.commit({
            principal: { userId: invocation.principal },
            roles: current,
            schemaHash: scope.schemaHash,
            receipt: claimed.held,
            stagedAt: staging.stagedAt,
            guards: [...reader.guards()],
            readSet: reader.readSet(),
            writes: staging.writes(),
            result: value,
            ...(invocation.writer === undefined
              ? {}
              : { writer: { ...invocation.writer } }),
          })
      );
      return committed.result;
    } catch (error) {
      if (dataErrors.codeOf(error) !== "data.reads_changed") {
        throw error;
      }
    }
  }
  throw hostError(
    operationErrors.create("mutation.concurrent_change", { retryable: true })
  );
};

/**
 * A streaming action's `emit` (`ctx.emit`): the snapshot checked
 * (`checkedProgress`) and handed to `sink`, unless the call is cancelled
 * or has emitted `streamMaxEmits` already. It waits for nothing: the sink
 * keeps the latest snapshot only, so an action emitting faster than its
 * screen reads costs it nothing more than that one snapshot.
 */
const emitProgress = async (
  compiled: Compiled,
  operation: OperationManifest,
  sink: ProgressSink,
  {
    emitted,
    progress,
    cancelled,
  }: { emitted: number; progress: unknown; cancelled?: AbortSignal }
): Promise<null> => {
  await Promise.resolve();
  if (cancelled?.aborted === true) {
    throw operationErrors.create("operation.cancelled");
  }
  if (emitted > streamMaxEmits) {
    throw operationErrors.create("operation.emit_limit", {
      maxEmits: streamMaxEmits,
    });
  }
  sink.publish(checkedProgress(compiled, operation, progress));
  return null;
};

/**
 * Runs an action: authorized as the call starts, with no database, its
 * calls of the App's functions each an invocation of its own and its
 * resources each one call of the binding core resolved (`resourceCall`).
 * Not one transaction, and never retried whole: a mutation it ran stays
 * committed whatever it does next. `key` is the call's own key, which
 * each mutation it runs, and each resource request it makes, derives its
 * own from by order, so the same call made again under the same key
 * answers what those already did rather than doing it twice.
 */
const runAction = async (
  run: Run,
  operation: OperationManifest,
  args: Json,
  key: readonly string[]
): Promise<Json> => {
  const { invocation, compiled, progress: sink } = run;
  await admit(invocation);
  // What every key this action derives is bound to: who calls it, through
  // which App, which action's contract with which input, under the call's
  // key. Two callers, Apps, actions or inputs with one key never share a
  // derived key, and the same call made again derives the same ones.
  const scope = await sha256Hex(
    canonicalJson({
      principal: invocation.principal,
      resource: invocation.consumer.resourceId,
      contract: await contractIdOf(compiled, operation),
      inputHash: await sha256Hex(canonicalJson(args)),
      key: [...key],
    })
  );
  // Places count only what changes something (mutations and actions it
  // calls, resource requests), so a query that runs or not, as the data
  // has it, moves no later place.
  let changes = 0;
  let requests = 0;
  let emitted = 0;
  // Effects under way: mutations and actions it called, resource requests.
  let inFlight = 0;
  const effect = async <Answer>(
    work: () => Promise<Answer>
  ): Promise<Answer> => {
    inFlight += 1;
    try {
      const answer = await work();
      run.onEffect?.();
      return answer;
    } catch (error) {
      // Refused before it was sent, for a budget busy with requests under
      // way: nothing went out. Anything else may have.
      if (operationErrors.codeOf(error) !== "resource.budget_busy") {
        run.onEffect?.();
      }
      throw error;
    } finally {
      inFlight -= 1;
    }
  };
  const derived = async (
    what: "call" | "resource",
    count: number
  ): Promise<readonly string[]> => [
    "derived",
    await sha256Hex(canonicalJson([scope, what, count])),
  ];
  const callNested = async (
    kind: unknown,
    path: unknown,
    callArgs: unknown
  ): Promise<Json> =>
    await nestedCall(
      run,
      operation,
      { kind, path, args: callArgs },
      {
        type: "action",
        derived: async () => {
          changes += 1;
          return await derived("call", changes);
        },
      }
    );
  return await runHandler(run, operation, args, {
    // A query changes nothing: only what may is an effect under way.
    call: async (kind, path, callArgs) =>
      kind === "query"
        ? await callNested(kind, path, callArgs)
        : await effect(async () => await callNested(kind, path, callArgs)),
    resource: async (alias, method, callArgs) => {
      spendCall(run.budget, "requests");
      requests += 1;
      const resourceKey = await derived("resource", requests);
      return await effect(
        async () =>
          await resourceCall(
            run,
            operation,
            { alias, method, args: callArgs },
            resourceKey
          )
      );
    },
    effectsInFlight: () => inFlight > 0,
    ...(sink === undefined
      ? {}
      : {
          emit: async (progress) => {
            emitted += 1;
            return await emitProgress(compiled, operation, sink, {
              emitted,
              progress,
              ...(run.cancelled === undefined
                ? {}
                : { cancelled: run.cancelled }),
            });
          },
        }),
  });
};

/** Runs `operation` with `args`, by its kind, under the call key `key`. */
const execute = async (
  run: Run,
  operation: OperationManifest,
  args: Json,
  key: readonly string[]
): Promise<Json> => {
  if (operation.kind === "query") {
    return await runQuery(run, operation, args);
  }
  if (operation.kind === "mutation") {
    return await runMutation(run, operation, args, key);
  }
  return await runAction(run, operation, args, key);
};

/**
 * The latest deadline a call may have: a server invocation's wall time
 * (spec 18.1) from now. A caller may give less (a screen's call, an
 * agent's, a step's attempt), never more: a later deadline is held to it.
 */
const invocationDeadline = (asked: number): number => {
  const latest = Date.now() + platformLimits.serverInvocationWallMs;
  // Not a time at all (NaN, or no end): the latest a call may have.
  return Number.isFinite(asked) ? Math.min(asked, latest) : latest;
};

/**
 * Calls the public function `reference` names of `app` for `invocation`,
 * with `args`: what it returned, or why it failed, as its caller may see
 * it (see the header). Never throws.
 */
export const callOperation = async (
  app: HostedApp,
  asked: Invocation,
  reference: OperationReference,
  args: unknown,
  options: CallOptions = {}
): Promise<OperationResult> => {
  const path = typeof reference.path === "string" ? reference.path : "";
  const invocation: Invocation = {
    ...asked,
    deadline: invocationDeadline(asked.deadline),
  };
  try {
    const { compiled, operation, admitted, key } = await trusted(() => {
      const known = compiledOf(app.manifest);
      const found = publicOperation(
        app.manifest,
        reference,
        options.progress !== undefined
      );
      return {
        compiled: known,
        operation: found,
        admitted: admittedArgs(known, found, args),
        key:
          options.idempotencyKey === undefined
            ? crypto.randomUUID()
            : submissionErrors.parse(
                "submission.key_invalid",
                idempotencyKeySchema,
                options.idempotencyKey
              ),
      };
    });
    const { progress, cancelled } = options;
    if (cancelled?.aborted === true) {
      throw hostError(operationErrors.create("operation.cancelled"));
    }
    const value = await execute(
      {
        app,
        compiled,
        invocation,
        depth: 0,
        budget: options.budget ?? callBudget(),
        call: new CallTree(options.parentSession),
        ...(progress === undefined ? {} : { progress }),
        ...(cancelled === undefined ? {} : { cancelled }),
        ...(options.onEffect === undefined
          ? {}
          : { onEffect: options.onEffect }),
      },
      operation,
      admitted,
      ["call", key]
    );
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: payloadOf(error, invocation.requestId, path) };
  }
};
