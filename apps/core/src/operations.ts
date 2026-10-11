import type { ValueSchema } from "@grasp-os/sdk";
import {
  schemaFromDescriptor,
  schemaHash,
  appErrorDetailsOf,
} from "@grasp-os/sdk/host";
import type { AppManifest, OperationManifest } from "@grasp-os/sdk/host";
import type { OperationChannel } from "@grasp-os/sdk/runner";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  appErrorDetailsMaxBytes,
  appErrorMessageMaxLength,
  isAppErrorCode,
  operationInputMaxBytes,
  operationResultMaxBytes,
} from "@grasp-os/shared/operation-limits";
import {
  categoryOf,
  isPlatformCode,
  isRetryableCode,
  jsonOf,
  operationErrors,
} from "@grasp-os/shared/operations";
import type {
  AppErrorPayload,
  OperationResult,
} from "@grasp-os/shared/operations";
import { mintRecordId } from "@grasp-os/shared/record-ids";
import {
  readRequestSchema,
  writeRequestSchema,
} from "@grasp-os/shared/store-queries";
import type { ReadScope } from "@grasp-os/shared/store-queries";
import { commitMaxWrites, dataErrors } from "@grasp-os/shared/stores";
import type {
  StagedWrites,
  StoreFields,
  WriterRoles,
} from "@grasp-os/shared/stores";
import {
  idempotencyKeySchema,
  submissionErrors,
} from "@grasp-os/shared/submissions";

import type { OpenStore } from "./data-stores.ts";
import { openChannel } from "./operation-channel.ts";
import type { OpenChannel } from "./operation-channel.ts";
import {
  queryMaxReruns,
  readConsistently,
  StoreReader,
} from "./store-reader.ts";

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
//   App code sends (operation-channel.ts), and actions don't run in this
//   release's host at all yet.
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
   * The caller's roles in the App, read again on each call; throws when
   * they may no longer use it. Called as the call starts and again just
   * before a mutation commits.
   */
  readonly authorize: () => Promise<WriterRoles>;
}

/**
 * Runs a registered function's handler over a channel: the SDK's
 * `runFunction` with the App's registration, wherever its code runs.
 */
