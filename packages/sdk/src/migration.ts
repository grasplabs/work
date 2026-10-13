import { isPlainObject } from "./value-descriptor.ts";
import type { JsonValue, ValueDescriptor } from "./value-descriptor.ts";
import { descriptorOf } from "./value-schema.ts";
import type { AnySchema } from "./value-schema.ts";
import type { Infer, InferInput } from "./values.ts";

// `migration`: an explicit, typed transform of one table's records from
// one schema to another (spec 17.2), for a change the host can't make on
// its own: deriving a value, a type change, a required field without a
// default. A safe addition (a new table, an optional or defaulted field)
// never needs one: the host plans and backfills it itself.
//
// A definition is a value, like a server function: it runs nothing and
// changes nothing. The App registers it (`app({ migrations })`), the seal
// records it in the App's manifest, so approving the release reviews it,
// and the host runs it, a bounded batch of rows at a time, in an isolate
// with no env, no network and no store: its context is deterministic
// metadata only, and its row the record's fields alone. The host checks
// each row against `input` before the handler sees it, and what the
// handler returns against the target table's fields (which `output` must
// declare exactly), and keeps the record's managed fields itself.

/** What a migration's handler is told besides the row: data only. */
export interface MigrationContext {
  /** The migration's name. */
  readonly migration: string;
  /** The table it transforms. */
  readonly table: string;
  /** The schema hash it transforms records from. */
  readonly fromSchema: string;
  /** The schema hash it transforms records to: its release's. */
  readonly toSchema: string;
  /** The ID of the record whose fields the row holds. */
  readonly id: string;
}

/** The row a handler gets: `input`'s output when declared, else stored JSON. */
type RowOf<Input> = Input extends AnySchema
  ? Infer<Input>
  : Readonly<Record<string, JsonValue>>;

/** What `migration` is declared with. */
export interface MigrationDefinition<
  Input extends AnySchema | undefined,
  Output extends AnySchema,
> {
  /** Its name: lower-case letters, digits and dashes, unique in the App. */
  readonly name: string;
  /** The table of the App's schema it transforms. */
  readonly table: string;
  /** The schema hash records are transformed from, as the store recorded it. */
  readonly fromSchema: string;
  /** The schema hash they are transformed to: the release's own. */
  readonly toSchema: string;
  /**
   * The fields a row must have, as a `v.object`: a row that doesn't fit
   * fails the migration, naming the record, before the handler sees it.
   */
  readonly input?: Input;
  /** The target table's fields, as a `v.object`: exactly what it declares. */
  readonly output: Output;
  /** The transform of one row: pure, and synchronous. */
  readonly handler: (
    ctx: MigrationContext,
    row: RowOf<Input>
  ) => InferInput<Output>;
}

/** A migration as data: what the App's manifest records of it. */
export interface MigrationManifest {
  readonly name: string;
  readonly table: string;
  readonly fromSchema: string;
  readonly toSchema: string;
  /** Its `input`'s descriptor, or null when it declares none. */
  readonly input: ValueDescriptor | null;
  readonly output: ValueDescriptor;
}

/** A declared migration, as `migration` answers it. */
export interface Migration {
  readonly "~migration": MigrationManifest;
}

/** Why a migration's declaration was refused. */
export class MigrationDefinitionError extends Error {
  readonly code = "migration.invalid_definition";

  constructor(message: string) {
    super(message);
    this.name = "MigrationDefinitionError";
  }
}

const refuse = (message: string): never => {
  throw new MigrationDefinitionError(message);
};

/** A migration's name. */
export const migrationNamePattern = /^[a-z][a-z0-9-]{0,63}$/u;

/** A schema hash: SHA-256, lower-case hex. */
const schemaHashPattern = /^[0-9a-f]{64}$/u;

/** A table's name, as the schema has them. */
const tableNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

const definitionKeys: ReadonlySet<string> = new Set([
  "name",
  "table",
  "fromSchema",
  "toSchema",
  "input",
  "output",
  "handler",
]);

