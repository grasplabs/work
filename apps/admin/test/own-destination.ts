/**
 * A new admin's own shared destination as its tests reach it
 * (src/hosting/placement.ts, `ensureStageDestination`): staff adding a
 * client and placing it, each through the admin's entry; and Grasp's own
 * account on the fake Cloudflare API.
 */
import { clientsNamespace, platformAccountId } from "@grasp-os/shared/names";

import { stageDestinationId } from "../src/hosting/placement.ts";
import { startClient } from "../src/provision/functions.ts";
import type { fakeCloudflareApi } from "./cloudflare-api.ts";
import { onChannel, staff } from "./hosting.ts";
import { callServerFn } from "./pages.ts";
import { placedRelease } from "./placed.ts";

/** This admin's stage, as its wrangler.jsonc sets it for the tests. */
export const stage = "production";
export const ownId = stageDestinationId(stage);

/** The binding kinds Workers for Platforms documents for user Workers. */
const documented = new Set([
  "d1",
  "r2_bucket",
  "durable_object_namespace",
  "assets",
]);

/**
 * A release a client in a Workers for Platforms namespace runs (documented
 * bindings, no cron triggers), on Stable: what a new client is
 * provisioned on.
 */
export const sharedRelease = async (): Promise<string> => {
  const releaseId = await placedRelease(
    "feat(core): the first",
    { crons: [] },
    (core) => ({
      ...core,
      bindings: core.bindings.filter(({ type }) => documented.has(type)),
    })
  );
  await onChannel(releaseId);
  return releaseId;
};

/** A client staff add, as the new-organization form does. */
export const added = async (): Promise<string> => {
  const clientId = `acme-${crypto.randomUUID().slice(0, 8)}`;
  const result = await callServerFn(
    startClient,
    {
      clientId,
      name: "Acme",
      signIn: {
        domains: ["acme.test"],
        admins: ["ada@acme.test"],
        entraTenantId: "8f3c9a52-1d4e-4b6f-9a2c-3e5d7f9b1c2a",
      },
    },
    { email: staff.email }
  );
  if (result.clientId === null) {
    throw new Error(`Adding ${clientId} was refused: ${result.refused}`);
  }
  return clientId;
};

/** Grasp's own account on the fake API, with the stage's clients' namespace in it. */
export const graspAccount = (
  cloudflare: ReturnType<typeof fakeCloudflareApi>
) => {
  const account = cloudflare.addAccount("Grasp", undefined, platformAccountId);
  account.namespaces.set(clientsNamespace(stage), new Map());
  return account;
};
