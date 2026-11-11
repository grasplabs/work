import { isPlainObject } from "@grasp-os/shared/json";

import { clientError } from "./client-error.ts";
import { namePattern } from "./declaration.ts";
import type { FilesOperation, FilesReference } from "./file-link-references.ts";
import type { FileValue } from "./value-types.ts";

/** A reference to one of the App's files: holding it grants nothing. */
export type FileRef = FileValue;

/** A files reference as the client read it. */
interface ReadFilesReference {
  readonly alias: string;
  readonly operations: readonly FilesOperation[];
}

const operations: ReadonlySet<unknown> = new Set([
  "upload",
  "read",
  "attach",
  "delete",
]);

const fileIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * `value` read as a generated files reference that declares `operation`;
 * a malformed one, or one that doesn't declare it, is refused before
 * anything is sent (core checks the App's declaration again).
 */
export const readFilesReference = (
  value: unknown,
  operation: FilesOperation
): ReadFilesReference => {
  if (
    !isPlainObject(value) ||
    value.kind !== "files" ||
    typeof value.alias !== "string" ||
    !namePattern.test(value.alias) ||
    !Array.isArray(value.operations) ||
    !value.operations.every((item) => operations.has(item))
  ) {
    throw clientError("contract.invalid_request");
  }
  // SAFETY: each item was checked to be one of the operations.
  const declared = value.operations as readonly FilesOperation[];
  if (!declared.includes(operation)) {
    throw clientError("file.operation_undeclared");
  }
  return { alias: value.alias, operations: declared };
};

/** `value` read as a file reference, `{ id }`, or refused. */
export const readFileRef = (value: unknown): FileRef => {
  // Only an ID core could have minted (a UUID) is sent: the page refuses
  // anything else, and a refusal must reach the caller here, at once.
  if (
    !isPlainObject(value) ||
    typeof value.id !== "string" ||
    !fileIdPattern.test(value.id) ||
    Object.keys(value).length !== 1
  ) {
    throw clientError("contract.invalid_args");
  }
  return { id: value.id };
};

/**
 * A generated files reference, as a parameter that takes it only if its
 * resource declares `Operation`: one that doesn't fails type-checking,
 * naming the operation it lacks.
 */
export type Declaring<
  Reference extends FilesReference,
  Operation extends FilesOperation,
> = Reference &
  (Operation extends Reference["operations"][number]
    ? unknown
    : { readonly "~undeclaredOperation": Operation });