export type Runner = (
  path: string,
  args: Json,
  channel: OperationChannel
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

/** What a caller may pass along with a call. */
export interface CallOptions {
  /** A mutation's submission key: one per logical submission, reused by retries. */
  readonly idempotencyKey?: string;
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
  readonly args: ReadonlyMap<string, ValueSchema<unknown, unknown>>;
  readonly returns: ReadonlyMap<string, ValueSchema<unknown, unknown>>;
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
  for (const [path, operation] of Object.entries(manifest.operations)) {
    args.set(path, schemaOfDescriptor(operation.args));
    returns.set(path, schemaOfDescriptor(operation.returns));
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
    args,
    returns,
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
 * The function `reference` names in the App's public tree, of its kind:
 * refused the same way whether it is internal or doesn't exist.
 */
const publicOperation = (
  manifest: AppManifest,
  reference: OperationReference
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
  // Actions and streams run with the action runtime of a later release:
  // refused rather than run without it.
  if (operation.kind === "action" || operation.stream !== null) {
    throw operationErrors.create("operation.unsupported");
  }
  return operation;
};

/** `args` as the function's `args` normalize them, read as JSON and bounded. */
const admittedArgs = (
  compiled: Compiled,
  operation: OperationManifest,
  args: unknown
): Json => {
  const json = jsonOf(args);
  if (json === undefined) {
    throw operationErrors.create("contract.invalid_args", {
      issues: ["The arguments aren't JSON"],
    });
  }
  if (bytesOf(json) > operationInputMaxBytes) {
    throw operationErrors.create("contract.input_too_large", {
      maxBytes: operationInputMaxBytes,
    });
  }
  const schema = compiled.args.get(operation.path);
  const result = schema?.["~standard"].validate(json);
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
 * `operationResultMaxBytes`, valid, and already as the contract
 * normalizes it (no default left out, nothing to trim).
 */
const checkedReturn = (
  compiled: Compiled,
  operation: OperationManifest,
  value: unknown
): Json => {
  const json = jsonOf(value);
  if (json === undefined) {
    throw operationErrors.create("contract.invalid_return", {
      issues: ["The value isn't JSON"],
    });
  }
  if (bytesOf(json) > operationResultMaxBytes) {
    throw operationErrors.create("contract.result_too_large", {
      maxBytes: operationResultMaxBytes,
    });
  }
  const result = compiled.returns
    .get(operation.path)
    ?.["~standard"].validate(json);
  if (result === undefined || result.issues !== undefined) {
    throw operationErrors.create("contract.invalid_return", {
      issues: issuesOf(result?.issues ?? []),
    });
  }
  const normalized = jsonOf(result.value);
  if (
    normalized === undefined ||
    canonicalJson(normalized) !== canonicalJson(json)
  ) {
    throw operationErrors.create("contract.invalid_return", {
      issues: ["The value isn't in the form its contract normalizes it to"],
    });
  }
  return json;
};

/** Domain failures App code threw, as the host rebuilt them: code and details. */
const domainFailures = new WeakMap<
  object,
  { readonly code: string; readonly details: Json | undefined }
>();

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
  const code = field(thrown, "code");
  const message = field(thrown, "message");
  if (field(thrown, "name") === "AppError" && isAppErrorCode(code)) {
    const rawDetails = field(thrown, "details");
    const details =
      rawDetails === undefined ? undefined : appErrorDetailsOf(rawDetails);
    if (
      typeof message !== "string" ||
      message.length === 0 ||
      message.length > appErrorMessageMaxLength ||
      (rawDetails !== undefined && details === undefined)
    ) {
      return operationErrors.create("contract.invalid_error", {
        maxMessageLength: appErrorMessageMaxLength,
        maxDetailsBytes: appErrorDetailsMaxBytes,
      });
    }
    const failure = new Error(message);
    domainFailures.set(failure, { code, details });
    return failure;
  }
  if (typeof code === "string" && isPlatformCode(code)) {
    const raised = open.raised(code);
    if (raised !== undefined) {
      return raised;
    }
  }
  if (sdkDefinitionCodes.has(code)) {
    return operationErrors.create("contract.invalid_query");
  }
  log.error("operation.failed", {
    requestId,
    path,
    ...errorFields(thrown),
  });
  return Object.assign(new Error("Unexpected failure"), { unexpected: true });
};

/** A JSON object: `Array.isArray` doesn't narrow a readonly array type. */
type JsonObject = Readonly<Record<string, Json | undefined>>;

const isJsonObject = (json: Json | undefined): json is JsonObject =>
  typeof json === "object" && json !== null && !Array.isArray(json);

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
  if (isExpectedError(error)) {
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
  if (field(error, "unexpected") !== true) {
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
  readonly stage: (request: unknown) => Promise<unknown>;
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
      writes.push({
        op: "insert",
        table: write.table,
        id,
        fields: validFields(table.whole, write.table, write.fields),
      });
      return await Promise.resolve(id);
    }
    if (write.kind === "replace") {
      writes.push({
        op: "replace",
        table: write.table,
        id: write.id,
        fields: validFields(table.whole, write.table, write.fields),
        expectedRevision: write.expectedRevision,
      });
      return null;
    }
    if (write.kind === "delete") {
      writes.push({
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
    writes.push({
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
    stage,
    preview: () =>
      writes.length === 0 ? undefined : { stagedAt, writes: [...writes] },
    writes: () => [...writes],
  };
};

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

/** Runs a query: its reads one state of the store (`readConsistently`). */
const runQuery = async (
  app: HostedApp,
  compiled: Compiled,
  invocation: Invocation,
  operation: OperationManifest,
  args: Json
): Promise<Json> => {
  const scope = await scopeOf(
    compiled,
    invocation,
    await invocation.authorize()
  );
  return await readConsistently(invocation.store, scope, async (reader) => {
    const open = openChannel({
      requestId: invocation.requestId,
      path: operation.path,
      read: async (request) => await readFor(operation, reader, request),
      refusals: {
        read: "operation.no_database",
        write: "operation.read_only",
        call: "operation.read_only",
        resource: "operation.no_resources",
      },
    });
    try {
      const outcome = await settle(app.run(operation.path, args, open.channel));
      if ("thrown" in outcome) {
        throw failureOf(
          outcome.thrown,
          open,
          invocation.requestId,
          operation.path
        );
      }
      return checkedReturn(compiled, operation, outcome.value);
    } finally {
      open.end();
    }
  });
};

/**
 * Runs a mutation under its receipt: claimed first (a submission that
 * committed already answers its outcome), run, its return checked, the
 * caller authorized again, then committed with its guards and read set;
 * run again when a commit finds its reads stale.
 */
const runMutation = async (
  app: HostedApp,
  compiled: Compiled,
  invocation: Invocation,
  operation: OperationManifest,
  args: Json,
  options: CallOptions
): Promise<Json> => {
  const key =
    options.idempotencyKey === undefined
      ? crypto.randomUUID()
      : submissionErrors.parse(
          "submission.key_invalid",
          idempotencyKeySchema,
          options.idempotencyKey
        );
  const roles = await invocation.authorize();
  const scope = await scopeOf(compiled, invocation, roles);
  const { store } = invocation;
  const claimed = await store.claim({
    scope: {
      principal: invocation.principal,
      resource: invocation.consumer.resourceId,
      binding: null,
      contractId: operation.path,
      contractVersion: invocation.consumer.resourceVersion,
      operationKind: "mutation",
    },
    key: ["call", key],
    inputHash: await sha256Hex(canonicalJson(args)),
    runId: invocation.runId,
    deadline: invocation.deadline,
  });
  if ("outcome" in claimed) {
    return claimed.outcome.result;
  }
  for (let run = 0; run <= queryMaxReruns; run += 1) {
    const staging = stagingFor(compiled, operation, Date.now());
    const reader = new StoreReader(store, scope, staging.preview);
    const open = openChannel({
      requestId: invocation.requestId,
      path: operation.path,
      read: async (request) => await readFor(operation, reader, request),
      write: staging.stage,
      refusals: {
        read: "operation.no_database",
        write: "operation.read_only",
        // Calls of the App's queries in the staged state come with the
        // action runtime's nested calls.
        call: "operation.unsupported",
        resource: "operation.no_resources",
      },
    });
    let value: Json;
    try {
      // One run after the other: a rerun exists only because the last
      // one's reads went stale.
      // oxlint-disable-next-line no-await-in-loop -- see above
      const outcome = await settle(app.run(operation.path, args, open.channel));
      if ("thrown" in outcome) {
        // A failure torn reads may have caused is a stale run too.
        // oxlint-disable-next-line no-await-in-loop -- see above
        if (!(await reader.isCurrent())) {
          continue;
        }
        throw failureOf(
          outcome.thrown,
          open,
          invocation.requestId,
          operation.path
        );
      }
      value = checkedReturn(compiled, operation, outcome.value);
    } finally {
      open.end();
    }
    // oxlint-disable-next-line no-await-in-loop -- see above
    const current = await invocation.authorize();
    try {
      // oxlint-disable-next-line no-await-in-loop -- see above
      const committed = await store.commit({
        principal: { userId: invocation.principal },
        roles: current,
        schemaHash: scope.schemaHash,
        receipt: claimed.held,
        stagedAt: staging.stagedAt,
        guards: [...reader.guards()],
        readSet: reader.readSet(),
        writes: staging.writes(),
        result: value,
      });
      return committed.result;
    } catch (error) {
      if (dataErrors.codeOf(error) !== "data.reads_changed") {
        throw error;
      }
    }
  }
  throw operationErrors.create("mutation.concurrent_change", {
    retryable: true,
  });
};

/**
 * Calls the public function `reference` names of `app` for `invocation`,
 * with `args`: what it returned, or why it failed, as its caller may see
 * it (see the header). Never throws.
 */
export const callOperation = async (
  app: HostedApp,
  invocation: Invocation,
  reference: OperationReference,
  args: unknown,
  options: CallOptions = {}
): Promise<OperationResult> => {
  const path = typeof reference.path === "string" ? reference.path : "";
  try {
    const compiled = compiledOf(app.manifest);
    const operation = publicOperation(app.manifest, reference);
    const admitted = admittedArgs(compiled, operation, args);
    const value =
      operation.kind === "query"
        ? await runQuery(app, compiled, invocation, operation, admitted)
        : await runMutation(
            app,
            compiled,
            invocation,
            operation,
            admitted,
            options
          );
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: payloadOf(error, invocation.requestId, path) };
  }
};
