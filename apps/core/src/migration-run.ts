import {
  appModuleName,
  kitModuleName,
  serverRunner,
  serverEntryPath,
} from "@grasp-os/compiler";
import {
  migrationPlatformMessages,
  schemaFromDescriptor,
} from "@grasp-os/runtime/host";
import type { MigrationManifest } from "@grasp-os/runtime/host";
import { versionErrors } from "@grasp-os/shared/app-releases";
import type { MigrationEvidence } from "@grasp-os/shared/app-releases";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { jsonOf } from "@grasp-os/shared/functions";
import {
  canonicalJson,
  canonicalText,
  definedFields,
  isRecord,
} from "@grasp-os/shared/json";
import { documentMaxBytes, migrationErrors } from "@grasp-os/shared/stores";
import type { StoreFields } from "@grasp-os/shared/stores";

import type { Release } from "./app-releases.ts";
import type { OpenStore } from "./data-stores.ts";
import { callSandboxed, SandboxUnavailableError } from "./sandboxed.ts";
import type { SandboxedEnv, SandboxedWorker } from "./sandboxed.ts";
import type { SchemaIds } from "./schema-changes.ts";
import type { HeldTable } from "./store-host.ts";
import { audienceKey, audienceOf } from "./store-rules.ts";
import type { Audience } from "./store-rules.ts";

// Running an App's explicit migrations (spec 17.2): on their fixtures as
// the release is sealed (`migrationEvidence`), and once on the store's
// records as the version is published (`runMigrations`), its output staged
// in the store and applied with the schema in one transaction
// (store-host.ts, `applySchema`), so a migration that fails anywhere
// changes nothing. The transform is App code, so it runs only in an
// isolate with no env and no network, on the sandbox host on-prem
// (`callSandboxed`), and nothing it answers is trusted. Threat model, and
// how each is closed:
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
//   (fields the schema keeps though it left them out): they are kept
//   outside it and merged back; handed back unchanged they pass, changed
//   they are refused. A field renamed in the same publish leaves its old
//   name as the store applies the output.
// - A row the transform wasn't written for: when it declares `input`, each
//   row is validated against it first, and a row that doesn't fit fails
//   the batch naming the record, before any App code sees it.
// - The transform throws, loops or answers too much: its failure names the
//   row, the sandbox ends it at its deadline (a refusal of the App's code,
//   as at inspection), and an answer past `transformAnswerMaxBytes` is
//   refused. A sandbox that didn't answer at all is
//   `SandboxUnavailableError`, never the App's failure.
// - The transform carries one person's or team's data into a record
//   others see: module state survives between the rows of one call (a
//   fresh isolate per call ends it between calls), so a batch holds rows
//   of one audience only (store-rules.ts, `audienceKey`): one owner's on a
//   table whose access mode or a rule reads the owner, and one value of
//   each field its row rules read. Each row carries its owner, which the
//   host supplies and the handler never sees, and a batch that mixes
//   audiences is refused as a caller's bug. A migration still reads and
//   rewrites every record of its table, whoever may read it: the version
//   review says so.
// - The transform moves a record into other people's sight by rewriting a
//   field a row rule reads (a team, an assignee): refused (`rule_changed`)
//   by the store as it applies the output, by each field's stable ID
//   (store-host.ts), so a field renamed in the same change is compared
//   with itself; it also refuses one that rewrites a reference behind its
//   reference index (`reference_changed`). Not here: a transform sees
//   field names only, which a rename changes. Who a record reaches
//   changes only through writes, which pass the rules before and after.
//   A transform answers only for the records of its own table it was
//   handed, never another table's, so it can't move rows into a table
//   whose rules admit more people.
// - The transform writes a record's values into its failure, which the
//   migration's builders are shown as their publish fails, though the
//   table may keep the record from them: in what it throws
//   (`throw new Error(row.amount)`), in a key its output holds
//   (`{ [row.amount]: 1 }`, which validation names), in a stack it forges
//   (a line or column of its choosing). On records of any table but one
//   every member or builder reads whole (`hidesText`: read access
//   `appMembers` or `appBuilders`, no row rules), nothing App code can
//   influence is shown: a handler's failure is a fixed message
//   (`threwOnRecord`), with no stack or place; an output or input that
//   doesn't fit is a fixed message and the declared fields it fails on
//   (`shownIssues`); a failure outside a handler is a fixed message, or
//   one of the sandbox's verdicts as a fixed text (`verdictOf`). The SDK's
//   own refusals (`migrationPlatformMessages`) are fixed texts and pass.
//   What still tells something, inherently: the failure names its record
//   (its ID), and which of a batch's N records fails says about log2(N)
//   bits, once per failed run, with a few more in its reason and which
//   declared fields it fails on. A table read whole keeps the message, and
//   so do fixtures, the App's own data (`transformRows`).
// - The transform answers differently each time: randomness and clocks
//   are taken away while it runs and while its answer is serialized (sdk
//   runner, `runMigration`). Best effort, not a boundary: it runs once on
//   each record, and what it answered is what is applied.
// - A transform that answers wrong (valid for the table, but not what was
//   meant) rewrites real records before anyone notices: it runs on its
//   fixtures first, as its release is sealed (`migrationEvidence`), and
//   only one whose fixtures all passed runs on records
//   (`requireMigrationEvidence`). Fixtures are the App's own data, reviewed
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

