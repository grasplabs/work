import { refuser } from "./declaration.ts";

/** Why a schema's declaration was refused. */
export type SchemaDefinitionCode =
  | "schema.invalid_name"
  | "schema.name_conflict"
  | "schema.invalid_table"
  | "schema.invalid_index"
  | "schema.unknown_table"
  | "schema.too_large"
  | "schema.invalid_access"
  | "schema.invalid_rules"
  | "schema.invalid_manifest";

/**
 * A schema declared wrongly: thrown while it is built or read back from a
 * manifest. `code` is an own property, so it crosses an RPC boundary.
 */
export class SchemaDefinitionError extends Error {
  readonly code: SchemaDefinitionCode;

  constructor(code: SchemaDefinitionCode, message: string) {
    super(message);
    this.name = "SchemaDefinitionError";
    this.code = code;
  }
}

export const refuse: (code: SchemaDefinitionCode, message: string) => never =
  refuser(SchemaDefinitionError);
