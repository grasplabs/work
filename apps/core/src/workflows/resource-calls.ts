import { jsonSchemaOf } from "@grasp-os/sdk/host";
import type { AuditEntry } from "@grasp-os/shared/audit";
import {
  attachmentRefsSchema,
  attachmentsProperty,
} from "@grasp-os/shared/connector-attachments";
import type { AttachmentBytes } from "@grasp-os/shared/connector-attachments";
import { sha256Hex, sha256HexOfBytes } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { connectionIdSchema, permissionIdSchema } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { operationErrors } from "@grasp-os/shared/operations";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import {
  runFileErrors,
  runFileIdSchema,
  runFileLimits,
  runFileNamed,
  runFileNameSchema,
} from "@grasp-os/shared/run-files";
import { valueDepth } from "@grasp-os/shared/value-depth";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { waitUntil } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed } from "../audit-outbox.ts";
import { requireStepKey, runStubCall } from "../bindings.ts";
import { permissions } from "../db/core/schema.ts";
import { models } from "../models.ts";
import { resolveCatalogKeys } from "../workflow-catalog.ts";
import { writeJson } from "./bounded-json.ts";
import { schemaOfDescriptor, takesExactly } from "./exact-values.ts";
import { runFileTypeShown } from "./office-files.ts";
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
  requireResourceRunEvidenceReadable,
} from "./resource-reads.ts";
import type { KnowledgeCall } from "./resource-reads.ts";
import {
  attachRunFiles,
  callFiles,
  keepFile,
  requireFilesArguments,
} from "./run-files.ts";
import type { FilesAnswer, FilesCallOperation } from "./run-files.ts";

// The effects of a run of an independent workflow's sealed build
// (platform specification 13.6): its `grasp.connector` and `grasp.model`
// calls, each through the target its start froze for the call's binding,
// and only through connect or the model gateway, as every external call
// and model call of the platform.
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
//   (`authorize`, bindings.ts).
// - An effect repeated by a retry or a replay. A replay never calls: the
//   step answers what it recorded. Each effect has its own idempotency
//   key, its step's (`Effect.key`, the run and the task, so the same in
//   every attempt and replay), which connect keys a side effect's stored
//   result by.
//   A model call's step isn't retried
//   (sealed-run.ts, `triedOnceCalls`): a model request is not idempotent.
// - Arguments or answers that aren't the contract's. Arguments are checked
//   against the binding's catalog contract before anything is sent, and
//   what comes back against it before the run sees it, by the SDK's
//   validator, which must take each exactly as it is
//   (`workflow.call_invalid`); a model's answer against the task's own
//   output schema, as sealed.
// - A restricted run (one a restricted App started) passing on what its
//   start carried. Its connector calls carry its restricted mode to
//   connect, which holds every one but a native connector's declared
//   reads for its person (`connect.held`; the run waits for their
//   decision, host.ts).
// - A run's files leaving through a connector write (GRA-887). A write
//   attaches files only where the operation's sealed contract records it
//   takes them (`takesFiles`, which its approval compared with what the
//   connection serves), only from a files use the action declared to read
//   (`from`, through that binding's own authority), and only files of the
//   calling run, looked up by their ID and the run's (`attachRunFiles`):
//   another run's, or one deleted or unfinished, is refused. At most ten
//   files and 2.75 MiB of them, each named once, checked from core's
//   records before a byte is read. The action gives IDs and nothing else:
//   the name, type, size and SHA-256 connect is sent come from core's own
//   record, the bytes go beside the input and are checked against its
//   digests by connect and again by the connector, and none is kept
//   (a held write keeps the digests only; its release reads the files
//   again, pending-actions.ts). The call's receipts list each file's ID,
//   type, size and digest, never its name or content.
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
  /** Throws unless its attempt still holds its lease, nothing awaited. */
  readonly requireHolds: () => void;
  /**
   * Whether one of the workflow's own actions makes it (resource-action.ts):
   * a restricted run's action makes no connector call, whose held decision
   * would outlive the action that can't wait for it.
   */
  readonly fromAction?: boolean;
  /**
   * Hears that the call goes out now: every check of its own passed, its
   * started receipt kept, nothing awaited after (a model's: as its request
   * is sent). Where a call tried once marks that it went (sealed-run.ts).
   */
  readonly sending?: () => void;
}

