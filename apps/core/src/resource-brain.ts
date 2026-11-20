import { sha256Hex } from "@grasp-os/shared/encoding";
import { permissionIdSchema } from "@grasp-os/shared/ids";
import type { PermissionId, AppId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { drizzle } from "drizzle-orm/d1";

import { appUsersReadBy, appWriteFor } from "./brain-app-writes.ts";
import { entitiesCallFor, recallFor, skillsCallFor } from "./brain-recall.ts";
import type { RecallCaller } from "./brain-recall.ts";
import { brainDefaultReads } from "./db/core/schema.ts";
import type { BoundResource } from "./function-host.ts";
import type {
  BindingCaller,
  ResourceAdapter,
  ServedBinding,
} from "./resource-adapter.ts";
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

/**
 * Brain read `method` with `args` for `caller`: a recall, skills,
 * entities (`appUsers` adds what the App remembered for a person on its
 * page who uses it now). `permission.denied` for anything else.
 */
const brainRead = async (
  env: Env,
  caller: Omit<RecallCaller, "keep">,
  method: string,
  args: readonly unknown[],
  appUsers?: () => Promise<AppId | undefined>
) => {
  if (method === "recall") {
    return await recallFor(env, caller, args[0]);
  }
  if (method === "skills.select" || method === "skills.read") {
    return await skillsCallFor(env, caller, method, args[0]);
  }
  if (method === "entities.get" || method === "entities.find") {
    return await entitiesCallFor(
      env,
      { ...caller, ...(appUsers === undefined ? {} : { appUsers }) },
      method,
      args[0]
    );
  }
  throw permissionErrors.create("permission.denied");
};

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
    return await brainRead(
      env,
      brainCaller,
      method,
      args,
      async () =>
        await appUsersReadBy(env, {
          app: caller.app,
          origin: caller.origin,
          personId: caller.authority.onBehalfOf,
        })
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

/**
 * The Brain's reads for App `caller.app` when it declares no permission
 * to read it (GRA-2218; the threat model is on the issue), which the
 * function host lets through alone (the runtime's `brainByDefault`): of
 * only what everyone in the company may read, with no grant, so no
 * team's and nobody's own (`recallFor`, `byDefault`), for a person each
 * read finds a member now, as every reader of the Brain. A visitor's
 * call never gets here: it is bound no resource. The App is marked
 * (`brain_default_reads`), for good, before anything is read: from then
 * on it answers no visitor and invites no guest, as a granted App
 * (app-provenance.ts `recallsTheBrain`). A mark that can't be written
 * refuses the read.
 */
export const brainByDefault = (
  env: Env,
  caller: BindingCaller
): BoundResource => ({
  kind: "brain",
  contract: null,
  call: async (method, args) => {
    await drizzle(env.DB)
      .insert(brainDefaultReads)
      .values({
        subjectType: "app",
        subjectId: caller.app,
        firstReadAt: new Date(),
      })
      .onConflictDoNothing();
    return await brainRead(
      env,
      {
        authority: caller.authority,
        context: caller.context,
        permissionId: null,
        byDefault: true,
        actor: caller.actor,
        target: { type: "app", id: caller.app },
      },
      method,
      args
    );
  },
});
