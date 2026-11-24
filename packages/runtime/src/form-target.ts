import type { StandardSchemaV1 } from "@standard-schema/spec";

import { clientInternals } from "./client-core.ts";
import type {
  ActionReference,
  GraspClient,
  MutationReference,
} from "./client-core.ts";
import { clientError } from "./client-error.ts";
import { referenceName } from "./function-references.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { schemaOf } from "./value-schema.ts";
import { v } from "./values.ts";
import { decisionName } from "./workflow-decisions.ts";

// What a form validates with and submits to, read once from what `useForm`
// was given: a function's reference, a decision's, or a native schema.

/** Sends one submission's input through the session client, under its key once it has one. */
type Send = (
  input: unknown,
  options: { readonly idempotencyKey?: string }
) => Promise<unknown>;

/** How a binding validates and submits, by the way the form was made. */
export type Target =
  | {
      readonly kind: "function";
      readonly send: Send;
      readonly args: ValueDescriptor;
    }
  | { readonly kind: "schema"; readonly schema: StandardSchemaV1 };

/** Whether `value` is a native Standard Schema rather than a reference. */
const isSchema = (value: unknown): value is StandardSchemaV1 =>
  typeof value === "object" &&
  value !== null &&
  "~standard" in value &&
  !("name" in value);

/**
 * The schema of an answer to the decision `target` names, as the page's
 * build declares it; undefined when it names no decision the release
 * declares.
 */
const decisionSchemaOf = (
  client: GraspClient,
  target: unknown
): StandardSchemaV1 | undefined => {
  const named = decisionName(referenceName(target));
  const declared =
    named === undefined
      ? undefined
      : clientInternals(client)
          .workflowOf(named.workflow)
          ?.decisions.get(named.key);
  return declared === undefined
    ? undefined
    : v.object({ approved: v.boolean(), value: schemaOf(declared.value) });
};

/** The way `target` and `options` make the form, read once. */
export const targetOf = (client: GraspClient, target: unknown): Target => {
  if (isSchema(target)) {
    return { kind: "schema", schema: target };
  }
  const decision = decisionSchemaOf(client, target);
  if (decision !== undefined) {
    return { kind: "schema", schema: decision };
  }
  // A form binds a mutation or an action by its reference's name: its
  // kind and the arguments the form checks with are the page's release's
  // (page-functions.ts), never anything the reference itself carries.
  // Core checks the submission again with the function's own validator,
  // and the form shows what it refuses by the fields it names.
  const internals = clientInternals(client);
  const fn = internals.functionOf(target);
  if (fn === undefined || fn.kind === "query") {
    throw clientError("contract.invalid_request");
  }
  const { kind, args } = fn;
  internals.readReference(target, kind);
  if (kind === "action") {
    const send: Send = async (input, submit) =>
      // SAFETY: read as an action reference just above.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      await client.action(target as ActionReference, input, submit);
    return { kind: "function", send, args };
  }
  const send: Send = async (input, submit) =>
    // SAFETY: read as a mutation reference just above.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    await client.mutation(target as MutationReference, input, submit);
  return { kind: "function", send, args };
};