/**
 * A run's call of one of an App's functions (app-calls.ts, GRA-1663),
 * as its host builds it: the App by its ID, the function by the stable
 * ID the App's definition gives it, and its arguments, which the
 * function's own validator checks.
 */
export interface AppCall {
  readonly name: "grasp.app";
  readonly app: string;
  readonly function: string;
  readonly arguments: Json;
}

/** A task's call, its arguments built by the host (sealed-run.ts, `#sent`). */
export type BuiltCall =
  | {
      readonly name: "grasp.connector";
      readonly binding: string;
      readonly operation: string;
      readonly arguments: Json;
      /** The values of the binding arguments the host put in. */
      readonly sensitive: readonly Json[];
      /**
       * The files binding a read that answers a file keeps it in, as a
       * file of the run (GRA-886): asked by an action that declared that
       * files use, to write.
       */
      readonly into?: string;
      /**
       * The files binding a write's attachments are run files of (GRA-887):
       * asked by an action that declared that files use, to read.
       */
      readonly from?: string;
    }
  | {
      readonly name: "grasp.model";
      readonly binding: string;
      readonly instructions: Json;
      readonly input: Json;
      /** The task's own output schema, as a descriptor. */
      readonly outputSchema: Json;
    }
  | {
      /** A Knowledge collection's search, read or recall, by an action (GRA-700). */
      readonly name: "grasp.knowledge";
      readonly binding: string;
      readonly operation: KnowledgeCall["operation"];
      readonly arguments: Json;
    }
  | {
      /** A pinned template version's content, by an action (GRA-700). */
      readonly name: "grasp.template";
      readonly binding: string;
    }
  | {
      /** One call on the run's own files, by an action (GRA-724). */
      readonly name: "grasp.files";
      readonly binding: string;
      readonly operation: FilesCallOperation;
      readonly arguments: Json;
    }
  /**
   * One of an App's functions, by its App's ID and the stable ID the
   * App's definition gives it, through the workflow's own grant on it,
   * never a catalog binding (app-calls.ts, GRA-1663).
   */
  | AppCall;

/** A call made through a catalog binding its start froze. */
type BoundBuiltCall = Exclude<BuiltCall, AppCall>;

