import type { HeldIn, PendingAction } from "@grasp-os/shared/connect";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";

import { personOf } from "../src/connections.ts";

/**
 * The writes connect holds for `person` that were held where `heldIn`
 * says. Grasp's own list (`pendingActions.list`) shows only those held in
 * Grasp, never in a chat app's conversation, whose writes are decided on
 * their card there: what a test of a chat app reads here.
 */
export const heldFor = async (
  person: { api: { whoami: () => Promise<Identity> } },
  heldIn: HeldIn
): Promise<PendingAction[]> =>
  await env.CONNECT.listPendingActions(
    await personOf(env, await person.api.whoami()),
    heldIn
  );
