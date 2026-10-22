import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { jsonOf } from "@grasp-os/shared/operations";

import { readContractSchema } from "../connector-contracts.ts";
import type { ReadSchema } from "../connector-contracts.ts";

// A host catalog connector operation described by its connector's own JSON
// Schemas (GRA-982), not an SDK value descriptor: a native connector's
// inputs use patterns, which no descriptor holds, so no descriptor could
// ever equal what connect generates, and no workflow could bind a native
// operation. Such an operation's `input` and `output` are each the JSON
// text of `{ "format": "json", "document": <schema> }`.
//
// Threat model, written before code on GRA-982, and how each is closed:
//
// - A catastrophic pattern core runs on a call's arguments, a connector's
//   answer or a test run's fixture (a test run checks fixtures against the
//   catalog's shapes before any approval): a catalog contract is published
//   with such schemas only when connect confirms each operation is exactly
//   a native action of this release (`nativeOperation`, workflow-catalog.ts),
//   so every pattern core runs is one a connector reviewed in this
//   repository makes. A Composio tool's listed schema never qualifies.
// - A keyword read but not enforced, giving a bound that isn't there: the
//   schema is read by the allow-list connector calls of Apps use
//   (connector-contracts.ts, connector-schema-check.ts); one using any
//   other keyword can't be published, and its full check runs beside the
//   descriptor's on every value.
// - A value coerced or filled in: values are taken exactly as they are
//   (exact-values.ts), the descriptor's answer canonically the value.
// - A connector release changing a schema under an approved binding:
//   approval compares the stored schema, canonically, with what connect
//   serves for that very connection (workflow-bindings.ts), and a contract
//   never changes once published (workflow-catalog.ts).

/** Whether `value` is a JSON object. */
const isRecord = (
  value: Json | undefined
): value is Readonly<Record<string, Json | undefined>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The JSON Schema `text` holds as an envelope, if it is one. */
export const envelopedSchema = (text: string | undefined): Json | undefined => {
  if (text === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const envelope = jsonOf(parsed);
  if (!isRecord(envelope)) {
    return undefined;
  }
  const { document } = envelope;
  return Object.keys(envelope).length === 2 &&
    envelope.format === "json" &&
    isRecord(document)
    ? document
    : undefined;
};

/** Read schemas by their envelope's JSON text, made once each. */
const reads = new Map<string, ReadSchema | undefined>();
const readsMax = 256;

/**
 * The schema the envelope `text` holds, read as connector calls of Apps
 * read one (`readContractSchema`): undefined for text that isn't an
 * envelope, or a schema the allow-list doesn't admit.
 */
export const readEnvelope = (text: string): ReadSchema | undefined => {
  if (reads.has(text)) {
    return reads.get(text);
  }
  const document = envelopedSchema(text);
  const read =
    document === undefined
      ? undefined
      : readContractSchema(JSON.stringify(document));
  reads.set(text, read);
  if (reads.size > readsMax) {
    const [oldest] = reads.keys();
    if (oldest !== undefined) {
      reads.delete(oldest);
    }
  }
  return read;
};

/** The JSON Schema the envelope `text` holds, canonically, if it is one. */
export const envelopedSchemaText = (
  text: string | undefined
): string | undefined => {
  const document = envelopedSchema(text);
  return document === undefined ? undefined : canonicalJson(document);
};

/**
 * `text` as the descriptor a workflow's validation reads: an envelope's
 * schema as its descriptor (shape and normal form; its patterns and
 * formats are checked on every value, never by validation), any other
 * text as it is.
 */
export const descriptorTextOf = (text: string): string => {
  if (envelopedSchema(text) === undefined) {
    return text;
  }
  const read = readEnvelope(text);
  // Unreadable: left as it is, for the catalog reader to refuse.
  return read === undefined ? text : JSON.stringify(read.descriptor);
};

/** A contract's operations, as the catalog stores them. */
interface WithOperations {
  readonly operations?: Readonly<
    Record<string, { input: string; output: string; readOnly?: boolean }>
  >;
}

/**
 * `contract` as a workflow's validation reads it: each operation's
 * connector schema as its descriptor (`descriptorTextOf`).
 */
export const forValidation = <Contract extends WithOperations>(
  contract: Contract
): Contract => {
  if (contract.operations === undefined) {
    return contract;
  }
  return {
    ...contract,
    operations: Object.fromEntries(
      Object.entries(contract.operations).map(([name, operation]) => [
        name,
        {
          ...operation,
          input: descriptorTextOf(operation.input),
          output: descriptorTextOf(operation.output),
        },
      ])
    ),
  };
};
