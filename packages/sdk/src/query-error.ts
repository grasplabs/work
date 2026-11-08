import { refuser } from "./declaration.ts";

/** Why a query was refused while it was built. */
export type QueryDefinitionCode =
  | "query.unknown_table"
  | "query.unknown_index"
  | "query.invalid_range"
  | "query.invalid_filter"
  | "query.invalid_terminal";

/**
 * A query built wrongly: thrown before anything is read. `code` is an own
 * property, so it crosses an RPC boundary.
 */
export class QueryDefinitionError extends Error {
  readonly code: QueryDefinitionCode;

  constructor(code: QueryDefinitionCode, message: string) {
    super(message);
    this.name = "QueryDefinitionError";
    this.code = code;
  }
}

export const refuse: (code: QueryDefinitionCode, message: string) => never =
  refuser(QueryDefinitionError);
