import type {
  GuestChat,
  GuestInvitation,
  GuestTranscript,
} from "@grasp-os/shared/guests";
import { guestErrors } from "@grasp-os/shared/guests";
import type { AppId, PermissionId } from "@grasp-os/shared/ids";
import type { Authority } from "@grasp-os/shared/permissions";
import { WorkerEntrypoint } from "cloudflare:workers";

import { callerOf, stillAdmitted, tokenOf } from "./app-bindings.ts";
import type { InvocationKind } from "./app.ts";
import { forSandbox } from "./bindings.ts";
import { inviteGuest, listGuests, readGuest, revokeGuest } from "./guests.ts";

/**
 * Guest chats, as an App's server code holds them under the permission an
 * admin granted it (`{ type: "platform" }`, `guests`), by that
 * permission's name: `await this.env.GUESTS.invite(caller, { name, skill
 * })` (guests.ts). Like every stub, each call passes the caller of the App
 * method it runs in, and acts for them, only while that call runs. Only
 * a person using the App invites (`guest.invalid` for a workflow run's
 * call, or one through another App's export): the member a chat is made
 * for, and spends the budget of, is always the one who asked for it. The
 * permission is checked again on every call.
 */
export class AppGuestsBinding extends WorkerEntrypoint<
  Env,
  { app: AppId; permissionId: PermissionId }
> {
  /** Invites a guest: the answer holds the link, shown once. */
  async invite(caller: unknown, input: unknown): Promise<GuestInvitation> {
    return await this.#run(
      caller,
      "write",
      async (authority, permissionId, lastCheck) =>
        await inviteGuest(this.env, authority, permissionId, input, lastCheck),
      { personOnly: true }
    );
  }

  /** The App's guest chats, newest first. */
  async list(caller: unknown): Promise<GuestChat[]> {
    return await this.#run(
      caller,
      "read",
      async (authority, permissionId) =>
        await listGuests(this.env, authority, permissionId)
    );
  }

  /** A guest chat of the App, with what was written: untrusted text. */
  async read(caller: unknown, id: unknown): Promise<GuestTranscript> {
    return await this.#run(
      caller,
      "read",
      async (authority, permissionId) =>
        await readGuest(this.env, authority, permissionId, id)
    );
  }

  /** Stops a guest chat's link. */
  async revoke(caller: unknown, id: unknown): Promise<GuestChat> {
    return await this.#run(
      caller,
      "write",
      async (authority, permissionId, lastCheck) =>
        await revokeGuest(this.env, authority, permissionId, id, lastCheck)
    );
  }

  /**
   * Runs `run` for `caller`, admitted for `use` (a change, or a read:
   * `callerOf`), with errors as the sandbox sees them, and what `run` asks
   * just before it writes (`lastCheck`): the host again, for `use`.
   */
  async #run<T>(
    caller: unknown,
    use: InvocationKind,
    run: (
      authority: Authority,
      permissionId: PermissionId,
      lastCheck: () => Promise<void>
    ) => Promise<T>,
    { personOnly = false }: { personOnly?: boolean } = {}
  ): Promise<T> {
    const { app, permissionId } = this.ctx.props;
    try {
      const token = tokenOf(caller);
      const { authority, path } = await callerOf(this.env, app, { token }, use);
      const person =
        authority.mode === "interactive" && path.chain.length === 1;
      if (personOnly && !person) {
        throw guestErrors.create("guest.invalid");
      }
      return await run(authority, permissionId, async () => {
        await stillAdmitted(this.env, app, token, use);
      });
    } catch (error) {
      throw forSandbox(error);
    }
  }
}
