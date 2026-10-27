import { brainErrors } from "@grasp-os/brain/contract";
import type { Authority } from "@grasp-os/shared/permissions";

import { grantedPermissions } from "../permissions.ts";
import type { Reader } from "./access.ts";

// Who may recall, as core decides it: the Brain's `recall` port
// (ports.ts). A person recalls what they may read; an App, run or agent
// only under an active `brain` grant, from the collections it was granted.

/**
 * Whether `authority` holds an active `brain` grant, read now: what an
 * App, run or agent needs to recall. A chat asks it before recalling for
 * a question (agent.ts), and recall asks it again as it reads.
 */
export const hasBrainGrant = async (
  env: Env,
  authority: Authority
): Promise<boolean> => {
  const granted = await grantedPermissions(env, authority);
  return granted.some(
    ({ object, actions }) =>
      object.type === "platform" && actions.includes("brain")
  );
};

/** Refuses, as `brain.denied`, an App, run or agent without a `brain` grant. */
export const requireRecall = async (
  env: Env,
  reader: Reader
): Promise<void> => {
  if (reader.type === "person") {
    return;
  }
  if (!(await hasBrainGrant(env, reader.authority))) {
    throw brainErrors.create("brain.denied");
  }
};

/**
 * Who `reader` is, for a recall's access revision: the person, or the
 * person an App or agent acts for, with its permission and grants, read
 * now, so a change to a grant changes the revision.
 */
export const recallKey = async (env: Env, reader: Reader): Promise<string> => {
  const permissions =
    reader.type === "person"
      ? []
      : await grantedPermissions(env, reader.authority);
  return JSON.stringify([
    reader.type,
    reader.type === "person"
      ? reader.person.userId
      : reader.authority.onBehalfOf,
    reader.type === "person" ? null : (reader.permissionId ?? null),
    permissions.map(({ id }) => id).toSorted(),
  ]);
};