/**
 * Rows one batch transforms, at most, and the bytes they take as JSON:
 * what one call into the sandbox holds. A page of the store's records
 * (`StoreHost.migrationRows`) stays within both.
 */
export const transformBatchMaxRows = 100;
const transformBatchMaxBytes = 2 * 1024 * 1024;

const encoder = new TextEncoder();

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

/** A table of a release's schema, as a transform's checks read it. */
type TransformTable = TransformRelease["app"]["schema"]["tables"][string];

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

/** What the isolate's main module fails with for an answer past its bound. */
const answerTooLarge = "The migration's answer is too large.";

/** What a handler's failure says on a table whose rows reach some people only. */
export const threwOnRecord = "The migration's transform threw on this record.";

/** What a row that doesn't fit the migration's input says on such a table. */
export const inputMismatch = "A record doesn't fit the migration's input.";

/** What an output that doesn't fit the table says on such a table. */
export const outputMismatch =
  "The migration's output for this record doesn't fit its table.";

/** What a failure outside a handler says on such a table. */
export const failedOutside =
  "The migration's code failed outside its handler, as its modules loaded or as it answered.";

/**
 * The sandbox's own verdicts on a call (scripts/workerd-sandbox.ts, the
 * Loader's limits), by a phrase of theirs, each as a fixed text. A message
 * App code threw can hold the phrase too: then it is only ever told as
 * the fixed text, which holds nothing of a row.
 */
const sandboxVerdicts: readonly (readonly [string, string])[] = [
  [answerTooLarge, answerTooLarge],
  ["ran past its time", "The App's code ran past its time."],
  ["answered too much", "The App's code answered too much."],
  ["of memory", "The App's code used more memory than it may."],
  ["CPU time", "The App's code used more than its CPU time."],
];

/** `message` as a sandbox verdict's fixed text, when it holds one's phrase. */
const verdictOf = (message: string): string =>
  sandboxVerdicts.find(([phrase]) => message.includes(phrase))?.[1] ?? message;

/** Fixed texts of the platform's own, shown for any table. */
const platformMessages = new Set([
  ...migrationPlatformMessages,
  ...sandboxVerdicts.map(([, fixed]) => fixed),
]);

/**
 * The transform isolate's main module: the batch through the SDK's
 * runner, its answer as bounded JSON text. Untrusted like everything in
 * the isolate; it only bounds what it hands back.
 */
