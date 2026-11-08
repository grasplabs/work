import { AppDefinitionError } from "./app-definition-error.ts";
import { refuser } from "./declaration.ts";
import {
  isBrowserPermission,
  isPermission,
  isWorkflowPermission,
  peopleDeclaration,
  permissionAliases,
} from "./permissions.ts";
import type { AppPermission } from "./permissions.ts";
import { isPlainObject } from "./value-descriptor.ts";

const refuse: (message: string) => never = refuser(AppDefinitionError);

/** The keys of an App's `permissions`, and what each holds. */
const permissionKeys: ReadonlyMap<string, string> = new Map([
  ["ai", "one `permission.ai`"],
  ["connections", "a list of `permission.connection`"],
  ["brain", "one `permission.brain`"],
  ["workflows", "a list of `permission.workflow`"],
  ["grasp", "one `permission.grasp()`"],
  ["people", "`true` when it reads the organization's people"],
  ["files", "one `permission.files`"],
  ["guests", "one `permission.guests`"],
  ["links", "one `permission.links`"],
]);

/** The keys of an App's `permissions` that hold a list. */
const listedKeys: ReadonlySet<string> = new Set(["connections", "workflows"]);

/** The declarations `permissions[key]` holds: one, or a list. */
const declarationsUnder = (
  permissions: Readonly<Record<string, unknown>>,
  key: string
): readonly unknown[] => {
  const held = permissions[key];
  if (held === undefined) {
    return [];
  }
  if (listedKeys.has(key) !== Array.isArray(held)) {
    return refuse(
      `An App's \`permissions.${key}\` is ${permissionKeys.get(key) ?? "a permission"}.`
    );
  }
  const listed: readonly unknown[] = Array.isArray(held) ? held : [held];
  return listed;
};

/** The alias of `declaration`, if `permissions[key]` may hold it. */
const aliasUnder = (declaration: unknown, key: string): string | undefined => {
  if (isWorkflowPermission(declaration)) {
    return key === "workflows" ? declaration.alias : undefined;
  }
  if (isPermission(declaration) || isBrowserPermission(declaration)) {
    return declaration["~permission"] === key ? declaration.alias : undefined;
  }
  return undefined;
};

/** `permissions`, refused unless an object of the kinds there are. */
const checkedKeys = (
  permissions: unknown
): Readonly<Record<string, unknown>> => {
  if (!isPlainObject(permissions)) {
    return refuse(
      "An App's `permissions` is an object of its permissions by kind."
    );
  }
  for (const key of Object.keys(permissions)) {
    if (!permissionKeys.has(key)) {
      refuse(
        `An App's \`permissions\` has no \`${key}\`: its kinds are ${[...permissionKeys.keys()].join(", ")}.`
      );
    }
  }
  const { people } = permissions;
  if (people !== undefined && typeof people !== "boolean") {
    refuse(
      "An App's `permissions.people` is `true` when it reads the organization's people."
    );
  }
  return permissions;
};

/**
 * Refuses a fixed alias held by another kind: no connection or
 * workflow takes one, so the host never mistakes `ai` for a connection.
 */
const requireFixedAliases = (
  permissions: ReadonlyMap<string, AppPermission>
): void => {
  for (const [kind, alias] of Object.entries(permissionAliases)) {
    const held = permissions.get(alias);
    if (held !== undefined && held["~permission"] !== kind) {
      refuse(`\`${alias}\` is the alias of the App's \`${kind}\` permission.`);
    }
  }
};

/**
 * The App's permissions, each kind under its key, as one map by alias,
 * each alias once: `people: true` as the `people` permission.
 */
export const permissionsOf = (given: unknown): Map<string, AppPermission> => {
  const declared = new Map<string, AppPermission>();
  if (given === undefined) {
    return declared;
  }
  const permissions = checkedKeys(given);
  for (const key of permissionKeys.keys()) {
    for (const declaration of key === "people"
      ? []
      : declarationsUnder(permissions, key)) {
      const alias = aliasUnder(declaration, key);
      if (
        alias === undefined ||
        !(
          isWorkflowPermission(declaration) ||
          isPermission(declaration) ||
          isBrowserPermission(declaration)
        )
      ) {
        refuse(
          `An App's \`permissions.${key}\` is ${permissionKeys.get(key) ?? "a permission"}.`
        );
      }
      if (declared.has(alias)) {
        refuse(`Two of the App's permissions have alias \`${alias}\`.`);
      }
      declared.set(alias, declaration);
    }
  }
  requireFixedAliases(declared);
  if (permissions.people === true) {
    declared.set(peopleDeclaration.alias, peopleDeclaration);
  }
  return declared;
};
