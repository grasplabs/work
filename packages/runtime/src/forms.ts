// `@grasp-os/runtime/forms`: what `@grasp-os/ui`'s form field helpers and
// grids read beside their TanStack state: a form's submission status, how
// to subscribe to it, what its validator declares of each field, and what
// a query declares it answers. Not an App's import: pages get `useForm`
// from `@grasp-os/sdk/react` and the components from `@grasp-os/ui`.
import { clientInternals } from "./client-core.ts";
import type { GraspClient } from "./client-core.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";

export { bindingOf } from "./form.ts";
export type { FormBinding } from "./form.ts";
export type { ValueDescriptor } from "./value-descriptor.ts";

/**
 * What the query `reference` names declares it answers, in the release
 * the page was built with (page-functions.ts): what a grid reads its
 * columns' kinds from. Null for a query that declares no `returns`, and
 * for a name the release has no public query at.
 */
export const declaredReturns = (
  client: GraspClient,
  reference: unknown
): ValueDescriptor | null => {
  const fn = clientInternals(client).functionOf(reference);
  return fn?.kind === "query" ? fn.returns : null;
};
