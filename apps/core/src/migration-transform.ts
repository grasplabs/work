import { appModuleName, kitModuleName } from "@grasp-os/compiler";
import { schemaFromDescriptor } from "@grasp-os/sdk/host";
import type { MigrationManifest } from "@grasp-os/sdk/host";
import { versionErrors } from "@grasp-os/shared/app-releases";
import type { MigrationEvidence } from "@grasp-os/shared/app-releases";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson, canonicalText } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { jsonOf } from "@grasp-os/shared/operations";
import { documentMaxBytes } from "@grasp-os/shared/stores";
import type { StoreFields } from "@grasp-os/shared/stores";

import type { Release } from "./app-releases.ts";
import { callSandboxed, SandboxUnavailableError } from "./sandboxed.ts";
import type { SandboxedEnv, SandboxedWorker } from "./sandboxed.ts";

// Running an App's explicit migration (spec 17.2) on a batch of records:
// the transform is App code, so it runs only in an isolate with no env and
// no network, on the sandbox host on-prem (`callSandboxed`), and nothing it
// answers is trusted. This module only transforms: which records, when,
// and how the result commits against their revisions is the store's
// (GRA-250's later slices). Threat model, and how each is closed:
//
// - The transform reaches a model, a connector, the network or the store,
//   or reads another record: its isolate has no env, no bindings, no
//   outbound network (`globalOutbound: null`) and no channel back to core;
//   its context is the migration's own metadata and the record's ID, and
//   its row the record's fields alone. Building it from server code is
//   refused at compile time too (compiler: migrations import only the
//   schema, values and the SDK's root).
// - The transform writes what the target table doesn't accept: a managed
//   field (`_id`, `_rev`, ...), a key the table doesn't declare, a value of
//   the wrong type, a document past the store's limit. Each output is
//   validated here against the target table's fields as the release's
//   sealed schema declares them (a strict object, so unknown and managed
//   keys are refused), and the record's managed fields are never in what
//   it gets or answers: the store keeps them.
// - The transform drops or rewrites data the target doesn't declare
//   (fields kept for a retained version, or a rename's old name): they are
//   kept outside it and merged back, so a migration never contracts a
//   record; handed back unchanged they pass, changed they are refused.
// - A row the transform wasn't written for: when it declares `input`, each
//   row is validated against it first, and a row that doesn't fit fails
//   the batch naming the record, before any App code sees it.
// - The transform throws, loops or answers too much: its failure names the
//   row, the sandbox ends it at its deadline (a refusal of the App's code,
//   as at inspection), and an answer past `transformAnswerMaxBytes` is
//   refused. A sandbox that didn't answer at all is
//   `SandboxUnavailableError`, never the App's failure.
// - The transform carries one owner's data into another owner's record:
//   module state survives between the rows of one call (a fresh isolate
//   per call ends it between calls), so on a table whose read or write
//   access is `owner` a batch holds one owner's records only. Each row
//   carries its owner, which the host supplies and the handler never
//   sees, and a batch that mixes owners there is refused as a caller's
//   bug. A migration still reads and rewrites every record of its table,
//   whoever owns it: the version review says so.
// - The transform answers differently each time: randomness and clocks
//   are taken away while it runs and while its answer is serialized (sdk
//   runner, `runMigration`). Best effort, not a boundary: a value captured
//   as its modules loaded can still differ between calls, so a retried
//   batch is answered from the store's receipt, never compared with an
//   earlier answer.
// - A transform that answers wrong (valid for the table, but not what was
//   meant) rewrites real records before anyone notices: it runs on its
//   fixtures first, as its release is sealed (`migrationEvidence`), and
//   only one whose fixtures all passed runs on records
//   (migration-evidence.ts). Fixtures are the App's own data, reviewed
//   with it; what the run found is sealed into the release's manifest by
//   the host, never reported by App code. Not a boundary against a
//   transform written to tell fixtures from records (it sees their IDs and
//   fields): every output on records is still validated as above.
// - The transform writes a record's values to the logs (`console.log(row)`).
//   On Cloudflare a loaded isolate's console output is dropped when it
//   ends, as no Tail Worker is attached (no `tails`), and the loader's own
//   Workers Logs never hold it. Plain workerd prints it to its process's
//   stdout and stderr, and the on-prem sandbox host's processes inherit
//   the supervisor's (scripts/workerd-sandbox.ts), so on-prem it would
//   reach the deployment's logs, whoever's records the batch holds. The
//   isolate's first module (`quietModule`) replaces every console method
//   with one that does nothing, before any App or kit module loads, so no
//   module of the isolate holds the original: logging, `node:console`'s
//   default and an App's own replacement print nothing, on either
//   profile. (An exception left uncaught in a microtask is printed by
//   workerd only when served `--verbose`, which the supervisor isn't.)

