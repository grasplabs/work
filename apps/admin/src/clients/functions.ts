/**
 * A client's own Grasp as the admin reads and changes it (its Setup, and
 * the overview's and Platform's live columns), behind the Access check
 * every request passes (src/access.ts). The
 * changes act as the verified staff member the request comes from, and
 * answer a refusal as its code (`SettingsErrorCode`), which the page
 * words; anything else fails.
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { sendStaffAlert } from "../alerts.ts";
import type { AlertOutcome } from "../alerts.ts";
import { adminDatabase, audit } from "../db/act.ts";
import { rotateClientSecrets } from "../deploy/rotation.ts";
import { adminReader } from "./admin.ts";
import { applySettings } from "./apply.ts";
import { clientGrid, defaultLiveOptions, gridLive } from "./grid.ts";
import type { LiveStatus } from "./grid.ts";
import { clientModelSpend } from "./model-spend.ts";
import { clientModelTransport } from "./model-transport.ts";
import { clientQuotaPolicy } from "./quota-policy.ts";
import {
  modelSpendCeilingInputSchema,
  modelTransportInputSchema,
  ringInputSchema,
  sealedSecretInputSchema,
  setModelSpendCeiling,
  setModelTransport,
  setRing,
  setSealedSecret,
  setSignIn,
  setTeamsBot,
  SettingsError,
  signInInputSchema,
  teamsBotInputSchema,
} from "./settings.ts";
import type { SettingsErrorCode } from "./settings.ts";
import { getClientSetup } from "./setup.ts";
import { clientTeamsPackage } from "./teams-package.ts";

const clientSchema = z.object({ clientId: z.string().min(1) });

/** What a change answers: whether it changed anything, or why it was refused. */
export type SettingsChange =
  | { changed: boolean; refused: null }
  | { changed: null; refused: SettingsErrorCode };

/** Runs `task`, a refusal answered as its code. */
const change = async (
  task: () => Promise<boolean>
): Promise<SettingsChange> => {
  try {
    return { changed: await task(), refused: null };
  } catch (error) {
    if (error instanceof SettingsError) {
      return { changed: null, refused: error.code };
    }
    throw error;
  }
};

/** Every client, as the grid shows it at once: what the admin recorded. */
export const fetchClientGrid = createServerFn({ method: "GET" }).handler(
  async () => await clientGrid(env)
);

/**
 * Each active client's live columns, by id, read after the grid shows
 * (`gridLive`): a few at a time, each within a deadline, kept a minute
 * unless anything in them is unknown.
 */
export const fetchGridLive = createServerFn({ method: "GET" }).handler(
  async () => await gridLive(env)
);

/**
 * One active client's live columns, as the grid reads them (`gridLive`),
 * for its Setup in the admin; null for a client that isn't active.
 */
export const fetchClientLive = createServerFn({ method: "GET" })
  .validator(clientSchema)
  .handler(async ({ data }): Promise<LiveStatus | null> => {
    const live = await gridLive(env, defaultLiveOptions, data.clientId);
    return live[data.clientId] ?? null;
  });

/**
 * Every client's admin snapshot, as its core answers the verified staff
 * member asking (whom its audit log records), or as not reachable since it
 * last answered (`clientAdmins`). A POST, though it reads: it keeps when
 * each core answered, and every core's audit log records the read, so it
 * takes the same-origin check every change does (src/access.ts).
 */
export const fetchClientAdmins = createServerFn({ method: "POST" }).handler(
  async ({ context }) => await adminReader(env, context.staff)()
);

/** A client's own Grasp as the admin runs it, for the admin's Setup; null for no such client. */
export const fetchClientSetup = createServerFn({ method: "GET" })
  .validator(clientSchema)
  .handler(async ({ data }) => await getClientSetup(env, data.clientId));

/**
 * A client's quota policy: the generation the admin sets beside the one
 * its core applies, read live; null for no such client.
 */
export const fetchClientQuotaPolicy = createServerFn({ method: "GET" })
  .validator(clientSchema)
  .handler(async ({ data }) => await clientQuotaPolicy(env, data.clientId));

/**
 * A client's model spend this month as its core's ledger counts it, read
 * live; null when unknown.
 */
export const fetchClientModelSpend = createServerFn({ method: "GET" })
  .validator(clientSchema)
  .handler(async ({ data }) => await clientModelSpend(env, data.clientId));

