/**
 * The channels' server functions, behind the Access check every request
 * passes (src/access.ts). The changes act as the verified staff member the
 * request comes from, and answer a refusal as its code
 * (`RolloutErrorCode`), which the page words; anything else fails.
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { adminDatabase } from "../db/act.ts";
import { deploySecrets, MissingStoreSecretError } from "../deploy/context.ts";
import type { DeploySecrets } from "../deploy/secrets.ts";
import {
  channelSchema,
  pinClient,
  pinSchema,
  promoteRelease,
  promoteSchema,
  resumeRollout,
  resumeSchema,
  retryClient,
  retryClientSchema,
  setClientChannel,
} from "./channels.ts";
import { driftOf } from "./drift.ts";
import type { ClientDrift } from "./drift.ts";
import { RolloutError } from "./errors.ts";
import type { RolloutErrorCode } from "./errors.ts";
import { runRolloutPass } from "./scheduler.ts";
import {
  checkRevocation,
  sharedSecretsStatus,
  storeCheck,
} from "./shared-secrets.ts";

const clientSchema = z.object({ clientId: z.string().min(1) });

/** What a change answers: done, or why it was refused. */
export type RolloutChange =
  | { done: true; refused: null }
  | { done: false; refused: RolloutErrorCode };

/**
 * Runs `task`, a refusal answered as its code, then the rollout pass
 * once, so what staff changed starts deploying now rather than at the
 * cron's next minute. A pass that fails is logged: the cron runs the next.
 */
const change = async (task: () => Promise<void>): Promise<RolloutChange> => {
  try {
    await task();
  } catch (error) {
    if (error instanceof RolloutError) {
      return { done: false, refused: error.code };
    }
    throw error;
  }
  await runRolloutPass(env);
  return { done: true, refused: null };
};

export const promoteReleaseFn = createServerFn({ method: "POST" })
  .validator(promoteSchema)
  .handler(
    async ({ data, context }) =>
      await change(async () => {
        await promoteRelease(env, context.staff, data);
      })
  );

export const resumeRolloutFn = createServerFn({ method: "POST" })
  .validator(resumeSchema)
  .handler(
    async ({ data, context }) =>
      await change(async () => {
        await resumeRollout(env, context.staff, data);
      })
  );

export const retryClientFn = createServerFn({ method: "POST" })
  .validator(retryClientSchema)
  .handler(
    async ({ data, context }) =>
      await change(async () => {
        await retryClient(env, context.staff, data);
      })
  );

export const pinClientFn = createServerFn({ method: "POST" })
  .validator(pinSchema)
  .handler(
    async ({ data, context }) =>
      await change(async () => {
        await pinClient(env, context.staff, data);
      })
  );

export const setChannelFn = createServerFn({ method: "POST" })
  .validator(channelSchema)
  .handler(
    async ({ data, context }) =>
      await change(async () => {
        await setClientChannel(env, context.staff, data);
      })
  );

/**
 * A client's drift, read live from its account, with whether it runs the
 * shared secrets in Secrets Store now: null when that can't be told, the
 * store unreadable or, as `sharedSecretsStatus` finds it, the client's
 * drift unknown.
 */
export type DriftCheck = ClientDrift & { sharedSecretsCurrent: boolean | null };

/** A client's drift, read live from its account when staff ask. */
export const fetchDrift = createServerFn({ method: "GET" })
  .validator(clientSchema)
  .handler(async ({ data }): Promise<DriftCheck | null> => {
    const db = adminDatabase(env.DB);
    let store: DeploySecrets | null = null;
    try {
      store = await deploySecrets(env);
    } catch (error) {
      if (!(error instanceof MissingStoreSecretError)) {
        throw error;
      }
    }
    const drift = await driftOf(
      db,
      data.clientId,
      store === null
        ? undefined
        : { dispatcher: env.DISPATCHER, secrets: store }
    );
    if (drift === null) {
      return null;
    }
    return {
      ...drift,
      sharedSecretsCurrent:
        store === null
          ? null
          : await sharedSecretsStatus(db, drift, await storeCheck(store)),
    };
  });

/**
 * Which shared secrets' old values can be revoked: checked now,
 * read live from every active client's account when staff ask, a few at a
 * time, each within a deadline.
 */
export const checkRevocationFn = createServerFn({ method: "GET" }).handler(
  async () => await checkRevocation(env)
);
