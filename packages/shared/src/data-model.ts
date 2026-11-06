import type { AppDataAccess } from "./app-data.ts";

// An App's data model as its workspace's Data view shows and changes it
// (core's app-definition.ts, over the App's definition): its tables, each
// field's kind as a person picks it, and what publishing the draft does
// to the records the App holds. The view changes the model only through
// the definition's own operations (`@grasp-os/sdk/definition`), as the
// chat's agent does, each given a field's type as code writes it: a kind
// becomes that code here (`fieldKindCode`), so the page never builds code
// of its own.

/** A field's kind, as a person picks it; `other` for any type code declares beyond these. */
export type FieldKind =
  | "text"
  | "email"
  | "number"
  | "boolean"
  | "date"
  | "choice"
  | "link"
  | "person"
  | "file"
  | "money"
  | "other";

/** A field's kind, with what it takes: a choice's values, a link's table. */
export type FieldType =
  | {
      kind: "text" | "email";
      /** Spaces at either end dropped as a value is saved. */
      trim: boolean;
      /** The fewest and most characters, where code bounds them. */
      min: number | null;
      max: number | null;
    }
  | {
      kind: "number";
      /** Whole numbers only. */
      integer: boolean;
      min: number | null;
      max: number | null;
    }
  | {
      kind: "boolean";
      /** What a record that doesn't say holds; null for none. */
      default: boolean | null;
    }
  | { kind: "choice"; values: string[] }
  | {
      kind: "link";
      table: string;
      /** Whether deleting the linked record deletes this one too; otherwise that delete is refused. */
      cascade: boolean;
    }
  | { kind: "date" | "person" | "file" | "money" | "other" };

/** A field of a table, or a preference. */
export interface DataModelField {
  /** Its ID, which a rename keeps. */
  id: string;
  name: string;
  type: FieldType;
  /** Whether every record must hold it: neither optional nor defaulted. */
  required: boolean;
  /**
   * Its type as code declares it, but whether it is required: what a
   * change of `required` keeps, so no constraint of code's is lost.
   */
  code: string;
}

/** A row rule, its field by name. */
export type DataModelRule =
  | { kind: "owner" }
  | { kind: "person" | "team"; field: string }
  | { kind: "role"; role: "builder" | "user" };

/** A table: its fields, indexes and access, fields by name. */
export interface DataModelTable {
  id: string;
  name: string;
  fields: DataModelField[];
  indexes: { name: string; fields: string[] }[];
  /** The text fields its search index covers; null without one. */
  searchIndex: string[] | null;
  sensitive: boolean;
  access: {
    read: AppDataAccess;
    write: AppDataAccess;
    rows: { read: DataModelRule[]; write: DataModelRule[] };
  };
}

/** An App's data model, from its definition. */
export interface DataModel {
  tables: DataModelTable[];
  preferences: DataModelField[];
  /** What it reaches outside itself, each by its alias and kind. */
  permissions: { alias: string; kind: string }[];
}

/** Where a field is, by names. */
export interface PlanField {
  table: string;
  field: string;
}

/**
 * What publishing a definition does to the App's records: the move from
 * the definition of the version people use to the draft's, as the store
 * plans it (@grasp-os/sdk's schema-plan.ts).
 */
export interface DefinitionPlan {
  /** Whether the store can apply it without a migration in code. */
  accepted: boolean;
  addedTables: string[];
  addedFields: PlanField[];
  /** Fields every record still fits: nothing to check. */
  widenedFields: PlanField[];
  /**
   * Fields every record is checked against, and the value a record
   * lacking one takes (`answer`, JSON): null until the draft gives one.
   */
  checks: (PlanField & { answer: unknown })[];
  /** Tables the schema left out: kept with their records, never dropped. */
  keptTables: string[];
  /** Fields the schema left out: kept in every record, never dropped. */
  keptFields: PlanField[];
  /** Tables whose access changes, for every record at once. */
  accessChanges: string[];
  /**
   * Tables declared sensitive: their change history keeps no values from
   * now on, and every read is audited. A table stays so once declared.
   */
  sensitiveTables: string[];
  /** What needs a migration in code, and why. */
  refused: { table: string; field?: string; reason: string }[];
}

/** The data model of a chat's draft of an App, and what publishing it does. */
export interface DraftDataModel {
  model: DataModel;
  plan: DefinitionPlan;
}

/**
 * What an operation on the draft's definition makes of it: the problem,
 * for one it can't take, which changed nothing; otherwise the model after
 * it, and the plan.
 */
export type DataModelChange =
  | { ok: false; problem: string }
  | ({
      ok: true;
      /** What this change alone does: from the draft before it to after it. */
      change: DefinitionPlan;
    } & DraftDataModel);

/** A value as code writes it: JSON is a JavaScript literal. */
const literal = (value: string): string => JSON.stringify(value);

/** The code of each kind that takes nothing more. */
const kindCodes = {
  date: "v.timestamp()",
  person: "v.person()",
  file: "v.file()",
  money: "v.money()",
} as const;

/** `.min(n)` and `.max(n)`, for the bounds that are set. */
const bounds = (min: number | null, max: number | null): string =>
  `${min === null ? "" : `.min(${min})`}${max === null ? "" : `.max(${max})`}`;

/**
 * The code that declares a required field of `type`, as the definition's
 * operations take a type; undefined for `other`, which only code says.
 */
export const fieldKindCode = (type: FieldType): string | undefined => {
  switch (type.kind) {
    case "text": {
      return `v.string()${type.trim ? ".trim()" : ""}${bounds(type.min, type.max)}`;
    }
    case "email": {
      return `v.string()${type.trim ? ".trim()" : ""}.email()${bounds(type.min, type.max)}`;
    }
    case "number": {
      return `v.number()${type.integer ? ".integer()" : ""}${bounds(type.min, type.max)}`;
    }
    case "boolean": {
      return `v.boolean()${type.default === null ? "" : `.default(${String(type.default)})`}`;
    }
    case "choice": {
      return `v.enum([${type.values.map(literal).join(", ")}])`;
    }
    case "link": {
      return `v.id(${literal(type.table)}${type.cascade ? ', { onDelete: "cascade" }' : ""})`;
    }
    case "date":
    case "person":
    case "file":
    case "money": {
      return kindCodes[type.kind];
    }
    case "other": {
      // A type only code says.
      return undefined;
    }
    default: {
      return undefined;
    }
  }
};

/** A field's type as code writes it: `code`, optional unless `required`. */
export const fieldCode = (code: string, required: boolean): string =>
  required ? code : `${code}.optional()`;