/** The binding kind each call goes through. */
const kindOf = {
  "grasp.connector": "connector",
  "grasp.model": "model",
  "grasp.knowledge": "knowledge",
  "grasp.template": "template",
  "grasp.files": "files",
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
 * a value past what a step records, or nested deeper than a value may,
 * is refused before anything walks it.
 */
/** `value` as JSON, as much as a step records, or `workflow.call_invalid`. */
export const boundedAnswer = (value: unknown, what: string): Json => {
  const written = writeJson(value, {
    maxBytes: platformLimits.stepPayloadBytes,
    maxDepth: valueDepth,
    maxNodes: platformLimits.stepPayloadBytes,
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
export const contractOf = async (
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

/** A read that answers a file's own fields, as connector-kit's `contentAs` makes them. */
const fileAnswerSchema = z
  .object({
    name: z.string().nullable(),
    contentType: z.string().nullable(),
    encoding: z.literal("base64"),
    content: z.string(),
  })
  .catchall(z.json());

/** The most base64 text a run file's bytes take. */
const fileContentMaxChars = Math.ceil(runFileLimits.fileBytes / 3) * 4;

/**
 * A file read's answer as its base64 content, at most a run file's worth,
 * and the rest of it: the content is checked against the contract's shape
 * as an empty string, so the step's bound applies to the rest alone.
 */
const fileContentOf = (
  output: unknown
): { content: string; rest: Record<string, unknown> } => {
  const read = z
    .object({ content: z.string().max(fileContentMaxChars) })
    .catchall(z.unknown())
    .safeParse(output);
  if (!read.success) {
    throw callInvalid("output: It isn't a file's content as base64.");
  }
  const { content, ...rest } = read.data;
  return { content, rest };
};

/**
 * `input` of a read an action asked to have as a file: refused unless the
 * operation answers one as its sealed contract records it (`answersFile`,
 * which only a native connector's confirmed operation may, and which its
 * approval compared with what the connection serves), and asked for as
 * base64.
 */
const asFileRead = (operation: { answersFile?: true }, input: Json): Json => {
  const fields = z.record(z.string(), z.json()).safeParse(input);
  if (operation.answersFile !== true || !fields.success) {
    throw callInvalid("into: This operation doesn't answer a file.");
  }
  if (fields.data.as !== undefined && fields.data.as !== "base64") {
    throw callInvalid("arguments.as: A file is read as base64.");
  }
  return { ...fields.data, as: "base64" };
};

/** How a kept file is named when the name it came with can't be a run file's. */
const unnamedFile = "attachment";

/**
 * Refuses a read kept as a file (`into`) that passes a sensitive
 * parameter: the file could hold the value, and the run reads a kept
 * file whole, where no check of the answer's echo (`echoes`) reaches.
 */
const requireNoSensitiveKept = (
  call: Extract<BuiltCall, { name: "grasp.connector" }>
): void => {
  if (call.into !== undefined && call.sensitive.length > 0) {
    throw callInvalid(
      "into: A call passing a sensitive parameter keeps no file, which could hold it."
    );
  }
};

/**
 * Refuses run files attached (`from`) to an operation whose contract
 * doesn't record that it takes them (`takesFiles`).
 */
const requireTakesFiles = (
  operation: { takesFiles?: true },
  call: Extract<BuiltCall, { name: "grasp.connector" }>
): void => {
  if (call.from !== undefined && operation.takesFiles !== true) {
    throw callInvalid("from: This operation attaches no files.");
  }
};

/**
 * The ID a test run's stand-in for the file its call `key` keeps has: a
 * UUID, as every run file's is, so a later step's files call names it as
 * it would a real one, made from the call's own key, so the same call
 * again (a replay, a retry) answers the same ID. No file has it: a test
 * run keeps none, and its files calls are answered from its fixtures.
 */
const candidateFileId = async (key: string): Promise<string> => {
  const hex = await sha256Hex(`candidate-file:${key}`);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
};

/**
 * What a test run's read kept as a file answers: its fixture, checked
 * against the contract's shape as a real read is (its content apart),
 * with a stand-in reference to the file in place of its content and
 * encoding, as no test run keeps a file. The stand-in's size and digest
 * are of the fixture's bytes; its ID finds no file anywhere.
 */
const candidateKept = async (
  operation: { output: string },
  answer: Json,
  key: string
): Promise<Json> => {
  const read = fileAnswerSchema.safeParse(answer);
  if (!read.success) {
    throw callInvalid("output: It isn't a file's content as base64.");
  }
  const { content, encoding: _encoding, ...rest } = read.data;
  requireShape(
    operation.output,
    { ...rest, encoding: "base64", content: "" },
    "output"
  );
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(content), (char) => char.codePointAt(0) ?? 0);
  } catch {
    throw callInvalid("output: Its content isn't base64.");
  }
  // Typed by its bytes and named as a real read's kept file would be
  // (`keptAsFile`, `keepFile`): a type no run file may be refused.
  const type = await runFileTypeShown(bytes, rest.contentType);
  if (type === undefined) {
    throw runFileErrors.create("file.run_type_unsupported");
  }
  const named = runFileNameSchema.safeParse(rest.name);
  return {
    ...rest,
    file: {
      file: await candidateFileId(key),
      name: runFileNamed(named.success ? named.data : unnamedFile, type),
      type,
      size: bytes.length,
      sha256: await sha256HexOfBytes(bytes),
    },
  };
};

/**
 * `answer`, a read that answers a file, with its bytes kept as a file of
 * the calling run (`keepFile`) and named in place of its content: its
 * type shown by its bytes (`runFileTypeShown`), never the label it came
 * with; its name only if a run file's may be it. What the call's receipt
 * says of the file: its ID, type, size and SHA-256, never its name.
 */
const keptAsFile = async (
  env: Env,
  run: CallingRun,
  effect: Effect,
  answer: Json
): Promise<FilesAnswer> => {
  const read = fileAnswerSchema.safeParse(answer);
  if (!read.success) {
    throw callInvalid("output: It isn't a file's content as base64.");
  }
  const { content, contentType } = read.data;
  // Its other fields as they are; its content and encoding become the file.
  const rest = Object.fromEntries(
    Object.entries(read.data).filter(
      ([key]) => key !== "content" && key !== "encoding"
    )
  );
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(content), (char) => char.codePointAt(0) ?? 0);
  } catch {
    throw callInvalid("output: Its content isn't base64.");
  }
  // A ZIP is a Word or Excel document only by what its package declares.
  const type = await runFileTypeShown(bytes, contentType);
  if (type === undefined) {
    throw runFileErrors.create("file.run_type_unsupported");
  }
  const named = runFileNameSchema.safeParse(read.data.name);
  const kept = await keepFile(
    env,
    {
      runId: run.runId,
      workflowId: run.workflowId,
      effectKey: effect.key,
      requireHolds: effect.requireHolds,
    },
    { name: named.success ? named.data : unnamedFile, type, bytes }
  );
  return {
    output: { ...rest, file: kept.output },
    detail: kept.detail,
  };
};

/** What a write's attachments become on their way to connect. */
interface Attached {
  /** The call's input, its `attachments` as digests (`AttachmentEntry`). */
  readonly input: Json;
  /** The files' bytes beside it, by SHA-256; none if it attaches nothing. */
  readonly files: AttachmentBytes | undefined;
  /** What the call's receipt says of them: IDs, types, sizes, digests. */
  readonly detail: Readonly<Record<string, string | number>>;
}

/**
 * `input` of a write as connect is sent it (GRA-887): refused unless it
 * attaches files only where its sealed contract records the operation
 * takes them (`takesFiles`, which only a native connector's confirmed
 * operation may, and which its approval compared with what the connection
 * serves) and from a files use the action named (`from`); then its run
 * files named by ID become digests and bytes (`attachRunFiles`).
 */
const attachedTo = async (
  env: Env,
  run: CallingRun,
  operation: { takesFiles?: true },
  call: Extract<BuiltCall, { name: "grasp.connector" }>,
  input: Json
): Promise<Attached> => {
  const takes = operation.takesFiles === true;
  requireTakesFiles(operation, call);
  const fields = z.record(z.string(), z.json()).safeParse(input);
  // Never passed on to an operation that takes no files, whatever its own
  // schema allows: run files leave only where the contract says they may.
  if (
    !takes &&
    fields.success &&
    Object.hasOwn(fields.data, attachmentsProperty)
  ) {
    throw callInvalid(
      "arguments.attachments: This operation attaches no files."
    );
  }
  const named =
    takes && fields.success && Object.hasOwn(fields.data, attachmentsProperty)
      ? attachmentRefsSchema.safeParse(fields.data[attachmentsProperty])
      : undefined;
  if (named === undefined || !fields.success) {
    return { input, files: undefined, detail: {} };
  }
  if (!named.success) {
    throw callInvalid("arguments.attachments: Name run files by ID.");
  }
  if (named.data.length > 0 && call.from === undefined) {
    throw callInvalid(
      "arguments.attachments: Name the files use they come from."
    );
  }
  const attached = await attachRunFiles(
    env,
    { runId: run.runId },
    named.data.map(({ file }) => file)
  );
  return {
    input: { ...fields.data, [attachmentsProperty]: attached.entries },
    files: attached.bytes,
    detail: attached.detail,
  };
};

/**
 * Refuses (`workflow.call_denied`) a connector call that names a files
 * binding (`aliases`: where a read is kept, where a write's attachments
 * are read from) unless the run's start froze that alias as a files
 * binding and its authority holds now, as the files call it stands for
 * would (GRA-886, GRA-887).
 */
const requireFilesBindings = async (
  env: Env,
  run: CallingRun,
  aliases: readonly (string | undefined)[]
): Promise<void> => {
  for (const alias of aliases) {
    if (alias !== undefined) {
      const files = run.bindings.get(alias);
      if (files?.kind !== "files") {
        throw workflowResourceErrors.create("workflow.call_denied");
      }
      // oxlint-disable-next-line no-await-in-loop -- at most two, each decided in turn
      await requireCallAuthority(env, run, files);
    }
  }
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
  effect: Effect,
  onFiles: (detail: Readonly<Record<string, string | number>>) => void
): Promise<FilesAnswer> => {
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
  const asked = requireShape(shape.input, call.arguments, "arguments");
  const row = await workflowPermission(env, run, target.permissionId);
  if (row.objectType !== "connection") {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  // Kept as a file of the run: only of a read its connector declares
  // answers a file, which it is asked for as base64, the bytes as they are.
  const read = call.into === undefined ? asked : asFileRead(shape, asked);
  // Files attached: only to a write its connector declares takes them, as
  // its sealed contract records it, from a files use the action declared;
  // each a finished file of this run, named by ID, whose name, type, size
  // and digest are core's own and whose bytes go beside the input.
  const attached = await attachedTo(env, run, shape, call, read);
  onFiles(attached.detail);
  const { input } = attached;
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
          // And the files uses it keeps a read in or attaches files from.
          await requireFilesBindings(env, run, [call.into, call.from]);
          effect.requireHolds();
        },
        // Its mail is stamped with the run (mail-stamps.ts), so a copy
        // that reaches a mailbox a connector trigger watches starts the
        // trigger's run in this run's lineage, never as a new root.
        stamping: { run: run.runId, stepKey: effect.key, kind: "resource" },
      };
    },
    {
      // A write that attaches files names the files use they come from,
      // so a held one's release decides that use's authority again
      // (pending-actions.ts).
      context: runContext(run, call.from),
      permissionId: permissionIdSchema.parse(target.permissionId),
      connection: {
        type: "connection",
        connectionId: connectionIdSchema.parse(row.objectId),
        ...(row.resource === null ? {} : { resource: row.resource }),
      },
    },
    [call.operation, input, { idempotencyKey: effect.key }],
    attached.files
  );
  if (result.pending !== undefined) {
    // Connect answers a workflow's held side effect (a restricted run's)
    // with `connect.held`, whose decision the run waits for
    // (host.ts), never with a held answer: never a success.
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  let output: unknown;
  try {
    output = JSON.parse(result.output);
  } catch {
    throw callInvalid("output: Not JSON.");
  }
  // A file's content becomes the run's file, never the step's record: it
  // is bound by a run file's size, the rest of the answer by a step's.
  const content = call.into === undefined ? undefined : fileContentOf(output);
  const answer = requireShape(
    shape.output,
    content === undefined ? output : { ...content.rest, content: "" },
    "output"
  );
  // An answer that echoes a binding argument would put its sensitive
  // value in the step's record, and on into the run: refused, never
  // redacted, so nothing of it is recorded.
  if (echoes(answer, call.sensitive)) {
    throw callInvalid("output: It echoes a sensitive argument.");
  }
  if (content === undefined) {
    return { output: answer, detail: {} };
  }
  // The shape took the rest as it is: its content back in its place.
  const fields = z.record(z.string(), z.json()).parse(answer);
  return await keptAsFile(env, run, effect, {
    ...fields,
    content: content.content,
  });
};