/**
 * A client's AI: how its core reaches its models and where they run,
 * its core read live; null when there's no such client.
 */
export const fetchClientModelTransport = createServerFn({ method: "GET" })
  .validator(clientSchema)
  .handler(async ({ data }) => await clientModelTransport(env, data.clientId));

/**
 * A client's AI as its core reports it now, after one small model call
 * through its gateway made for the staff member asking, whom core's audit
 * log names; null when there's no such client.
 */
export const checkModelTransportFn = createServerFn({ method: "POST" })
  .validator(clientSchema)
  .handler(
    async ({ data, context }) =>
      await clientModelTransport(env, data.clientId, context.staff)
  );

export const setRingFn = createServerFn({ method: "POST" })
  .validator(ringInputSchema)
  .handler(
    async ({ data, context }) =>
      await change(async () => await setRing(env, context.staff, data))
  );

/**
 * Sets a client's monthly model spend ceiling, in whole euros, audited:
 * its core's gateway holds it to it from its next deploy.
 */
export const setModelSpendCeilingFn = createServerFn({ method: "POST" })
  .validator(modelSpendCeilingInputSchema)
  .handler(
    async ({ data, context }) =>
      await change(
        async () => await setModelSpendCeiling(env, context.staff, data)
      )
  );

/**
 * Sets a client's model transport, or takes it away (back to the
 * platform's default), audited: its core takes it with its next deploy.
 */
export const setModelTransportFn = createServerFn({ method: "POST" })
  .validator(modelTransportInputSchema)
  .handler(
    async ({ data, context }) =>
      await change(
        async () => await setModelTransport(env, context.staff, data)
      )
  );

/** Applies a client's settings now: a deploy of the release it runs, live at once. */
export const applySettingsFn = createServerFn({ method: "POST" })
  .validator(clientSchema)
  .handler(
    async ({ data, context }) =>
      await change(async () => {
        await applySettings(env, context.staff, data.clientId);
        return true;
      })
  );

export const setSignInFn = createServerFn({ method: "POST" })
  .validator(signInInputSchema)
  .handler(
    async ({ data, context }) =>
      await change(async () => await setSignIn(env, context.staff, data))
  );

/**
 * Seals a secret of a client's own, such as its Teams bot's, replacing the
 * one it had. It answers whether it changed, never the value: nothing
 * reads one back.
 */
export const setSealedSecretFn = createServerFn({ method: "POST" })
  .validator(sealedSecretInputSchema)
  .handler(
    async ({ data, context }) =>
      await change(async () => await setSealedSecret(env, context.staff, data))
  );

/**
 * Sets a client's Teams bot (its app id, tenant and secret's expiry), or
 * takes it away with null: its connect and core get it with the next
 * deploy.
 */
export const setTeamsBotFn = createServerFn({ method: "POST" })
  .validator(teamsBotInputSchema)
  .handler(
    async ({ data, context }) =>
      await change(async () => await setTeamsBot(env, context.staff, data))
  );

/**
 * A client's Teams app package (src/clients/teams-package.ts), for its IT
 * to upload to Teams; null for a client without a bot. Nothing in it is
 * secret: the bot's id and the client's name.
 */
export const fetchTeamsPackageFn = createServerFn({ method: "GET" })
  .validator(clientSchema)
  .handler(
    async ({ data }) =>
      await clientTeamsPackage(adminDatabase(env.DB), data.clientId)
  );

/**
 * Sends a test alert about a client to the staff alerts' channel
 * (src/alerts.ts), to see the channel works: audited as the staff member
 * who sent it (`alert.test`), and answered with what became of it.
 */
export const sendTestAlertFn = createServerFn({ method: "POST" })
  .validator(clientSchema)
  .handler(async ({ data, context }): Promise<AlertOutcome> => {
    await audit(adminDatabase(env.DB), context.staff, {
      action: "alert.test",
      clientId: data.clientId,
    });
    return await sendStaffAlert(env, { clientId: data.clientId, kind: "test" });
  });

/**
 * Rotates a client's derived secrets (src/deploy/rotation.ts): changed
 * false when its last rotation isn't live yet, or went live too recently.
 */
export const rotateSecretsFn = createServerFn({ method: "POST" })
  .validator(clientSchema)
  .handler(
    async ({ data, context }) =>
      await change(
        async () =>
          await rotateClientSecrets(
            adminDatabase(env.DB),
            context.staff,
            data.clientId,
            new Date()
          )
      )
  );
