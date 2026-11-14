import { sha256Hex } from "@grasp-os/shared/encoding";
import { permissionIdSchema } from "@grasp-os/shared/ids";
import type { PermissionId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { permissionErrors } from "@grasp-os/shared/permissions";

import { recallFor } from "./brain-recall.ts";
import type { ResourceAdapter, ServedBinding } from "./resource-adapter.ts";
import { platformGrantOf } from "./resource-platform.ts";

// A brain resource (resource-bindings.ts): `ctx.brain.recall` for an App's
// actions, as an admin bound the App's `brain` declaration to one of the
// App's own `{ type: "platform" }` permissions to read the Brain. A
// declaration grants nothing: it resolves only through an active binding
// approved for exactly it, naming the App's own active permission, which
// `recallFor` checks again as each recall is made, then reads only what
// everyone in the company may read, for whoever the call acts for (threat
// model on GRA-1731).

/** The contract every brain binding serves. */
const brainContract = "grasp.brain@1";

/** A brain binding's target, served: its recalls, for each caller. */
const served = async (
  env: Env,
  permissionId: PermissionId
): Promise<ServedBinding> => ({
  contractId: brainContract,
  fingerprint: await sha256Hex(
    canonicalJson({ contract: brainContract, permissionId })
  ),
  call: async (caller, { method, args }) => {
    // The function host allows only a declared operation through.
    if (method !== "recall") {
      throw permissionErrors.create("permission.denied");
    }
    return await recallFor(
      env,
      {
        authority: caller.authority,
        context: caller.context,
        permissionId,
        // What an App is handed may end up wherever a member reads.
        reach: "company",
        actor: caller.actor,
        target: { type: "app", id: caller.app },
      },
      args[0]
    );
  },
});

export const brainAdapter: ResourceAdapter<"brain"> = {
  bind: async (env, app, _declaration, target) => {
    const permissionId = permissionIdSchema.parse(target.permissionId);
    return (await platformGrantOf(env, app, permissionId, "brain"))
      ? await served(env, permissionId)
      : undefined;
  },
};
