import type {
  ActionReference,
  CallArguments,
  MutationReference,
  SubmitOptions,
} from "../client-core.ts";
import type { FunctionReturn } from "../function-references.ts";
import { useClient } from "./provider.ts";

/** A mutation or action as a function: its arguments, then its options. */
type FunctionCallable<Reference> = (
  ...args: CallArguments<Reference, SubmitOptions>
) => Promise<FunctionReturn<Reference>>;

/**
 * The mutation `reference` names, as a stable function: each call is one
 * logical submission, resolving with the declared result once the host
 * confirms its commit.
 */
export const useMutation = <Reference extends MutationReference>(
  reference: Reference
): FunctionCallable<Reference> => {
  const client = useClient();
  return async (...args) => await client.mutation(reference, ...args);
};

/**
 * The action `reference` names, as a stable function: each call is one
 * logical submission, resolving with its declared result. A lost
 * response is recovered from the action's receipt, never run again.
 */
export const useAction = <Reference extends ActionReference>(
  reference: Reference
): FunctionCallable<Reference> => {
  const client = useClient();
  return async (...args) => await client.action(reference, ...args);
};