/**
 * What model call `call` asks for, checked as every model call is, a test
 * run's included: its instructions as text (`workflow.call_invalid`
 * otherwise).
 */
export const requireModelRequest = (
  call: Extract<BuiltCall, { name: "grasp.model" }>
): string => {
  if (typeof call.instructions !== "string") {
    throw callInvalid("instructions: Give text.");
  }
  return call.instructions;
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
  const instructions = requireModelRequest(call);
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
      system: instructions,
      input: z.json().parse(call.input),
      schema: z.fromJSONSchema(
        jsonSchemaOf(native.descriptor, { exact: true })
      ),
      purpose: "workflow.step",
      trigger: { type: "system" },
      // Its account's: its spend counts in the run lineage of the account
      // it is charged to (its lineage's root, or its workflow's account in
      // the lineage a trigger started it in), and in its workflow's.
      lineage: { rootRunId: run.accountRunId, workflowId: run.workflowId },
      work: { authority: runAuthority(run), context: runContext(run) },
      // Before each provider request, the run's authority decided again
      // (it may have gone meanwhile), then its lease, nothing awaited
      // before the request is sent.
      reauthorize: async () => {
        try {
          await requireCallAuthority(env, run, binding);
        } catch (error) {
          refused.by = error;
          throw error;
        }
      },
      beforeSend: () => {
        effect.requireHolds();
        effect.sending?.();
      },
      // One request per call, so the run's limit of model calls
      // (`maxModelCalls`, sealed-run.ts) bounds its requests: an answer
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
 * (sealed-run.ts, `#reserveModelCall`, GRA-700).
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

const namesFileSchema = z.object({ file: runFileIdSchema });

/**
 * The files operations that publish what a run hands them: a file's name
 * as it opens, its bytes as it's appended to, both once it's finished.
 */
const filesWrites: ReadonlySet<string> = new Set([
  "open",
  "append",
  "finish",
  "write",
]);

/**
 * Whether `call` may hand out what its run recalled: a connector call, a
 * model call, or a file it writes (`filesWrites`).
 */
const handsOut = (call: BuiltCall): boolean =>
  call.name === "grasp.connector" ||
  // Its arguments are the App's to keep.
  call.name === "grasp.app" ||
  call.name === "grasp.model" ||
  (call.name === "grasp.files" && filesWrites.has(call.operation));

/**
 * What every receipt of a files call says before its answer: the
 * operation, and the file it names, if it names one as a file ID, so a
 * refused call's receipt still says which file was asked for.
 */
const filesCallDetail = (
  operation: string,
  args: Json
): Record<string, string> => {
  const named = namesFileSchema.safeParse(args);
  return { operation, ...(named.success ? { file: named.data.file } : {}) };
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
  run: CallingRun,
  bindings: ReadonlyMap<string, CandidateBinding>,
  call: BuiltCall,
  key: string
): Promise<Json> => {
  // An App call goes through no binding: its answer is the start's under
  // the call's own key (app-calls.ts, `appCallKey`), checked against what
  // the function answers.
  if (call.name === "grasp.app") {
    const { appCallKey, candidateAppAnswer } = await import("./app-calls.ts");
    return await candidateAppAnswer(
      env,
      run,
      bindings.get(appCallKey(call)),
      call
    );
  }
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
      // As a real call: a file kept only from a read that answers one,
      // files attached only to a write that takes them.
      requireTakesFiles(shape, call);
      if (call.into === undefined) {
        return requireShape(shape.output, answer, "output");
      }
      asFileRead(shape, call.arguments);
      return await candidateKept(shape, answer, key);
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
    // A test run keeps no file: its files calls answer what its start
    // gave, and nothing is written to the run's files, once their
    // arguments are what a real call would take.
    case "grasp.files": {
      requireFilesArguments(call.operation, call.arguments);
      return boundedAnswer(answer, "output");
    }
    default: {
      return call satisfies never;
    }
  }
};