const migrateMain = `import ${JSON.stringify(quietModule)};
import { WorkerEntrypoint } from "cloudflare:workers";
import { runMigration } from ${JSON.stringify(kitModuleName(serverRunner))};
import registered from ${JSON.stringify(appModuleName(serverEntryPath))};
import request from ${JSON.stringify(requestModule)};

export class Migrate extends WorkerEntrypoint {
  run() {
    const text = JSON.stringify(runMigration(registered, request));
    if (typeof text !== "string" || text.length > ${transformAnswerMaxBytes}) {
      throw new Error(${JSON.stringify(answerTooLarge)});
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

/** What `schema` makes of `value`, as JSON fields, or its issues. */
const validated = (
  schema: ReturnType<typeof schemaFromDescriptor>,
  value: unknown
):
  | { fields: StoreFields }
  | { issues: string[]; named: readonly unknown[] } => {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) {
    return { issues: ["The schema answered asynchronously"], named: [] };
  }
  if (result.issues !== undefined) {
    return {
      issues: issuesOf(result.issues),
      named: result.issues.map(({ path }) => path[0]),
    };
  }
  const json = jsonOf(result.value);
  return isRecord(json)
    ? { fields: definedFields(json) }
    : { issues: ["The value isn't an object of fields"], named: [] };
};

/**
 * Issues where `hidden` (`hidesText`): a fixed text and the fields of
 * `declared` that `named` names, never a key or message the value made
 * (an undeclared key the output holds is named in its issue's path, and
 * App code chose it). Otherwise `issues` as they are.
 */
const shownIssues = (
  hidden: boolean,
  checked: { issues: string[]; named: readonly unknown[] },
  declared: Readonly<Record<string, unknown>>,
  fixed: string
): string[] => {
  if (!hidden) {
    return checked.issues;
  }
  const fields = [
    ...new Set(
      checked.named.filter(
        (name): name is string =>
          typeof name === "string" && Object.hasOwn(declared, name)
      )
    ),
  ];
  return [fixed, ...fields.map((field) => `${field}: doesn't fit`)];
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
  rows: readonly TransformRow[],
  hidden: boolean
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
          issues: shownIssues(hidden, checked, input.fields, inputMismatch),
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
 * Whether what a failure on `of` of `table` says is kept to fixed texts
 * (see the header): on records of any table but one every member, or
 * every builder, reads whole (read access `appMembers` or `appBuilders`,
 * no row rules). Never for fixtures, which are the App's own data.
 */
const hidesText = (
  table: TransformTable,
  of: "records" | "fixtures"
): boolean => {
  const readWhole =
    (table.access.read === "appMembers" ||
      table.access.read === "appBuilders") &&
    table.rules === undefined;
  return of === "records" && !readWhole;
};

/**
 * What a failure says of `message` (App code's, unless one of the
 * platform's own): all of it, or `fixed` only where `hidden`
 * (`hidesText`).
 */
const failureIssues = (
  hidden: boolean,
  message: string,
  fixed: string
): string[] => (!hidden || platformMessages.has(message) ? [message] : [fixed]);

/**
 * Refuses a batch only a caller's bug sends: past its bounds, holding a
 * managed field, or mixing rows of different `audience`s (see the header).
 */
const requireBatch = (
  managed: readonly string[],
  audience: Audience,
  rows: readonly TransformRow[]
): void => {
  if (
    rows.length > transformBatchMaxRows ||
    encoder.encode(JSON.stringify(rows.map(({ fields }) => fields)))
      .byteLength > transformBatchMaxBytes
  ) {
    throw new Error("A transform's batch is past its bounds");
  }
  if (
    rows.some(({ fields }) => managed.some((key) => Object.hasOwn(fields, key)))
  ) {
    throw new Error("A transform's rows hold managed fields");
  }
  if (new Set(rows.map((row) => audienceKey(audience, row))).size > 1) {
    throw new Error(
      "A transform's batch mixes rows its table shows to different people"
    );
  }
};

/**
 * Runs migration `name` of `release` on `rows` (one audience's, at most
 * `transformBatchMaxRows`, `transformBatchMaxBytes` of JSON): each
 * record's fields after it, in order, the transform's output validated
 * against the target table and merged over the fields the target doesn't
 * declare; or the failure, naming the record. On the migration's own
 * `fixtures`, the App's data, what its code threw is shown as it said,
 * whatever the table. Throws `SandboxUnavailableError` when the sandbox
 * didn't answer, and an error for a batch past its bounds or a migration
 * the release doesn't declare, which only a bug in the caller sends.
 */
