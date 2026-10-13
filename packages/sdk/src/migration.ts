import { canonicalText } from "@grasp-os/shared/json";
import { valueDepth } from "@grasp-os/shared/value-depth";

import { isPlainObject, unsafeKeys } from "./value-descriptor.ts";
import type {
  FrozenJson,
  JsonValue,
  ValueDescriptor,
} from "./value-descriptor.ts";
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
//
// A migration carries fixtures: records it is run on as its release is
// sealed, before it touches the store (spec 17.2's representative
// fixtures). Each fixture's output must fit the target table, and match
// what it `expect`s when it says; a fixture that fails refuses the seal.
// They are data the reviewer reads with the migration, never real records.

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

/** The target table's fields a fixture expects after the transform. */
type ExpectedOf<Output> = Output extends AnySchema ? Infer<Output> : never;

/** A fixture's row: what `input` accepts when declared, else stored JSON. */
type FixtureRowOf<Input> = Input extends AnySchema
  ? InferInput<Input>
  : Readonly<Record<string, JsonValue>>;

/** One record a migration is run on before it runs on the store. */
export interface MigrationFixture<Row, Expected> {
  /** The record's fields, as the store would hand them to the transform. */
  readonly row: Row;
  /**
   * The target table's fields after the transform, exactly. Left out, the
   * output only has to fit the table.
   */
  readonly expect?: Expected;
}

/** The most fixtures a migration declares. */
export const migrationMaxFixtures = 16;

/** The most bytes a migration's fixtures take as canonical JSON. */
export const migrationFixturesMaxBytes = 64 * 1024;

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
  /**
   * The records it is run on as its release is sealed: at least one, at
   * most `migrationMaxFixtures`. Any that fails refuses the seal.
   */
  readonly fixtures: readonly MigrationFixture<
    FixtureRowOf<Input>,
    ExpectedOf<Output>
  >[];
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
  /** Its fixtures, as data: `expect` null when one expects nothing exact. */
  readonly fixtures: readonly MigrationFixtureManifest[];
}

/** A fixture as the manifest records it. */
export interface MigrationFixtureManifest {
  readonly row: Readonly<Record<string, FrozenJson>>;
  readonly expect: Readonly<Record<string, FrozenJson>> | null;
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
  "fixtures",
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

const fixtureKeys: ReadonlySet<string> = new Set(["row", "expect"]);

/**
 * `value` as frozen JSON, copied: plain objects, arrays, strings, finite
 * numbers, booleans and null, nested at most `valueDepth` levels, no key
 * that reaches a prototype; refused (naming `what`) otherwise.
 */
const frozenJson = (value: unknown, what: string, depth = 1): FrozenJson => {
  if (depth > valueDepth) {
    return refuse(`${what} nests deeper than ${valueDepth} levels.`);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((item) => frozenJson(item, what, depth + 1))
    );
  }
  if (isPlainObject(value)) {
    const copy: Record<string, FrozenJson> = {};
    for (const [key, member] of Object.entries(value)) {
      if (unsafeKeys.has(key)) {
        return refuse(`${what} holds the key \`${key}\`.`);
      }
      Object.defineProperty(copy, key, {
        enumerable: true,
        value: frozenJson(member, what, depth + 1),
      });
    }
    return Object.freeze(copy);
  }
  return refuse(`${what} is JSON data only.`);
};

/** A fixture's object of fields (`what` names it), as frozen JSON. */
const fixtureFields = (
  value: unknown,
  what: string
): Readonly<Record<string, FrozenJson>> => {
  if (!isPlainObject(value)) {
    return refuse(`${what} is an object of fields.`);
  }
  const fields = frozenJson(value, what);
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    return refuse(`${what} is an object of fields.`);
  }
  // SAFETY: a plain object copied as one, checked just above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return fields as Readonly<Record<string, FrozenJson>>;
};

/** A migration's fixtures, checked and copied as the manifest records them. */
const fixturesOf = (fixtures: unknown): MigrationFixtureManifest[] => {
  if (
    !Array.isArray(fixtures) ||
    fixtures.length === 0 ||
    fixtures.length > migrationMaxFixtures
  ) {
    return refuse(
      `A migration's \`fixtures\` lists between 1 and ${migrationMaxFixtures} records it is checked against: \`{ row, expect? }\`.`
    );
  }
  const read = fixtures.map((fixture: unknown, index) => {
    const what = `Fixture ${index + 1}`;
    if (!isPlainObject(fixture)) {
      return refuse(`${what} is \`{ row, expect? }\`.`);
    }
    for (const key of Object.keys(fixture)) {
      if (!fixtureKeys.has(key)) {
        refuse(`${what} has no \`${key}\`.`);
      }
    }
    return Object.freeze({
      row: fixtureFields(dataOf(fixture, "row"), `${what}'s \`row\``),
      expect:
        dataOf(fixture, "expect") === undefined
          ? null
          : fixtureFields(dataOf(fixture, "expect"), `${what}'s \`expect\``),
    });
  });
  if (
    new TextEncoder().encode(canonicalText(read)).byteLength >
    migrationFixturesMaxBytes
  ) {
    refuse(
      `A migration's \`fixtures\` take at most ${migrationFixturesMaxBytes} bytes of JSON.`
    );
  }
  return read;
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
  const fixtures = dataOf(definition, "fixtures");
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
    fixtures: Object.freeze(fixturesOf(fixtures)),
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