/**
 * Refuses `call` of `run` through `binding` unless it may go now, before
 * anything is sent: a connector call from an action of a restricted run
 * (connect would hold it for a decision no action waits for), and any
 * call whose authority isn't decided again (`requireCallAuthority`) or
 * that hands out what the run may no longer read (`handsOut`), a
 * connector call's files bindings too (`requireFilesBindings`).
 */
const requireCallAllowed = async (
  env: Env,
  run: CallingRun,
  binding: FrozenCatalogBinding,
  call: BoundBuiltCall,
  effect: Effect
): Promise<void> => {
  if (
    effect.fromAction === true &&
    run.restricted &&
    call.name === "grasp.connector"
  ) {
    throw workflowResourceErrors.create("workflow.action_restricted");
  }
  await requireCallAuthority(env, run, binding);
  // What the run recalled leaves with a connector call or a model call,
  // and with a file it writes: a file's name and its
  // bytes are shown outside the run once it's finished (run-files.ts), so
  // opening, appending to and finishing one are gated too. Not once the
  // run may no longer read it (resource-reads.ts), refused with its
  // receipt kept as `brain.revoked`. Reading, listing or deleting its own
  // files hands nothing out.
  if (handsOut(call)) {
    await requireResourceRunEvidenceReadable(env, run);
  }
  // A read kept as a file needs the files binding it goes into, and a
  // write that attaches files the one they come from (GRA-887), each with
  // its authority now, as the files call it stands for would (GRA-886).
  if (call.name === "grasp.connector") {
    await requireFilesBindings(env, run, [call.into, call.from]);
  }
};

