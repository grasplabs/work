import { sha256Hex } from "@grasp-os/shared/encoding";
import { permissionIdSchema } from "@grasp-os/shared/ids";
import type { PermissionId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { permissionErrors } from "@grasp-os/shared/permissions";

import { readableByEveryMember, sourcesOf } from "./app-provenance.ts";
import { memoriesCallFor, recallFor, skillsCallFor } from "./brain-recall.ts";
import type { MemoriesOperation } from "./brain-recall.ts";
import type { ResourceAdapter, ServedBinding } from "./resource-adapter.ts";
import { platformGrantOf } from "./resource-platform.ts";

// A brain resource (resource-bindings.ts): `ctx.brain.recall`,
// `ctx.brain.skills`, `remember`, `forget`, `correct` and
// `ctx.brain.entities` for an App's actions, as an admin bound the App's
// `brain` declaration to one of the App's own `{ type: "platform" }`
// permissions to read the Brain. A declaration grants nothing: it
// resolves only through an active binding approved for exactly it,
// naming the App's own active permission, which `recallFor`,
// `skillsCallFor` and `memoriesCallFor` check again on each call, then
// read only what everyone in the company may read, for whoever the call
// acts for (threat models on GRA-1731, GRA-1830 and GRA-1837). A write
// is in the App's own word (`app:<id>`), read by the company, and only
// while every member may read every source the App may have read
// (app-provenance.ts): its sharing rule, held for the whole company.

/** The Brain's operations on memories and entities, as `memoriesCallFor` takes them. */
const memoriesOperations: ReadonlySet<string> = new Set<MemoriesOperation>([
  "remember",
  "forget",
  "correct",
  "entities.get",
  "entities.find",
]);

/** Whether `method` is one of them. */
const isMemoriesOperation = (method: string): method is MemoriesOperation =>
  memoriesOperations.has(method);

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
    if (isMemoriesOperation(method)) {
      return await memoriesCallFor(
        env,
        {
          ...brainCaller,
          writer: `app:${caller.app}`,
          // One change per call: a call is the App's one intent.
          change: `app:${caller.app}:${crypto.randomUUID()}`,
          mayWrite: async () => {
            if (!readableByEveryMember(await sourcesOf(env, caller.app))) {
              throw permissionErrors.create("permission.denied", {
                action: "brain.write",
              });
            }
          },
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