const transformRows = async (
  env: SandboxedEnv,
  release: TransformRelease,
  name: string,
  rows: readonly TransformRow[],
  of: "records" | "fixtures",
  audience?: Audience
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
  requireBatch(
    release.app.schema.managedFields,
    audience ?? audienceOf(target),
    rows
  );
  if (rows.length === 0) {
    return { ok: true, rows: [] };
  }
  const hidden = hidesText(target, of);
  const handed = handedRows(declared, rows, hidden);
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
    // loaded, or the sandbox ended it): no record is to blame. The
    // sandbox's message may carry what the App's code threw.
    const message = (error instanceof Error ? error.message : "").slice(0, 500);
    return {
      ok: false,
      failure: {
        id: null,
        reason: "invalid_answer",
        issues: failureIssues(
          hidden,
          hidden ? verdictOf(message) : message,
          failedOutside
        ),
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
        issues: failureIssues(hidden, answer.message, threwOnRecord),
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
          issues: shownIssues(hidden, checked, target.fields, outputMismatch),
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

/**
 * `transformRows` of `rows` that are the store's records, all of one
 * `audience`: by the names the store holds the fields under, which a
 * rename in the same change moves (`storedAudience`); the target table's
 * own when none is renamed.
 */
export const transformBatch = async (
  env: SandboxedEnv,
  release: TransformRelease,
  name: string,
  rows: readonly TransformRow[],
  audience?: Audience
): Promise<TransformOutcome> =>
  await transformRows(env, release, name, rows, "records", audience);

/** The ID a fixture's record has as its migration runs on it. */
const fixtureId = (index: number): string => `fixture-${index + 1}`;

/** The owner of every fixture's record: the App's own data, no one's. */
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
  const target = Object.hasOwn(release.app.schema.tables, table)
    ? release.app.schema.tables[table]
    : undefined;
  if (target === undefined) {
    throw new Error("A migration's table isn't in its release's schema");
  }
  // Fixtures of different audiences run as records do, a batch for each
  // (`requireBatch`), each in its own isolate.
  const audience = audienceOf(target);
  const batches = Map.groupBy(rows, (row) => audienceKey(audience, row));
  const answered = new Map<string, TransformRow>();
  for (const batch of batches.values()) {
    // One sandbox call at a time, as for each migration (below).
    // oxlint-disable-next-line no-await-in-loop -- see above
    const outcome = await transformRows(env, release, name, batch, "fixtures");
    if (!outcome.ok) {
      const { id, reason, issues } = outcome.failure;
      const index = rows.findIndex((row) => row.id === id);
      return failed(index === -1 ? null : index, reason, issues);
    }
    for (const row of outcome.rows) {
      answered.set(row.id, row);
    }
  }
  for (const [index, { expect: expected }] of fixtures.entries()) {
    const transformed = answered.get(fixtureId(index));
    if (expected !== null && transformed !== undefined) {
      const actual = canonicalJson(
        declaredFields(transformed.fields, target.fields)
      );
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

/**
 * The evidence of the first of `migrations` whose fixtures failed as
 * `release` was sealed; undefined when they all passed.
 */
const failedEvidence = (
  evidence: readonly MigrationEvidence[],
  migrations: readonly string[]
): MigrationEvidence | undefined =>
  evidence.find(
    (found) => !found.passed && migrations.includes(found.migration)
  );

/**
 * `version.migration_fixtures_failed` for `evidence`: the migration, the
 * fixture (counted from 1, as its author reads them; null when none is to
 * blame) and why. Fixtures are the App's own data, so this is safe to
 * show whoever publishes the version.
 */
const fixturesFailedError = (evidence: MigrationEvidence): Error =>
  versionErrors.create("version.migration_fixtures_failed", {
    migration: evidence.migration,
    fixture:
      evidence.failure?.fixture === null ||
      evidence.failure?.fixture === undefined
        ? null
        : evidence.failure.fixture + 1,
    reason: evidence.failure?.reason ?? null,
    issues: [...(evidence.failure?.issues ?? [])],
  });

/**
 * Refuses publishing a version while any of its migrations failed on its
 * fixtures as it was sealed (`version.migration_fixtures_failed`), from
 * the release's hash-checked manifest alone.
 */
export const requireMigrationEvidence = (
  evidence: readonly MigrationEvidence[]
): void => {
  const failed = evidence.find(({ passed }) => !passed);
  if (failed !== undefined) {
    throw fixturesFailedError(failed);
  }
};

/** A migration's output staged in the store, as `applySchema` applies it. */
export interface StagedMigration {
  readonly id: string;
  /** The schema it transforms from: the one the store held. */
  readonly from: string;
  /** The tables it transforms, by the release's names. */
  readonly tables: string[];
}

/**
 * Who sees each record of a migrated table, by the names the store holds
 * its fields under (`held`): the target table's rule fields found by
 * stable ID (`ids`), a field renamed in the same change under its stored
 * name, and the rule fields of the schema in force; the owner where
 * either reads it. So rows are grouped by who sees them now and after,
 * whatever a rename moves.
 */
const storedAudience = (
  target: TransformTable,
  ids: SchemaIds[string],
  held: HeldTable | undefined
): Audience => {
  const after = audienceOf(target);
  const stored = after.fields.flatMap((name) => {
    const id = Object.hasOwn(ids.fields, name) ? ids.fields[name] : undefined;
    const was =
      id !== undefined && held !== undefined && Object.hasOwn(held.names, id)
        ? held.names[id]
        : undefined;
    // A rule field the store doesn't hold yet: absent from every record.
    return was === undefined ? [] : [was];
  });
  return {
    owner: after.owner || held?.audience.owner === true,
    fields: [...new Set([...stored, ...(held?.audience.fields ?? [])])],
  };
};

/** `runMigrations` for one migration (`declared`) of its table. */
const runMigration = async (
  env: SandboxedEnv,
  store: Pick<OpenStore, "migrationRows" | "stageMigration">,
  release: TransformRelease,
  {
    declared,
    migrationId,
    ids,
    held,
  }: {
    declared: MigrationManifest;
    migrationId: string;
    ids: SchemaIds[string] | undefined;
    held: HeldTable | undefined;
  }
): Promise<void> => {
  const target = release.app.schema.tables[declared.table];
  if (target === undefined || ids === undefined) {
    throw new Error("A migration's table isn't in its release's schema");
  }
  const tableId = ids.id;
  const audience = storedAudience(target, ids, held);
  let after: string | null = null;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one page at a time
    const rows = await store.migrationRows(tableId, after);
    if (rows.length === 0) {
      return;
    }
    after = rows.at(-1)?.id ?? null;
    const revisions = new Map(rows.map(({ id, revision }) => [id, revision]));
    for (const batch of Map.groupBy(rows, (row) =>
      audienceKey(audience, row)
    ).values()) {
      // oxlint-disable-next-line no-await-in-loop -- one audience at a time
      const outcome = await transformBatch(
        env,
        release,
        declared.name,
        batch,
        audience
      );
      if (!outcome.ok) {
        throw migrationErrors.create("migration.failed", {
          migration: declared.name,
          table: declared.table,
          id: outcome.failure.id,
          reason: outcome.failure.reason,
          issues: [...outcome.failure.issues],
        });
      }
      // oxlint-disable-next-line no-await-in-loop -- as above
      await store.stageMigration({
        migrationId,
        table: tableId,
        rows: outcome.rows.map(({ id, fields }) => ({
          id,
          revision: revisions.get(id) ?? 0,
          fields,
        })),
      });
    }
  }
};

/**
 * Runs `release`'s migrations from the schema `store` holds (those whose
 * `fromSchema` it is), once, on every record of their tables, a page at a
 * time, each page's records of one audience in an isolate of their own
 * (`audienceKey`), and stages what each answered in the store with the
 * revision it was read at (`StoreHost.stageMigration`). Answers what
 * `applySchema` applies, or undefined when no migration transforms from
 * the schema in force. A migration that fails is `migration.failed`,
 * naming its record and why, as its builders may be shown it
 * (`hidesText`), and nothing of it is applied. `tableIds` gives each of
 * the release's tables its stable ID, which the store finds it by, so a
 * table renamed in the same publish is still read where it is.
 */
export const runMigrations = async (
  env: SandboxedEnv,
  store: Pick<OpenStore, "beginMigration" | "migrationRows" | "stageMigration">,
  release: TransformRelease & {
    readonly manifest: Pick<Release["manifest"], "migrationEvidence">;
  },
  ids: SchemaIds
): Promise<StagedMigration | undefined> => {
  const { migrationId, schemaHash, tables } = await store.beginMigration();
  const due = Object.values(release.app.migrations).filter(
    ({ fromSchema }) => fromSchema === schemaHash
  );
  if (schemaHash === null || due.length === 0) {
    return undefined;
  }
  const failed = failedEvidence(
    release.manifest.migrationEvidence,
    due.map(({ name }) => name)
  );
  if (failed !== undefined) {
    throw fixturesFailedError(failed);
  }
  for (const declared of due) {
    // One migration, one page and one audience at a time: each call
    // into the sandbox is bounded, and a failure stops the rest.
    const tableIds = Object.hasOwn(ids, declared.table)
      ? ids[declared.table]
      : undefined;
    // oxlint-disable-next-line no-await-in-loop -- see above
    await runMigration(env, store, release, {
      declared,
      migrationId,
      ids: tableIds,
      held:
        tableIds !== undefined && Object.hasOwn(tables, tableIds.id)
          ? tables[tableIds.id]
          : undefined,
    });
  }
  return {
    id: migrationId,
    from: schemaHash,
    tables: due.map(({ table }) => table),
  };
};
