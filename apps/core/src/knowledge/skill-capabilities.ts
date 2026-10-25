import type { Permission } from "@grasp-os/shared/permissions";

import { grantedPermissions } from "../permissions.ts";
import type { Reader } from "./access.ts";

// The capabilities a skill's manifest may require (GRA-310), as core names
// them for the Brain's `skills.capabilities` port: what a caller already
// holds, read now from its grants, so a skill is selected only for one
// that can do what it needs, and selecting it grants nothing.
//
// - An App, run or agent: each action of each active grant, as
//   `<object type>:<action>`, and, for an object with an ID, also as
//   `<object type>:<object ID>:<action>` (a manifest naming one connection).
// - A person: none yet. A person reads skills through Knowledge, and no
//   caller of `skills.select` acts as a person alone in this slice.

/** The ID of a permission's object, where it has one: a platform permission has none. */
const objectIdOf = (object: Permission["object"]): string | undefined => {
  if (object.type === "connection") {
    return object.connectionId;
  }
  if (object.type === "collection") {
    return object.collectionId;
  }
  if (object.type === "workflow") {
    return object.workflowId;
  }
  if (object.type === "app") {
    return object.appId;
  }
  return object.type === "store" ? object.storeId : undefined;
};

/** The capabilities `permissions` give, by core's names for them. */
export const capabilitiesOf = (
  permissions: readonly Permission[]
): string[] => [
  ...new Set(
    permissions.flatMap(({ object, actions }) => {
      const id = objectIdOf(object);
      return actions.flatMap((action) => [
        `${object.type}:${action}`,
        ...(id === undefined ? [] : [`${object.type}:${id}:${action}`]),
      ]);
    })
  ),
];

/** The capabilities `reader` holds now: none for a person (see above). */
export const skillCapabilities = async (
  env: Env,
  reader: Reader
): Promise<string[]> =>
  reader.type === "person"
    ? []
    : capabilitiesOf(await grantedPermissions(env, reader.authority));
