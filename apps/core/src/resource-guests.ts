import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { guestErrors } from "@grasp-os/shared/guests";
import type { AppId, PermissionId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { operationErrors } from "@grasp-os/shared/operations";
import { permissionErrors } from "@grasp-os/shared/permissions";

import { loadRelease } from "./app-releases.ts";
import { findApp } from "./apps.ts";
import { inviteGuest, listGuests, readGuest, revokeGuest } from "./guests.ts";
import type { BindingCaller, ResourceAdapter } from "./resource-adapter.ts";
import { platformGrantOf } from "./resource-platform.ts";

// A guests resource (resource-bindings.ts): guest chats (guests.ts) for an
// App's sealed functions, as an admin bound them to one of the App's
// permissions to invite guests. Threat model, and how each is closed:
//
// - A declaration self-grants: it resolves only through an active binding
//   an admin approved for exactly this declaration, which names one of the
//   App's own active `{ type: "platform" }` permissions to invite guests:
//   checked as the admin approves, on every request, and by guests.ts as
//   it acts (`authorize`).
// - Someone else invites: only a person's own call does (a screen's, or an
//   agent's for its person: `interactive`); a workflow run's is refused.
//   The chat is for, and spends the model budget of, the person the call
//   acts for, as core resolved them, never anything App code sends.
// - Another App's chats: guests.ts finds a chat only by the release's own
//   App (`guest.not_found`, `resource.item_not_found` here).
// - A link that outlives the binding: a chat invited here records the
//   binding's alias, and its link opens only while an active guests
//   binding of that alias still names its permission (guests.ts,
//   `guestChat`), besides everything else a link needs.
// - Unseen: inviting, reading back and revoking are audited as the
//   caller's actor (the App for its person, or the run), as guests.ts
//   audits them; the guest's side as the guest.
//
// What a guest can reach is unchanged: the model, with the chat's guide
// and the chat, through the gateway, and nothing else.

/**
 * Whether App `app`'s current release declares a guests resource: then
 * only its binding governs its guest chats, and its v1 server's `GUESTS`
 * stub serves nothing (guests-binding.ts), so no chat it invites escapes
 * the binding's revocation. False for an App with no sealed release.
 */
export const declaresGuests = async (
  env: Env,
  app: AppId
): Promise<boolean> => {
  try {
    const found = await findApp(env, app);
    if (found.currentVersion === null) {
      return false;
    }
    const release = await loadRelease(env, found.id, found.currentVersion);
    return Object.values(release.app.resources).some(
      (declared) => declared["~resource"] === "guests"
    );
  } catch (error) {
    if (isExpectedError(error)) {
      return false;
    }
    throw error;
  }
};

/** The contract every guests binding serves. */
const guestsContract = "grasp.guests@1";

/**
 * `error`, a guest chats refusal, in the operation host's words: input
 * that doesn't fit (`resource.invalid_args`), a chat the App has no such
 * (`resource.item_not_found`), as many open as it may
 * (`resource.limit_reached`, `open`), no model to chat with
 * (`resource.unavailable`). Anything else as it is: the operation host
 * allows only its own words through.
 */
const inHostWords = (error: unknown): unknown => {
  const code = guestErrors.codeOf(error);
  if (code === "guest.invalid") {
    return operationErrors.create("resource.invalid_args");
  }
  if (code === "guest.not_found") {
    return operationErrors.create("resource.item_not_found");
  }
  if (code === "guest.too_many_open") {
    return operationErrors.create("resource.limit_reached", { limit: "open" });
  }
  if (code === "guest.no_model") {
    return operationErrors.create("resource.unavailable");
  }
  if (isExpectedError(error) && error.code === "permission.person_inactive") {
    return operationErrors.create("resource.unavailable");
  }
  return error;
};

/**
 * What a write asks just before it is made: the invocation's own gate
 * (its release, the person's role, an agent's permission, a run's lease),
 * then, for a run, that its attempt still holds, with nothing awaited
 * between that and the write.
 */
const lastCheckOf = (caller: BindingCaller) => async (): Promise<void> => {
  await caller.admit?.();
  caller.requireHolds?.();
};

/**
 * Invites a guest for `caller`: only a person's own call, never a workflow
 * run's, and never one through another App.
 */
const inviteFor = async (
  env: Env,
  caller: BindingCaller,
  permissionId: PermissionId,
  input: unknown,
  alias: string
) => {
  if (
    caller.authority.mode !== "interactive" ||
    caller.context.type !== "app" ||
    caller.context.appId !== caller.app
  ) {
    throw operationErrors.create("resource.not_allowed");
  }
  return await inviteGuest(
    env,
    caller.authority,
    permissionId,
    input,
    lastCheckOf(caller),
    { actor: caller.actor, bindingAlias: alias }
  );
};

/** A guests binding's target, served: its permission's requests. */
const served = async (env: Env, permissionId: PermissionId) => ({
  contractId: guestsContract,
  fingerprint: await sha256Hex(
    canonicalJson({ contract: guestsContract, permissionId })
  ),
  call: async (
    caller: BindingCaller,
    { method, args }: { method: string; args: readonly unknown[] },
    _context: unknown,
    _pin: unknown,
    { alias }: { alias: string }
  ): Promise<unknown> => {
    const [first] = args;
    const side = { actor: caller.actor };
    try {
      if (method === "invite") {
        return await inviteFor(env, caller, permissionId, first, alias);
      }
      if (method === "list") {
        return await listGuests(env, caller.authority, permissionId);
      }
      if (method === "read") {
        return await readGuest(
          env,
          caller.authority,
          permissionId,
          first,
          side
        );
      }
      if (method === "revoke") {
        return await revokeGuest(
          env,
          caller.authority,
          permissionId,
          first,
          lastCheckOf(caller),
          side
        );
      }
      // The operation host allows only a declared operation through.
      throw permissionErrors.create("permission.denied");
    } catch (error) {
      throw inHostWords(error);
    }
  },
});

export const guestsAdapter: ResourceAdapter<"guests"> = {
  bind: async (env, app, _declaration, target) =>
    (await platformGrantOf(env, app, target.permissionId, "guests"))
      ? await served(env, target.permissionId)
      : undefined,
};