/**
 * A receipt of call `call` of task `task` of `run`, under key `key`
 * (`workflow.run.called`): what it went through (`through`: its binding
 * and approval, or the App and function it called, by ID) and `outcome`,
 * never an argument or answer.
 */
const callReceipt = (
  run: CallingRun,
  { task, call, key }: { task: string; call: string; key: string },
  through: Readonly<Record<string, string | number>>,
  outcome: string
): AuditEntry => ({
  actor: { type: "system" },
  action: "workflow.run.called",
  target: { type: "workflow_run", id: run.runId },
  detail: {
    workflow: run.workflowId,
    version: run.version,
    task,
    call,
    ...through,
    key,
    person: run.principal,
    outcome,
  },
});

/**
 * Keeps a call's outcome receipt, which follows its started one, kept
 * before anything was sent: a failure to keep it is logged, never put in
 * place of what the call came to.
 */
const receiptKept = async (
  env: Env,
  run: CallingRun,
  task: string,
  entry: AuditEntry
): Promise<void> => {
  try {
    await audited(env, entry);
  } catch (error) {
    log.error("workflow.run_receipt_unkept", {
      runId: run.runId,
      task,
      outcome: String(entry.detail?.outcome),
      ...errorFields(error),
    });
  }
};

/** `value`, a call's ID, as a receipt names it: none for one that isn't text. */
const receiptId = (value: unknown): string =>
  typeof value === "string" ? value.slice(0, 64) : "";