/** The handler of each migration declared, by its value. */
const handlers = new WeakMap<object, AnyMigrationHandler>();

/** A handler as the runner calls it. */
export type AnyMigrationHandler = (
  ctx: MigrationContext,
  row: unknown
) => unknown;

/** An object `v.object` declared, required and not nullable: its descriptor. */
const objectDescriptor = (schema: unknown, what: string): ValueDescriptor => {
  // Throws for anything but a `v` schema.
  const descriptor = descriptorOf(schema);
  if (
    descriptor.kind !== "object" ||
    descriptor.nullable ||
    descriptor.presence !== "required"
  ) {
    return refuse(`A migration's \`${what}\` is a required \`v.object\`.`);
  }
  return descriptor;
};

/** Reads `key` of `definition` as a data property: never a getter. */
const dataOf = (definition: object, key: string): unknown => {
  const property = Object.getOwnPropertyDescriptor(definition, key);
  if (property !== undefined && !("value" in property)) {
    return refuse(`A migration's \`${key}\` is a value, not a getter.`);
  }
  return property?.value;
};

/**
 * Declares a migration (see the header): throws `MigrationDefinitionError`
 * for a declaration that isn't one. Whether its table, its hashes and its
 * output fit the App is checked where the App registers it and where the
 * host seals it.
 */
export const migration = <
  const Output extends AnySchema,
  const Input extends AnySchema | undefined = undefined,
>(
  definition: MigrationDefinition<Input, Output>
): Migration => {
  if (!isPlainObject(definition)) {
    return refuse("A migration is declared with an object.");
  }
  for (const key of Object.keys(definition)) {
    if (!definitionKeys.has(key)) {
      refuse(`A migration has no \`${key}\`.`);
    }
  }
  const name = dataOf(definition, "name");
  const table = dataOf(definition, "table");
  const fromSchema = dataOf(definition, "fromSchema");
  const toSchema = dataOf(definition, "toSchema");
  const input = dataOf(definition, "input");
  const output = dataOf(definition, "output");
  const handler = dataOf(definition, "handler");
  if (typeof name !== "string" || !migrationNamePattern.test(name)) {
    refuse(
      "A migration's `name` is lower-case letters, digits and dashes, starting with a letter, at most 64 characters."
    );
  }
  if (typeof table !== "string" || !tableNamePattern.test(table)) {
    refuse("A migration's `table` is the name of a table of the App's schema.");
  }
  if (
    typeof fromSchema !== "string" ||
    !schemaHashPattern.test(fromSchema) ||
    typeof toSchema !== "string" ||
    !schemaHashPattern.test(toSchema)
  ) {
    refuse(
      "A migration's `fromSchema` and `toSchema` are schema hashes: 64 lower-case hexadecimal characters, as the schema diff records them."
    );
  }
  if (fromSchema === toSchema) {
    refuse("A migration's `fromSchema` and `toSchema` differ.");
  }
  if (typeof handler !== "function") {
    refuse("A migration's `handler` is a function `(ctx, row) => row`.");
  }
  const manifest: MigrationManifest = Object.freeze({
    name: String(name),
    table: String(table),
    fromSchema: String(fromSchema),
    toSchema: String(toSchema),
    input: input === undefined ? null : objectDescriptor(input, "input"),
    output: objectDescriptor(output, "output"),
  });
  const made: Migration = Object.freeze({ "~migration": manifest });
  // SAFETY: checked to be a function above; the runner calls it as one.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  handlers.set(made, handler as AnyMigrationHandler);
  return made;
};

/** Whether `value` is a migration `migration` declared. */
export const isMigration = (value: unknown): value is Migration =>
  typeof value === "object" && value !== null && handlers.has(value);

/** The handler of a migration `migration` declared; throws for anything else. */
export const migrationHandler = (value: unknown): AnyMigrationHandler => {
  const handler =
    typeof value === "object" && value !== null
      ? handlers.get(value)
      : undefined;
  if (handler === undefined) {
    return refuse("That isn't a migration `migration` declared.");
  }
  return handler;
};
