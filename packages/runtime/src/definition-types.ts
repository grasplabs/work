import type { AccessMode, RowRole } from "./table-access.ts";
import type { FrozenJson, ValueDescriptor } from "./value-descriptor.ts";

// An App's definition: what it is, as data. Its name, the
// permissions it needs, and its data model:
// tables, their fields, indexes and access, and its answers for a change
// of the schema. Grasp keeps it apart from the App's files, as each
// version's metadata (its text, `definitionText`), and
// generates the App's config (`grasp.config.ts`) and schema
// (`server/schema.ts`) from it (definition-source.ts), one way only: what
// the App does is code, and only code runs, is sealed and is exported.
// Its IDs never appear in code.
//
// Every type in it, a field's or a permission's, is a descriptor in its
// compact form (value-compact.ts) as the text holds it, and the full
// descriptor once read.
//
// Every table and field has an ID that never changes. A rename changes a
// name only; indexes, row rules and answers name fields by their IDs, so
// a rename never leaves one pointing at nothing.
//
// So does each server function a workflow may call (`functions`): its ID
// is what a workflow's grant and its calls name it by, and a rename
// (`renameFunction`) changes its name, the code's path to it, only. Its
// code stays found by that path. Each query and mutation the code exports
// gets an ID as a commit brings it, and loses it once the code no longer
// exports it (`withExportedFunctions`), so a version's definition names
// exactly its code's; a seal reads only those (core's app-definition.ts,
// `functionIdsOf`).
//
// Its text is its JSON (definition-json.ts); what it declares is checked
// as code's is (definition-app.ts).

/** A table's field: its ID, its name and its type. */
export interface DefinedField {
  readonly id: string;
  readonly name: string;
  readonly type: ValueDescriptor;
}

/** An index: its name, and the fields it orders by, by ID (or `_createdAt`, `_updatedAt`). */
interface DefinedIndex {
  readonly name: string;
  readonly fields: readonly string[];
}

/** A row rule, its field (for `person` and `team`) by ID. */
export type DefinedRule =
  | { readonly kind: "owner" }
  | { readonly kind: "person" | "team"; readonly field: string }
  | { readonly kind: "role"; readonly role: RowRole };

/** A table's access: its modes, and its row rules. */
interface DefinedAccess {
  readonly read: AccessMode;
  readonly write: AccessMode;
  readonly rows?: {
    readonly read?: readonly DefinedRule[];
    readonly write?: readonly DefinedRule[];
  };
}

/** A table: its ID, its name, its fields, its indexes and its access. */
export interface DefinedTable {
  readonly id: string;
  readonly name: string;
  readonly fields: readonly DefinedField[];
  readonly indexes: readonly DefinedIndex[];
  /** The text fields its search index covers, by ID; none without one. */
  readonly searchIndex?: readonly string[];
  readonly sensitive?: true;
  readonly access: DefinedAccess;
}

/** A value for the records that lack a field (`SchemaAnswer`), by IDs. */
export interface DefinedAnswer {
  readonly table: string;
  readonly field: string;
  readonly value: FrozenJson;
}

/**
 * A permission, as a declaration's data (`permission.*` makes it), or
 * `{ "~permission": "people" }`: the App reads the organization's people.
 */
export type DefinedPermission = Readonly<Record<string, FrozenJson>>;

/**
 * A server function the App gives a stable ID: its ID, and its name, the
 * path its code exports it at (`server/tasks.ts`'s `create` is
 * `tasks.create`).
 */
export interface DefinedFunction {
  readonly id: string;
  readonly name: string;
}

/**
 * The workflow a draft bound under a workflow permission's alias
 * (`bindWorkflow`): what making the version current binds (core's
 * app-workflow-bindings.ts), at the workflow's live version, whichever
 * that is. A claim until then: a definition committed by hand may name
 * any, so core checks each again as it binds it.
 */
export interface DefinedWorkflowBinding {
  readonly alias: string;
  readonly workflowId: string;
}

/** An App's definition (see the header). */
export interface AppDefinition {
  readonly name: string;
  readonly permissions: readonly DefinedPermission[];
  readonly tables: readonly DefinedTable[];
  readonly answers: readonly DefinedAnswer[];
  /** The server functions it gives stable IDs; absent while it gives none. */
  readonly functions?: readonly DefinedFunction[];
  /**
   * The workflow versions it binds, by alias, in alias order; absent
   * while it records none. Never part of the code generated from it.
   */
  readonly workflowBindings?: readonly DefinedWorkflowBinding[];
}

/** The files generated from an App's definition, which only Grasp writes. */
export const generatedFiles = {
  config: "grasp.config.ts",
  schema: "server/schema.ts",
} as const;

/** The kind of the permission that says the App reads people. */
export const peoplePermission = "people";

/** The definition of a new App named `name`: nothing in it yet. */
export const emptyDefinition = (name: string): AppDefinition => ({
  name,
  permissions: [],
  tables: [],
  answers: [],
});
