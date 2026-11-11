import {
  functionPathMaxLength,
  functionPathMaxSegments,
  functionSegmentPattern,
} from "@grasp-os/shared/function-limits";
import { isPlainObject } from "@grasp-os/shared/json";
import { stableIdPattern } from "@grasp-os/shared/store-limits";
import { z } from "zod";

import { AppDefinitionError } from "./app-definition-error.ts";
import { isOverBytes, refuser } from "./declaration.ts";
import type { AppDefinition, DefinedPermission } from "./definition-types.ts";
import { compactDescriptor, descriptorFromCompact } from "./value-compact.ts";
import { ValueDefinitionError } from "./value-descriptor.ts";
import type { FrozenJson, ValueDescriptor } from "./value-descriptor.ts";

// An App's definition as JSON: the structure its text holds, every
// descriptor in its compact form (value-compact.ts), and its one text,
// which Grasp stores, hashes and compares.

/** The most bytes of a definition's text. */
const definitionMaxBytes = 1024 * 1024;

/** An ID: what a definition names a table or field by, forever. */
const idSchema = z.string().regex(stableIdPattern);

/**
 * Whether `name` is a server function's path as the SDK makes one
 * (app-functions.ts, `checkPath`): its module's path under `server/` and
 * its export's name, each an identifier of letters, digits and `_` not
 * starting with either of the last two, so `__proto__` is never a
 * segment of one, joined by dots, at most as many and as long as a path
 * may be. A seal checks the rest: that the code exports it.
 */
export const isFunctionPath = (name: string): boolean => {
  const segments = name.split(".");
  return (
    segments.length >= 2 &&
    segments.length <= functionPathMaxSegments &&
    name.length <= functionPathMaxLength &&
    segments.every((segment) => functionSegmentPattern.test(segment))
  );
};

const ruleSchema = z.union([
  z.strictObject({ kind: z.literal("owner") }),
  z.strictObject({ kind: z.enum(["person", "team"]), field: idSchema }),
  z.strictObject({
    kind: z.literal("role"),
    role: z.enum(["builder", "user"]),
  }),
]);

const fieldSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  type: z.unknown(),
});

const modeSchema = z.enum(["owner", "appMembers", "appBuilders", "none"]);

const json: z.ZodType<FrozenJson> = z.json();

/** A permission's data, as a declaration is: JSON, by key. */
export const permissionDataSchema = z.record(z.string(), json);

const definitionSchema = z.strictObject({
  name: z.string(),
  permissions: z.array(permissionDataSchema),
  tables: z.array(
    z.strictObject({
      id: idSchema,
      name: z.string(),
      fields: z.array(fieldSchema),
      indexes: z.array(
        z.strictObject({ name: z.string(), fields: z.array(z.string()) })
      ),
      searchIndex: z.array(idSchema).optional(),
      sensitive: z.literal(true).optional(),
      access: z.strictObject({
        read: modeSchema,
        write: modeSchema,
        rows: z
          .strictObject({
            read: z.array(ruleSchema).optional(),
            write: z.array(ruleSchema).optional(),
          })
          .optional(),
      }),
    })
  ),
  answers: z.array(
    z.strictObject({ table: idSchema, field: idSchema, value: json })
  ),
  functions: z
    .array(
      z.strictObject({
        id: idSchema,
        name: z.string().refine(isFunctionPath, {
          message:
            "A function's path: its module's path and its export's name, joined by dots",
        }),
      })
    )
    .optional(),
  workflowBindings: z
    .array(
      z.strictObject({
        alias: z.string(),
        workflowId: z.string().min(1).max(128),
        version: z.int().min(1),
      })
    )
    .optional(),
});

const refuse: (message: string) => never = refuser(AppDefinitionError);

/**
 * `data`, a permission's, with each descriptor it holds mapped by `map`:
 * a workflow's `args` and `returns`, its events' `data` and its
 * decisions' `value` and `context`, and the platform's functions' `args`
 * and `returns`. The only kinds whose data holds descriptors.
 */
const permissionTypes = (
  data: DefinedPermission,
  map: (descriptor: unknown) => unknown
): DefinedPermission => {
  const mapped = (value: FrozenJson | undefined): FrozenJson =>
    // SAFETY: a descriptor either way, which is JSON.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    map(value) as FrozenJson;
  const kind = data["~permission"];
  if (kind === "workflows") {
    const each = (
      record: FrozenJson | undefined,
      fields: readonly string[]
    ): FrozenJson =>
      isPlainObject(record)
        ? Object.fromEntries(
            Object.entries(record).map(([name, entry]) => [
              name,
              isPlainObject(entry)
                ? {
                    ...entry,
                    ...Object.fromEntries(
                      fields.map((field) => [field, mapped(entry[field])])
                    ),
                  }
                : entry,
            ])
          )
        : (record ?? {});
    return {
      ...data,
      args: mapped(data.args),
      returns: mapped(data.returns),
      events: each(data.events, ["data"]),
      decisions: each(data.decisions, ["value", "context"]),
    };
  }
  const { functions } = data;
  if (kind !== "grasp" || !isPlainObject(functions)) {
    return data;
  }
  return {
    ...data,
    functions: Object.fromEntries(
      Object.entries(functions).map(([name, declared]) => [
        name,
        isPlainObject(declared)
          ? {
              ...declared,
              args: mapped(declared.args),
              returns: mapped(declared.returns),
            }
          : declared,
      ])
    ),
  };
};