/** Rows one batch transforms, at most (spec 17.2's bounded batches). */
export const transformBatchMaxRows = 100;

/**
 * The most bytes a batch's rows take as JSON: a store's caller cuts its
 * batch before it passes this, so the isolate's call stays bounded.
 */
export const transformBatchMaxBytes = 2 * 1024 * 1024;

const encoder = new TextEncoder();

/** What a batch's array takes besides its records: its brackets. */
export const transformBatchOverhead = 2;

/**
 * What one record's canonical text (`text`) adds to a batch: its UTF-8
 * bytes, and the comma before it unless it is the first (`afterAnother`).
 * A caller cutting a batch adds these up as it goes, measuring each
 * record once, and lands where `transformBatchBytes` would.
 */
export const transformRecordBytes = (
  text: string,
  afterAnother: boolean
): number => encoder.encode(text).byteLength + (afterAnother ? 1 : 0);

/**
 * The bytes a batch of records takes as one JSON array of their fields'
 * canonical texts (`texts`): the brackets, the commas between them and
 * each text's UTF-8 bytes. The transform's bound (`requireBatch`) uses
 * it, and the store cutting its batches (store-migrations.ts) sums the
 * same parts, so a batch the store hands out always passes the transform's.
 */
export const transformBatchBytes = (texts: readonly string[]): number =>
  transformBatchOverhead +
  texts.reduce(
    (sum, text, index) => sum + transformRecordBytes(text, index > 0),
    0
  );

/** The most bytes of JSON text a batch's answer may take. */
export const transformAnswerMaxBytes = 4 * 1024 * 1024;

/**
 * One record a batch transforms: its ID, its owner (`_ownerId`, which the
 * host supplies and the handler never sees) and its stored fields, managed
 * fields never among them.
 */
export interface TransformRow {
  readonly id: string;
  readonly owner: string;
  readonly fields: StoreFields;
}

/** Why a batch failed, naming the record when one is to blame. */
export type TransformFailure =
  | {
      readonly id: string;
      readonly reason:
        | "invalid_input"
        | "threw"
        | "invalid_output"
        | "too_large";
      readonly issues: readonly string[];
    }
  | {
      readonly id: null;
      readonly reason: "invalid_answer";
      readonly issues: readonly string[];
    };

/** A batch transformed: each record's fields after, in order, or why not. */
export type TransformOutcome =
  | { readonly ok: true; readonly rows: readonly TransformRow[] }
  | { readonly ok: false; readonly failure: TransformFailure };

/** What a transform needs of a sealed release. */
export type TransformRelease = Pick<Release, "app" | "modules" | "sdk">;

/**
 * The isolate's main module, the module its request is in, and the one
 * that silences its console, loaded first (see the header).
 */
const migrateModule = "grasp-migrate.js";
const requestModule = "grasp-migrate-request.js";
const quietModule = "grasp-migrate-quiet.js";

/**
 * Every console method replaced by one that does nothing. Evaluated before
 * any other module of the isolate, as the main module imports it first.
 */
const quietMain = `const silent = () => undefined;
for (const name of Object.getOwnPropertyNames(console)) {
  if (typeof console[name] === "function") {
    console[name] = silent;
  }
}
`;

