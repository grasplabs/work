import { appModuleName, kitModuleName } from "@grasp-os/compiler";
import { schemaFromDescriptor } from "@grasp-os/sdk/host";
import type { MigrationManifest } from "@grasp-os/sdk/host";
import { versionErrors } from "@grasp-os/shared/app-releases";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { jsonOf } from "@grasp-os/shared/operations";
import { documentMaxBytes } from "@grasp-os/shared/stores";
import type { StoreFields } from "@grasp-os/shared/stores";

import type { Release } from "./app-releases.ts";
import { callSandboxed, SandboxUnavailableError } from "./sandboxed.ts";
import type { SandboxedEnv } from "./sandboxed.ts";

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
// - The transform answers differently each time: randomness and clocks
//   are taken away while it runs (sdk runner, `runMigration`); a retried
//   batch is still the store's to answer from its receipt, never twice.

/** Rows one batch transforms, at most (spec 17.2's bounded batches). */
export const transformBatchMaxRows = 100;

/**
 * The most bytes a batch's rows take as JSON: a store's caller cuts its
 * batch before it passes this, so the isolate's call stays bounded.
 */
export const transformBatchMaxBytes = 2 * 1024 * 1024;

/** The most bytes of JSON text a batch's answer may take. */
export const transformAnswerMaxBytes = 4 * 1024 * 1024;

/** One record a batch transforms: its ID and its stored fields. */
export interface TransformRow {
  readonly id: string;
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

const encoder = new TextEncoder();

/** The isolate's main module, and the module its request is in. */
const migrateModule = "grasp-migrate.js";
const requestModule = "grasp-migrate-request.js";

/**
 * The transform isolate's main module: the batch through the SDK's
 * runner, its answer as bounded JSON text. Untrusted like everything in
 * the isolate; it only bounds what it hands back.
 */
const migrateMain = `import { WorkerEntrypoint } from "cloudflare:workers";
import { runMigration } from ${JSON.stringify(kitModuleName("@grasp-os/sdk/runner"))};
import registered from ${JSON.stringify(appModuleName("app.ts"))};
import request from ${JSON.stringify(requestModule)};

export class Migrate extends WorkerEntrypoint {
  run() {
    const text = JSON.stringify(runMigration(registered, JSON.parse(request)));
    if (typeof text !== "string" || text.length > ${transformAnswerMaxBytes}) {
      throw new Error("The migration's answer is too large.");
    }
    return text;
  }
}
`;

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
    handed.push({ id: row.id, fields: checked.fields });
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
  if (
    rows.length > transformBatchMaxRows ||
    encoder.encode(canonicalJson(rows.map(({ fields }) => fields))).byteLength >
      transformBatchMaxBytes
  ) {
    throw new Error("A transform's batch is past its bounds");
  }
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
      {
        mainModule: migrateModule,
        // The platform's modules last: no App module takes one's name.
        modules: {
          ...release.modules,
          ...release.sdk,
          [requestModule]: `export default ${JSON.stringify(
            JSON.stringify({ name, rows: handed.rows })
          )};\n`,
          [migrateModule]: migrateMain,
        },
      },
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
    transformed.push({ id: row.id, fields });
  }
  return { ok: true, rows: transformed };
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
