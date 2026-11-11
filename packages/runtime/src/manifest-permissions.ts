import type { AppManifest } from "./app-types.ts";
import type { AnyPermission, AppPermission } from "./permission-types.ts";

/** A permission's kind, as a manifest files it (`~permission`). */
type AppPermissionKind = AppPermission["~permission"];

/** The permission of kind `Kind`. */
type PermissionOfKind<Kind extends AppPermissionKind> = Extract<
  AppPermission,
  { readonly "~permission": Kind }
>;

/** Whether `declared` is of kind `kind`. */
const isOfKind = <Kind extends AppPermissionKind>(
  declared: AppPermission,
  kind: Kind
): declared is PermissionOfKind<Kind> => declared["~permission"] === kind;

/**
 * The permission `manifest` declares under `alias`, if it is of kind
 * `kind`: what the host checks a use against, so an alias of another kind
 * (a workflow named where a connection is asked for) is none.
 */
export const declaredPermission = <Kind extends AppPermissionKind>(
  manifest: Pick<AppManifest, "permissions">,
  alias: unknown,
  kind: Kind
): PermissionOfKind<Kind> | undefined => {
  const declared =
    typeof alias === "string" && Object.hasOwn(manifest.permissions, alias)
      ? manifest.permissions[alias]
      : undefined;
  return declared !== undefined && isOfKind(declared, kind)
    ? declared
    : undefined;
};

/** The permissions of kind `kind` that `manifest` declares, in alias order. */
export const declaredPermissions = <Kind extends AppPermissionKind>(
  manifest: Pick<AppManifest, "permissions">,
  kind: Kind
): PermissionOfKind<Kind>[] =>
  Object.keys(manifest.permissions)
    .toSorted()
    .flatMap((alias) => declaredPermission(manifest, alias, kind) ?? []);

/** The kinds of permission an action reaches through `ctx`. */
const reachedKinds: ReadonlySet<AppPermissionKind> = new Set([
  "ai",
  "connections",
  "brain",
  "grasp",
  "guests",
]);

/** Whether `declared` is one an action reaches through `ctx`. */
export const isActionPermission = (
  declared: AppPermission
): declared is AnyPermission => reachedKinds.has(declared["~permission"]);

/**
 * The permission an action reaches under `alias` (`ctx.ai`,
 * `ctx.connections.<alias>`, …) that `manifest` declares, if any: never a
 * workflow, a pages' permission or `people`.
 */
export const actionPermission = (
  manifest: Pick<AppManifest, "permissions">,
  alias: unknown
): AnyPermission | undefined => {
  const declared =
    typeof alias === "string" && Object.hasOwn(manifest.permissions, alias)
      ? manifest.permissions[alias]
      : undefined;
  return declared !== undefined && isActionPermission(declared)
    ? declared
    : undefined;
};

/** The permissions an action reaches that `manifest` declares, in alias order. */
export const actionPermissions = (
  manifest: Pick<AppManifest, "permissions">
): AnyPermission[] =>
  Object.keys(manifest.permissions)
    .toSorted()
    .flatMap((alias) => actionPermission(manifest, alias) ?? []);