/**
 * The transform isolate's main module: the batch through the SDK's
 * runner, its answer as bounded JSON text. Untrusted like everything in
 * the isolate; it only bounds what it hands back.
 */
const migrateMain = `import ${JSON.stringify(quietModule)};
import { WorkerEntrypoint } from "cloudflare:workers";
import { runMigration } from ${JSON.stringify(kitModuleName("@grasp-os/sdk/runner"))};
import registered from ${JSON.stringify(appModuleName("app.ts"))};
import request from ${JSON.stringify(requestModule)};

export class Migrate extends WorkerEntrypoint {
  run() {
    const text = JSON.stringify(runMigration(registered, request));
    if (typeof text !== "string" || text.length > ${transformAnswerMaxBytes}) {
      throw new Error("The migration's answer is too large.");
    }
    return text;
  }
}
`;

/**
 * The isolate that runs `request` (a migration's name and its rows, their
 * owners left out) on `release`'s modules and kit: its console silenced
 * first (`quietModule`), then the batch through the SDK's runner.
 */
export const transformIsolate = (
  release: Pick<TransformRelease, "modules" | "sdk">,
  request: {
    readonly name: string;
    readonly rows: readonly { id: string; fields: StoreFields }[];
  }
): SandboxedWorker => ({
  mainModule: migrateModule,
  // The platform's modules last: no App module takes one's name.
  modules: {
    ...release.modules,
    ...release.sdk,
    // JSON is a JavaScript expression: the request as data.
    [requestModule]: `export default ${JSON.stringify(request)};\n`,
    [quietModule]: quietMain,
    [migrateModule]: migrateMain,
  },
});

/** Issues as a failure says them: `path: message`, never a value. */
const issuesOf = (
  issues: readonly {
    readonly path?: readonly unknown[];
    readonly message: string;
  }[]
): string[] =>
  issues
    .slice(0, 20)
    .map(({ path = [], message }) =>
      path.length === 0 ? message : `${path.map(String).join(".")}: ${message}`
    );

/** The strict object of `fields`, as a descriptor's JSON text. */
const objectText = (fields: Readonly<Record<string, unknown>>): string =>
  JSON.stringify({
    descriptorVersion: 1,
    kind: "object",
    presence: "required",
    nullable: false,
    fields,
  });

const isObject = (json: Json | undefined): json is Record<string, Json> =>
  typeof json === "object" && json !== null && !Array.isArray(json);

/** What `schema` makes of `value`, as JSON fields, or its issues. */
const validated = (
  schema: ReturnType<typeof schemaFromDescriptor>,
  value: unknown
): { fields: StoreFields } | { issues: string[] } => {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) {
    return { issues: ["The schema answered asynchronously"] };
  }
  if (result.issues !== undefined) {
    return { issues: issuesOf(result.issues) };
  }
  const json = jsonOf(result.value);
  return isObject(json)
    ? { fields: json }
    : { issues: ["The value isn't an object of fields"] };
};

/** `fields` with only the keys `keep` holds. */
const picked = (
  fields: StoreFields,
  keep: (key: string) => boolean
): StoreFields =>
  Object.fromEntries(Object.entries(fields).filter(([key]) => keep(key)));

/**
 * `answered` without the keys the target doesn't declare that it hands
 * back exactly as the record stores them: a handler that spreads its row
 * (`{ ...row, category }`) passes a retained field through, which the
 * merge keeps anyway. Any other key the target doesn't declare stays, for
 * the strict validation to refuse.
 */
const passedThrough = (
  answered: unknown,
  stored: StoreFields,
  declared: Readonly<Record<string, unknown>>
): unknown => {
  if (
    typeof answered !== "object" ||
    answered === null ||
    Array.isArray(answered)
  ) {
    return answered;
  }
  return Object.fromEntries(
    Object.entries(answered).filter(([key, value]) => {
      if (Object.hasOwn(declared, key) || !Object.hasOwn(stored, key)) {
        return true;
      }
      const json = jsonOf(value);
      const kept = stored[key];
      return (
        json === undefined ||
        kept === undefined ||
        canonicalJson(json) !== canonicalJson(kept)
      );
    })
  );
};