/**
 * Makes `call` of one of an App's functions (app-calls.ts), as task
 * `task` of `run`, for `effect`, with its receipts in the audit log as
 * every call of a run leaves them: started, kept before anything is
 * sent, then its outcome by code. They name the App and the function by
 * their IDs, never an argument or answer.
 */
const madeAppCall = async (
  env: Env,
  run: CallingRun,
  task: string,
  call: AppCall,
  effect: Effect
): Promise<Json> => {
  // The App's request ID, once it is known: what the App's own evidence
  // of the call names too.
  let request: Readonly<Record<string, string>> = {};
  // Read as the host sent them, whatever they are: `callApp` refuses
  // what isn't an App's ID and a function's.
  const receipt = (outcome: string): AuditEntry =>
    callReceipt(
      run,
      { task, call: "grasp.app", key: effect.key },
      {
        app: receiptId(call.app),
        function: receiptId(call.function),
        ...request,
      },
      outcome
    );
  try {
    // What the run recalled leaves with the arguments, as with any call
    // that hands out.
    await requireResourceRunEvidenceReadable(env, run);
    await audited(env, receipt("started"));
    // Imported here, not at the top: an App's functions start workflows,
    // whose runs reach back into this module.
    const { callApp } = await import("./app-calls.ts");
    const value = await callApp(env, run, call, effect, (requestId) => {
      request = { request: requestId };
    });
    const output = boundedAnswer(value, "output");
    await receiptKept(env, run, task, receipt("done"));
    return output;
  } catch (error) {
    await receiptKept(
      env,
      run,
      task,
      receipt(isExpectedError(error) ? error.code : "internal.unexpected")
    );
    throw error;
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
  // Never a file kept by a read that passes a sensitive value, before
  // anything else is looked at, a test run's included.
  if (call.name === "grasp.connector") {
    requireNoSensitiveKept(call);
  }
  // A test run of a draft's checkpoint calls nothing: whatever the call,
  // its answer is the one the run's start gave its binding, before any
  // binding, authority or receipt is looked at, so nothing of it can
  // reach connect, a model, an App, a store or Knowledge.
  if (run.candidate !== undefined) {
    return await candidateAnswer(env, run, run.candidate, call, effect.key);
  }
  // A run an App's test started never comes here: its host answers its
  // model calls from its test (fixture-calls.ts) and refuses the rest.
  // Refused again, before anything is looked at, so none of its calls
  // can reach connect, a model, an App, a store or Knowledge.
  if (run.fixture === true) {
    throw operationErrors.create("resource.unavailable");
  }
  if (call.name === "grasp.app") {
    return await madeAppCall(env, run, task, call, effect);
  }
  const binding = run.bindings.get(call.binding);
  if (binding?.kind !== kindOf[call.name]) {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  // What a files call's receipts say of its file (GRA-724): never its name.
  let fileDetail: Readonly<Record<string, string | number>> = {};
  const receipt = (outcome: string): AuditEntry =>
    callReceipt(
      run,
      { task, call: call.name, key: effect.key },
      { binding: binding.alias, approval: binding.approval, ...fileDetail },
      outcome
    );
  const outcomeKept = async (outcome: string): Promise<void> => {
    await receiptKept(env, run, task, receipt(outcome));
  };
  let output: Json;
  try {
    if (call.name === "grasp.files") {
      fileDetail = filesCallDetail(call.operation, call.arguments);
    }
    await requireCallAllowed(env, run, binding, call, effect);
    // Kept before the call goes out, or it doesn't go: a call that took
    // effect always has its receipt, whatever happens after.
    await audited(env, receipt("started"));
    // A model call goes out as its request is sent (`callModel`).
    if (call.name !== "grasp.model") {
      effect.sending?.();
    }
    switch (call.name) {
      case "grasp.connector": {
        const answer = await callConnector(
          env,
          run,
          binding,
          call,
          effect,
          // Said of the files a write attaches as soon as they are chosen,
          // so even a call that fails after leaves them in its receipt.
          (detail) => {
            fileDetail = { ...fileDetail, ...detail };
          }
        );
        fileDetail = { ...fileDetail, ...answer.detail };
        ({ output } = answer);
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
      case "grasp.files": {
        const answer = await callFiles(
          env,
          {
            runId: run.runId,
            workflowId: run.workflowId,
            effectKey: effect.key,
            requireHolds: effect.requireHolds,
          },
          call.operation,
          call.arguments
        );
        fileDetail = { ...fileDetail, ...answer.detail };
        ({ output } = answer);
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
