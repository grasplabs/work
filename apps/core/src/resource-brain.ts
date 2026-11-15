import { sha256Hex } from "@grasp-os/shared/encoding";
import { permissionIdSchema } from "@grasp-os/shared/ids";
import type { PermissionId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { permissionErrors } from "@grasp-os/shared/permissions";

import { appUsersReadBy, appWriteFor } from "./brain-app-writes.ts";
import { entitiesCallFor, recallFor, skillsCallFor } from "./brain-recall.ts";
import type { ResourceAdapter, ServedBinding } from "./resource-adapter.ts";
import { platformGrantOf } from "./resource-platform.ts";

// A brain resource (resource-bindings.ts): `ctx.brain.recall`,
// `ctx.brain.skills` and `ctx.brain.entities` for an App's actions, as an
// admin bound the App's `brain` declaration to one of the App's own
// `{ type: "platform" }` permissions to read the Brain. A declaration
// grants nothing: it resolves only through an active binding approved for
// exactly it, naming the App's own active permission, which `recallFor`,
// `skillsCallFor` and `entitiesCallFor` check again on each call, then
// read only what everyone in the company may read, for whoever the call
// acts for (threat models on GRA-1731, GRA-1830 and GRA-1837). An App's
// code remembers and forgets in its own word, for its users, and its
// entity reads read that too for a person on its page who uses it now
// (brain-app-writes.ts, threat model on GRA-1883).

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
  call: async (caller, { method, args }, context) => {
    const brainCaller = {
      authority: caller.authority,
      context: caller.context,
      permissionId,
      actor: caller.actor,
      target: { type: "app", id: caller.app },
    } as const;
    // The function host allows only a declared operation through.
    if (method === "recall") {
      return await recallFor(env, brainCaller, args[0]);
    }
    if (method === "skills.select" || method === "skills.read") {
      return await skillsCallFor(env, brainCaller, method, args[0]);
    }
    if (method === "entities.get" || method === "entities.find") {
      return await entitiesCallFor(
        env,
        {
          ...brainCaller,
          appUsers: async () =>
            await appUsersReadBy(env, {
              app: caller.app,
              origin: caller.origin,
              personId: caller.authority.onBehalfOf,
            }),
        },
        method,
        args[0]
      );
    }
    if (method === "remember" || method === "forget") {
      return await appWriteFor(
        env,
        {
          app: caller.app,
          origin: caller.origin,
          authority: caller.authority,
          context: caller.context,
          permissionId,
          actor: caller.actor,
          key: context.idempotencyKey,
          builtInCall: caller.builtInCall(),
        },
        method,
        args[0]
      );
    }
    throw permissionErrors.create("permission.denied");
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