/** `read`'s answer, a refusal naming `where` when its descriptor isn't one. */
const readType = <Read>(where: string, read: () => Read): Read => {
  try {
    return read();
  } catch (error) {
    if (error instanceof ValueDefinitionError) {
      return refuse(`${where}: ${error.message}`);
    }
    throw error;
  }
};

/** A descriptor read from its compact form; `where` names it in a refusal. */
const fromCompact = (where: string, compact: unknown): ValueDescriptor =>
  readType(where, () => descriptorFromCompact(compact));

/** Orders keys as canonical JSON does: by UTF-16 code unit. */
const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number =>
  a < b ? -1 : 1;

/**
 * `value` with every object's keys sorted, as canonical JSON has them,
 * but an object type's `fields` (`{ kind: "object", fields }`), which
 * keep the order their code declares them in: that order is the type's.
 */
const ordered = (value: unknown, declared = false): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => ordered(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const entries = Object.entries(value);
  const objectType = Reflect.get(value, "kind") === "object";
  return Object.fromEntries(
    (declared ? entries : entries.toSorted(byKey)).map(([key, item]) => [
      key,
      ordered(item, objectType && key === "fields"),
    ])
  );
};

/**
 * `definition` as its text holds it: every descriptor in its compact
 * form, and no `functions` or `workflowBindings` while it has none, so
 * an App without them has one text, and one hash.
 */
const compactForm = ({
  functions,
  workflowBindings,
  ...definition
}: AppDefinition): unknown => ({
  ...definition,
  ...(functions === undefined || functions.length === 0 ? {} : { functions }),
  ...(workflowBindings === undefined || workflowBindings.length === 0
    ? {}
    : { workflowBindings }),
  permissions: definition.permissions.map((data) =>
    permissionTypes(data, (descriptor) =>
      // SAFETY: a permission's descriptors, as `permission.*` made them.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      compactDescriptor(descriptor as ValueDescriptor)
    )
  ),
  tables: definition.tables.map((table) => ({
    ...table,
    fields: table.fields.map((field) => ({
      ...field,
      type: compactDescriptor(field.type),
    })),
  })),
});

/**
 * The definition `data`, its structure checked, holds: each descriptor
 * read from its compact form, a refusal naming the one that isn't one.
 */
const fullForm = (data: z.output<typeof definitionSchema>): AppDefinition => {
  const { tables, permissions, functions, workflowBindings, ...rest } = data;
  return {
    ...rest,
    ...(functions === undefined || functions.length === 0 ? {} : { functions }),
    ...(workflowBindings === undefined || workflowBindings.length === 0
      ? {}
      : { workflowBindings }),
    permissions: permissions.map((permission) =>
      permissionTypes(permission, (compact) =>
        fromCompact(
          `A \`${JSON.stringify(permission["~permission"])}\` permission`,
          compact
        )
      )
    ),
    tables: tables.map((table) => ({
      ...table,
      fields: table.fields.map((field) => ({
        ...field,
        type: fromCompact(`\`${table.name}.${field.name}\``, field.type),
      })),
    })),
  };
};

/**
 * A definition's text, as Grasp stores, hashes and compares it: its JSON,
 * every descriptor in its compact form (value-compact.ts), in one form,
 * so equal definitions have equal text however the keys of its records
 * and values came in. Its keys are sorted as canonical JSON's are, but an
 * object type's fields (`ordered`): sorting those would reorder the code
 * it generates.
 */
export const definitionText = (definition: AppDefinition): string =>
  JSON.stringify(ordered(compactForm(definition)));

/**
 * `definition` in its one form, its text read back (`definitionText`):
 * what code is generated and declared from, so equal definitions
 * generate the same code however the keys of their values came in (an
 * object default's, say).
 */
export const canonicalDefinition = (definition: AppDefinition): AppDefinition =>
  fullForm(definitionSchema.parse(JSON.parse(definitionText(definition))));

/** `data`'s JSON, or undefined for data JSON can't hold. */
const jsonOf = (data: unknown): string | undefined => {
  try {
    return JSON.stringify(data);
  } catch {
    return undefined;
  }
};

/**
 * The definition `data` holds, its size and structure checked and each
 * descriptor read from its compact form: throws `AppDefinitionError` for
 * data that isn't one. Its size is checked first, on its JSON, before
 * anything else reads it. What it declares is checked apart
 * (definition-app.ts, `readDefinition`).
 */
export const parseDefinition = (data: unknown): AppDefinition => {
  const text = jsonOf(data);
  if (text === undefined || isOverBytes(text, definitionMaxBytes)) {
    return refuse(
      `A definition is JSON of at most ${definitionMaxBytes} bytes.`
    );
  }
  const parsed = definitionSchema.safeParse(data);
  if (!parsed.success) {
    return refuse(
      `That isn't an App definition: ${z.prettifyError(parsed.error)}`
    );
  }
  return fullForm(parsed.data);
};