/** The rows as the handler gets them: validated against `input`, if declared. */
const handedRows = (
  declared: MigrationManifest,
  rows: readonly TransformRow[]
): { rows: TransformRow[] } | { failure: TransformFailure } => {
  if (declared.input === null) {
    return { rows: [...rows] };
  }
  const { input } = declared;
  if (input.kind !== "object") {
    throw new Error("A migration's input isn't an object");
  }
  const schema = schemaFromDescriptor(JSON.stringify(input));
  const handed: TransformRow[] = [];
  for (const row of rows) {
    // Only the fields `input` declares: a record may hold others (kept for
    // another version), which a strict object would refuse.
    const checked = validated(
      schema,
      picked(row.fields, (key) => Object.hasOwn(input.fields, key))
    );
    if ("issues" in checked) {
      return {
        failure: {
          id: row.id,
          reason: "invalid_input",
          issues: checked.issues,
        },
      };
    }
    handed.push({ id: row.id, owner: row.owner, fields: checked.fields });
  }
  return { rows: handed };
};

/** What the isolate answered, read as the runner's answer, or why not. */
const answerOf = (
  text: unknown,
  count: number
):
  | { ok: true; rows: unknown[] }
  | { ok: false; index: number; message: string }
  | undefined => {
  if (
    typeof text !== "string" ||
    encoder.encode(text).byteLength > transformAnswerMaxBytes
  ) {
    return undefined;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const ok: unknown = Reflect.get(data, "ok");
  if (ok === true) {
    const rows: unknown = Reflect.get(data, "rows");
    return Array.isArray(rows) && rows.length === count
      ? { ok: true, rows }
      : undefined;
  }
  const index: unknown = Reflect.get(data, "index");
  const message: unknown = Reflect.get(data, "message");
  return ok === false &&
    typeof index === "number" &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < count &&
    typeof message === "string"
    ? { ok: false, index, message: message.slice(0, 500) }
    : undefined;
};

/**
 * Refuses a batch only a caller's bug sends: past its bounds, holding a
 * managed field, or mixing owners of a table whose read or write access
 * is `owner` (see the header).
 */
const requireBatch = (
  managed: readonly string[],
  access: { readonly read: string; readonly write: string },
  rows: readonly TransformRow[]
): void => {
  if (
    rows.length > transformBatchMaxRows ||
    transformBatchBytes(rows.map(({ fields }) => canonicalJson(fields))) >
      transformBatchMaxBytes
  ) {
    throw new Error("A transform's batch is past its bounds");
  }
  if (
    rows.some(({ fields }) => managed.some((key) => Object.hasOwn(fields, key)))
  ) {
    throw new Error("A transform's rows hold managed fields");
  }
  const owned = access.read === "owner" || access.write === "owner";
  if (owned && new Set(rows.map(({ owner }) => owner)).size > 1) {
    throw new Error(
      "A transform's batch of a table with owner access mixes owners"
    );
  }
};

/**
 * Runs migration `name` of `release` on `rows` (at most
 * `transformBatchMaxRows`, `transformBatchMaxBytes` of JSON): each
 * record's fields after it, in order, the transform's output validated
 * against the target table and merged over the fields the target doesn't
 * declare; or the failure, naming the record. Throws
 * `SandboxUnavailableError` when the sandbox didn't answer, and an error
 * for a batch past its bounds or a migration the release doesn't declare,
 * which only a bug in the caller sends.
 */
export const transformBatch = async (
  env: SandboxedEnv,
  release: TransformRelease,
  name: string,
  rows: readonly TransformRow[]
): Promise<TransformOutcome> => {
  const declared = Object.hasOwn(release.app.migrations, name)
    ? release.app.migrations[name]
    : undefined;
  if (declared === undefined) {
    throw new Error(`The release declares no migration ${name}`);
  }
  const target = Object.hasOwn(release.app.schema.tables, declared.table)
    ? release.app.schema.tables[declared.table]
    : undefined;
  if (target === undefined) {
    throw new Error("A migration's table isn't in its release's schema");
  }
  requireBatch(release.app.schema.managedFields, target.access, rows);
  if (rows.length === 0) {
    return { ok: true, rows: [] };
  }
  const handed = handedRows(declared, rows);
  if ("failure" in handed) {
    return { ok: false, failure: handed.failure };
  }

  let text: unknown;
  try {
    text = await callSandboxed(
      env,
      transformIsolate(release, {
        name,
        rows: handed.rows.map(({ id, fields }) => ({ id, fields })),
      }),
      "Migrate",
      "run"
    );
  } catch (error) {
    if (error instanceof SandboxUnavailableError) {
      throw error;
    }
    // The App's code failed outside a handler (its modules threw as they
    // loaded, or the sandbox ended it): no record is to blame.
    return {
      ok: false,
      failure: {
        id: null,
        reason: "invalid_answer",
        issues: [(error instanceof Error ? error.message : "").slice(0, 500)],
      },
    };
  }
  const answer = answerOf(text, rows.length);
  if (answer === undefined) {
    return {
      ok: false,
      failure: {
        id: null,
        reason: "invalid_answer",
        issues: ["The migration answered something that isn't its rows"],
      },
    };
  }
  if (!answer.ok) {
    return {
      ok: false,
      failure: {
        id: rows[answer.index]?.id ?? "",
        reason: "threw",
        issues: [answer.message],
      },
    };
  }

  const output = schemaFromDescriptor(objectText(target.fields));
  const transformed: TransformRow[] = [];
  for (const [index, row] of rows.entries()) {
    const checked = validated(
      output,
      passedThrough(answer.rows[index], row.fields, target.fields)
    );
    if ("issues" in checked) {
      return {
        ok: false,
        failure: {
          id: row.id,
          reason: "invalid_output",
          issues: checked.issues,
        },
      };
    }
    const fields = {
      ...picked(row.fields, (key) => !Object.hasOwn(target.fields, key)),
      ...checked.fields,
    };
    if (encoder.encode(canonicalJson(fields)).byteLength > documentMaxBytes) {
      return {
        ok: false,
        failure: {
          id: row.id,
          reason: "too_large",
          issues: [`A record holds at most ${documentMaxBytes} bytes`],
        },
      };
    }
    transformed.push({ id: row.id, owner: row.owner, fields });
  }
  return { ok: true, rows: transformed };
};

/** The ID a fixture's record has as its migration runs on it. */
const fixtureId = (index: number): string => `fixture-${index + 1}`;

/** The owner of every fixture's record: one owner, as a batch requires. */
const fixtureOwner = "fixture";

/** `fields`, only the keys `declared` holds. */
const declaredFields = (
  fields: StoreFields,
  declared: Readonly<Record<string, unknown>>
): StoreFields => picked(fields, (key) => Object.hasOwn(declared, key));

/**
 * What running migration `declared` of `release` on its fixtures found
 * (see `MigrationEvidence`): each fixture as a record of its own, through
 * `transformBatch` as records are, its output compared with what the
 * fixture expects, when it says. Throws `SandboxUnavailableError` when the
 * sandbox didn't answer, which is never the App's failure.
 */
const fixtureEvidence = async (
  env: SandboxedEnv,
  release: TransformRelease,
  declared: MigrationManifest
): Promise<MigrationEvidence> => {
  const { name, table, fromSchema, toSchema, fixtures } = declared;
  const base = {
    migration: name,
    table,
    fromSchema,
    toSchema,
    fixturesHash: await sha256Hex(canonicalText(fixtures)),
    fixtures: fixtures.length,
  };
  const failed = (
    fixture: number | null,
    reason: NonNullable<MigrationEvidence["failure"]>["reason"],
    issues: readonly string[]
  ): MigrationEvidence => ({
    ...base,
    passed: false,
    failure: {
      fixture,
      reason,
      issues: issues.slice(0, 20).map((issue) => issue.slice(0, 500)),
    },
  });
  const managed = release.app.schema.managedFields;
  const holding = fixtures.findIndex(({ row }) =>
    managed.some((key) => Object.hasOwn(row, key))
  );
  if (holding !== -1) {
    return failed(holding, "invalid_input", [
      "A fixture's row holds a managed field, which the store keeps itself",
    ]);
  }
  const rows = fixtures.map(({ row }, index) => ({
    id: fixtureId(index),
    owner: fixtureOwner,
    fields: row,
  }));
  const outcome = await transformBatch(env, release, name, rows);
  if (!outcome.ok) {
    const { id, reason, issues } = outcome.failure;
    const index = rows.findIndex((row) => row.id === id);
    return failed(index === -1 ? null : index, reason, issues);
  }
  const target = release.app.schema.tables[table]?.fields ?? {};
  for (const [index, { expect: expected }] of fixtures.entries()) {
    const answered = outcome.rows[index];
    if (expected !== null && answered !== undefined) {
      const actual = canonicalJson(declaredFields(answered.fields, target));
      const wanted = canonicalJson(expected);
      if (actual !== wanted) {
        return failed(index, "unexpected_output", [
          `It answered ${actual}`,
          `The fixture expects ${wanted}`,
        ]);
      }
    }
  }
  return { ...base, passed: true, failure: null };
};

/**
 * What running each of `release`'s explicit migrations on its fixtures
 * found, in the order the App declares them: what the seal records in
 * the release's manifest (app-releases.ts). One migration after the
 * other, each in a fresh isolate.
 */
export const migrationEvidence = async (
  env: SandboxedEnv,
  release: TransformRelease
): Promise<MigrationEvidence[]> => {
  const found: MigrationEvidence[] = [];
  for (const declared of Object.values(release.app.migrations)) {
    // One sandbox call at a time: an App declares at most 16.
    // oxlint-disable-next-line no-await-in-loop -- see above
    found.push(await fixtureEvidence(env, release, declared));
  }
  return found;
};

/**
 * Whether `evidence` is what running `migrations`' fixtures records: one
 * entry per migration, by its name (a manifest read back from canonical
 * text lists its migrations in another order than declared), naming its
 * table, its schemas and its fixtures as declared. A sealed manifest
 * whose evidence isn't is corrupt.
 */
export const evidenceFits = async (
  migrations: Readonly<Record<string, MigrationManifest>>,
  evidence: readonly MigrationEvidence[]
): Promise<boolean> => {
  const declared = Object.values(migrations);
  if (declared.length !== evidence.length) {
    return false;
  }
  const hashes = await Promise.all(
    declared.map(
      async ({ fixtures }) => await sha256Hex(canonicalText(fixtures))
    )
  );
  const byName = new Map(evidence.map((found) => [found.migration, found]));
  return declared.every((migration, index) => {
    const found = byName.get(migration.name);
    return (
      found !== undefined &&
      found.migration === migration.name &&
      found.table === migration.table &&
      found.fromSchema === migration.fromSchema &&
      found.toSchema === migration.toSchema &&
      found.fixtures === migration.fixtures.length &&
      found.fixturesHash === hashes[index]
    );
  });
};

/**
 * Refuses a release whose migrations don't transform to its own schema
 * (`version.invalid_migration`, naming the migration and the hash it must
 * name): what a reviewer approves with the release is a transform to
 * exactly the schema it seals. Which schema records are transformed from
 * is the store's to check: only it knows the schemas it recorded.
 */
export const requireMigrationsTarget = (
  migrations: Readonly<Record<string, MigrationManifest>>,
  schema: string
): void => {
  for (const declared of Object.values(migrations)) {
    if (declared.toSchema !== schema) {
      throw versionErrors.create("version.invalid_migration", {
        migration: declared.name,
        toSchema: schema,
      });
    }
  }
};
