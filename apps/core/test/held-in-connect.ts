import type { PendingAction } from "@grasp-os/shared/connect";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";

import { personOf } from "../src/connections.ts";

/**
 * Every write connect holds for `person`, wherever its agent held it.
 * Grasp's own list (`pendingActions.list`) shows only what was held in a
 * chat Grasp shows them, never in a chat app's conversation, whose writes
 * are decided on their card there: what a test of a chat app reads here.
 */
export const heldFor = async (person: {
  api: { whoami: () => Promise<Identity> };
}): Promise<PendingAction[]> =>
  await env.CONNECT.listPendingActions(
    await personOf(env, await person.api.whoami())
  );
