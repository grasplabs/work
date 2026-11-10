import { canonicalText } from "@grasp-os/shared/json";

import { refuse } from "./permission-checks.ts";
import { peopleDeclaration, permissionAliases } from "./permission-types.ts";
import type { AnyPermission, AppPermission } from "./permission-types.ts";
import { permission } from "./permission.ts";
import { isPlainObject } from "./value-descriptor.ts";
import { readDescriptor } from "./value-read.ts";
import { schemaOf } from "./value-schema.ts";

/** `descriptor`, data a manifest holds, as the schema it describes. */
const schemaFrom = (descriptor: unknown) =>
  schemaOf(readDescriptor(descriptor, 1, { nodes: 0 }));

/** `record`'s entries each mapped by `map`; anything else as it is. */
const mappedEntries = (
  record: unknown,
  map: (entry: unknown) => unknown
): unknown =>
  isPlainObject(record)
    ? Object.fromEntries(
        Object.entries(record).map(([key, entry]) => [key, map(entry)])
      )
    : record;

/** Refuses `alias` for a permission whose alias is `fixed`. */
const fixedAlias = (alias: unknown, fixed: string): void => {
  if (alias !== fixed) {
    refuse(`A permission of this kind is always \`${fixed}\`.`);
  }
};

/**
 * The declaration `data` describes, as a manifest holds it, declared
 * again through `permission`: it passes exactly the checks a declaration
 * in code does, and anything else (an unknown kind or key, a value out of
 * bounds) throws `PermissionDefinitionError` or `ValueDefinitionError`.
 * Only the host reads declarations back (host.ts).
 */
export const readPermissionDeclaration = (data: unknown): AppPermission => {
  if (!isPlainObject(data)) {
    return refuse("A permission declaration is an object.");
  }
  const { "~permission": kind, alias, ...config } = data;
  if (typeof alias !== "string") {
    return refuse("A permission declaration has an alias.");
  }
  // Each constructor refuses keys its kind hasn't; `~permission` and the
  // alias are read here, the rest is its config.
  // SAFETY: each constructor checks its config at run time.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const loose = config as never;
  if (
    kind === "ai" ||
    kind === "brain" ||
    kind === "guests" ||
    kind === "files" ||
    kind === "links"
  ) {
    fixedAlias(alias, permissionAliases[kind]);
    const constructors = {
      ai: permission.ai,
      brain: permission.brain,
      guests: permission.guests,
      files: permission.files,
      links: permission.links,
    } as const;
    // SAFETY: each constructor checks its config at run time, as above.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const construct = constructors[kind] as (config: never) => AnyPermission;
    return construct(loose);
  }
  if (kind === "connections") {
    return permission.connection(alias, loose);
  }
  if (kind === "people") {
    fixedAlias(alias, permissionAliases.people);
    if (Object.keys(config).length > 0) {
      return refuse("`people` declares nothing but itself.");
    }
    return peopleDeclaration;
  }
  if (kind === "grasp") {
    // The platform's own, exactly: a manifest whose `grasp` declares
    // anything else is no declaration `permission.grasp` makes.
    fixedAlias(alias, permissionAliases.grasp);
    const grasp = permission.grasp();
    if (
      canonicalText(config) !== canonicalText({ functions: grasp.functions })
    ) {
      return refuse("`grasp` declares exactly the platform's own functions.");
    }
    return grasp;
  }
  if (kind === "workflows") {
    const { args, returns, events, decisions, ...rest } = config;
    // SAFETY: as above: `workflow` refuses any key it doesn't take, and
    // checks every event's and decision's shape again.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const workflowConfig = {
      ...rest,
      args: schemaFrom(args),
      returns: schemaFrom(returns),
      events: mappedEntries(events, (event) =>
        isPlainObject(event)
          ? { ...event, data: schemaFrom(event.data) }
          : event
      ),
      decisions: mappedEntries(decisions, (decision) =>
        isPlainObject(decision)
          ? {
              ...decision,
              value: schemaFrom(decision.value),
              context: schemaFrom(decision.context),
            }
          : decision
      ),
    } as never;
    return permission.workflow(alias, workflowConfig);
  }
  return refuse("A permission declaration's kind isn't one this SDK knows.");
};
