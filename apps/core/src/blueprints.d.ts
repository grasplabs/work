// The built-in blueprints, generated into dist/ by build-blueprints.ts.

import type { DeclaredCollection } from "@grasp-os/shared/brain-documents";
import type {
  BlueprintWorkflow,
  DeclaredPermission,
} from "@grasp-os/shared/permissions";
import type { CatalogContractDefinition } from "@grasp-os/shared/workflow-resources";

/** A built-in blueprint, as the build embeds it. */
export interface BuiltinBlueprint {
  /** Its folder's name under apps/core/blueprints/, which never changes. */
  id: string;
  name: string;
  description: string;
  /** The collections it keeps records in, which the install creates. */
  collections: readonly DeclaredCollection[];
  /** What each App created from it asks for, each waiting for an admin. */
  permissions: readonly DeclaredPermission[];
  /**
   * The catalog contracts its workflows bind, which the install publishes
   * if their keys aren't taken yet.
   */
  contracts: readonly CatalogContractDefinition[];
  /**
   * The independent workflows each App created from it gets, bound to it,
   * each asking for an admin's grant to start.
   */
  workflows: readonly BlueprintWorkflow[];
  /** The App's files: their text, by path. */
  files: Readonly<Record<string, string>>;
}

/** The release's built-in blueprints, in id order. */
declare const blueprints: readonly BuiltinBlueprint[];
export default blueprints;
