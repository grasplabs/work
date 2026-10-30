import {
  aiKeyErrors,
  aiModelChoiceSchema,
  aiProviderAddSchema,
  aiProviderErrors,
  organizationProviderIdSchema,
  organizationProviderIds,
  aiProviders,
  providerTroubles,
} from "@grasp-os/shared/ai-providers";
import type {
  AiModelChoiceNow,
  AiPlatformUse,
  AiProviderAdd,
  AiProviderId,
  AiProviderKey,
  AiProviderListed,
  AiProvidersApi,
  AiProvidersListing,
  AiProviderStatus,
  AiProviderTest,
} from "@grasp-os/shared/ai-providers";
import { actorOf } from "@grasp-os/shared/audit";
import { log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";
import { isAdmin, requireAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  aiModelsKind,
  aiRoutesOf,
  choiceNow,
  choiceOf,
  isConnectedModel,
  readModelChoice,
  readStoredChoice,
} from "./ai-model-choice.ts";
import {
  auditedBatch,
  drainConnectOutboxSoon,
  keepAuditEvent,
  outboxedIfChanged,
} from "./audit-outbox.ts";
import { activeMember } from "./auth/auth.ts";
import { orgSettings } from "./db/core/schema.ts";
import { catalogModelsOf, parseModelRef } from "./model-catalog.ts";
import { modelLedger } from "./model-ledger.ts";
import type { ProviderHealth } from "./model-ledger.ts";
import { deploymentStaysInEu, models } from "./models.ts";
import { platformAi, platformRouteFor } from "./platform-ai.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { wakeAiWaits } from "./workflows/ai-waits.ts";

// The organization's own AI providers, for its admins (@grasp-os/shared/
// ai-providers, `AiProvidersApi`): its keys, which live only in connect,
// sealed (connect's ai-providers.ts), and the models its calls use, which
// core's model gateway routes by (models.ts, ai-model-choice.ts). Its
// admins read them, Grasp staff included (whose every view is audited,
// staff-audit.ts); only its own admins change them: whose key pays for
// the organization's calls is the client's to say. Threat model, and how
// each is closed:
//
// - A key kept, logged or answered by core: `add` hands it straight to
//   connect and keeps nothing; nothing here logs a request, an error's
//   message or a parse's issues (which would quote it), and what connect
//   answers is only ever a mask (`…a3f2`).
// - A key that reaches somewhere other than its provider: an
//   OpenAI-compatible endpoint's base URL is checked by connect when it is
//   saved (no private, internal or metadata address, HTTPS only) and again
//   on every request, and is sealed with the key, which is only ever sent
//   there.
// - Someone other than the organization's own admins changing whose key
//   pays: every change requires one, never Grasp staff, checked again
//   against the members table as it is made (a session's role may be a
//   few minutes old), and is audited in their name with the provider and
//   never the key: by connect, in the same write as the key's change, so
//   a key never changes unrecorded.
// - A failure that quotes what was written: an error connect didn't name
//   (a database's, which quotes its query's values) is answered as
//   `ai_provider.failed`, never passed on.
// - A test that bypasses the gateway: it is one tiny call through the
//   model gateway like any other, judged by the rules, admitted by the
//   ledger against the admin's budgets, and audited.

/** The line a provider's test asks: no one's data. */
const testLine = "Reply with the single word OK.";

/** The most a test's answer may take: a word or two. */
const testMaxTokens = 16;

/** How long a test may take. */
const testTimeoutMs = 30_000;

/** Only the organization's own admins change its providers, never Grasp staff. */
const requireOwnAdmin = (by: Identity): void => {
  if (by.staff || !isAdmin(by.role)) {
    log.warn("ai_provider.refused", { actor: by.userId });
    throw roleErrors.create("role.forbidden");
  }
};

/**
 * `requireOwnAdmin`, and still an admin in the members table now: the
 * session's role is only as fresh as its last check, and a key change
 * can't wait for the next.
 */
const requireOwnAdminNow = async (env: Env, by: Identity): Promise<void> => {
  requireOwnAdmin(by);
  const still = await drizzle(env.DB).get<{ admin: number }>(
    sql`SELECT ${activeMember(by.userId, ["admin"])} AS admin`
  );
  if (still.admin !== 1) {
    log.warn("ai_provider.refused", { actor: by.userId });
    throw roleErrors.create("role.forbidden");
  }
};

/** A provider's status from the ledger's health, by the organization's key. */
const statusOf = (
  health: readonly ProviderHealth[],
  provider: AiProviderId
): AiProviderStatus | null => {
  const found = health.find(
    (row) => row.provider === provider && row.credential === "organization"
  );
  return found === undefined
    ? null
    : {
        lastOkAt: found.lastOkAt,
        lastFailedAt: found.lastFailedAt,
        lastFailure: found.lastFailure,
        lastStatus: found.lastStatus,
        failingClass:
          z.enum(providerTroubles).safeParse(found.failingClass).data ?? null,
        failingSince: found.failingSince,
      };
};

/** A key connect keeps, as its admins see it. */
const listed = (
  key: AiProviderKey,
  health: readonly ProviderHealth[]
): AiProviderListed => ({
  ...key,
  label: aiProviders[key.provider].label,
  whereItRuns:
    key.baseUrl === null
      ? aiProviders[key.provider].whereItRuns
      : `${aiProviders[key.provider].whereItRuns}: ${new URL(key.baseUrl).hostname}`,
  status: statusOf(health, key.provider),
  models: catalogModelsOf(key.provider),
});

/** Connect's refusal of a key, in the words of this API. */
const refusalOf = (error: unknown): Error => {
  const code = aiKeyErrors.codeOf(error);
  if (code === "ai_key.endpoint_refused") {
    return aiProviderErrors.create("ai_provider.endpoint_refused");
  }
  if (code === "ai_key.vault_unavailable") {
    return aiProviderErrors.create("ai_provider.vault_unavailable");
  }
  if (code === "ai_key.invalid") {
    return aiProviderErrors.create("ai_provider.invalid");
  }
  // Anything else, connect's `ai_key.failed` or an error it didn't name,
  // is never passed on: a database error's message quotes its query's
  // values, a sealed key and its mask among them. By its kind alone.
  log.error("ai_provider.write_failed", {
    error: error instanceof Error ? error.name : "unknown",
  });
  return aiProviderErrors.create("ai_provider.failed");
};

/**
 * `provider` as the listing names it, on Grasp's own key: its name, and
 * where its project's region sends the requests (`platformRouteFor`).
 */
const platformProvider = (
  env: Env,
  provider: AiProviderId
): NonNullable<AiPlatformUse["provider"]> => ({
  id: provider,
  label: aiProviders[provider].label,
  whereItRuns:
    platformRouteFor(env, provider)?.whereItRuns ??
    aiProviders[provider].whereItRuns,
});

/**
 * Whether a platform feature on `provider` is off for this deployment: it
 * keeps everything in the EU, and Grasp's project for the provider isn't
 * there (models.ts refuses such a call as `model.eu_only`).
 */
const offOutsideEu = (env: Env, provider: AiProviderId): boolean =>
  deploymentStaysInEu(env) && platformRouteFor(env, provider)?.region !== "eu";

/**
 * Who handles Grasp's own AI features for this deployment (platform-ai.ts),
 * on Grasp's keys whatever the organization connected: its admins can't
 * switch them off here, but they see where that data goes, and which are
 * off because the deployment keeps everything in the EU and Grasp's
 * project isn't there. Document conversion stays on the deployment where
 * knowledge/extract.ts keeps it there (`local`, or an EU-only deployment
 * whose conversion provider isn't in the EU); none at all while the
 * settings don't parse, as every feature is then off.
 */
const platformUses = (env: Env): AiPlatformUse[] => {
  const settings = platformAi(env);
  if (settings === undefined) {
    return [];
  }
  const { conversion, transcription, speech } = settings;
  return [
    {
      feature: "conversion",
      provider:
        conversion.provider === "local" ||
        offOutsideEu(env, conversion.provider)
          ? null
          : platformProvider(env, conversion.provider),
      off: false,
    },
    {
      feature: "transcription",
      provider: platformProvider(env, transcription.provider),
      off: offOutsideEu(env, transcription.provider),
    },
    {
      feature: "speech",
      provider: platformProvider(env, speech.provider),
      off: offOutsideEu(env, speech.provider),
    },
  ];
};

/** The organization's providers, as its admins see them. */
const listing = async (env: Env): Promise<AiProvidersListing> => {
  const [keys, health, choice] = await Promise.all([
    env.CONNECT.aiProviderKeys(),
    modelLedger(env).providerHealth(),
    readModelChoice(env),
  ]);
  return {
    providers: keys.map((key) => listed(key, health)),
    offered: organizationProviderIds.map((provider) => ({
      provider,
      label: aiProviders[provider].label,
      whereItRuns: aiProviders[provider].whereItRuns,
    })),
    // As it stands: never a model of a provider no longer connected.
    choice: choiceOf(
      keys.map(({ provider }) => provider),
      choice
    ),
    platform: platformUses(env),
  };
};

/**
 * Adds or replaces the provider's key in connect, which audits it in the
 * same write, in the admin's name. A new key ends what the old one's
 * refusals said: the provider no longer reads as failing
 * (`ModelLedger.keyReplaced`), and every workflow run held for a working
 * key tries again at once (`wakeAiWaits`).
 */
const addProvider = async (
  env: Env,
  by: Identity,
  request: unknown
): Promise<AiProviderListed> => {
  await requireOwnAdminNow(env, by);
  const parsed = aiProviderAddSchema.safeParse(request);
  if (!parsed.success) {
    throw aiProviderErrors.create("ai_provider.invalid");
  }
  const add: AiProviderAdd = parsed.data;
  let saved: AiProviderKey;
  try {
    saved = await env.CONNECT.saveAiProviderKey(add, actorOf(by));
  } catch (error) {
    throw refusalOf(error);
  }
  drainConnectOutboxSoon(env);
  const ledger = modelLedger(env);
  await ledger.keyReplaced(add.provider);
  await wakeAiWaits(env);
  return listed(saved, await ledger.providerHealth());
};

/** The model a test of `provider` asks: the one named, or its own. */
const testModelOf = (
  provider: AiProviderId,
  model: string | undefined
): string => {
  const named = model ?? aiProviders[provider].testModel;
  if (named === undefined || parseModelRef(named)?.provider !== provider) {
    throw aiProviderErrors.create("ai_provider.model_unavailable");
  }
  return named;
};

/** One tiny call to the provider through the gateway, audited. */
const testProvider = async (
  env: Env,
  by: Identity,
  provider: unknown,
  model: unknown
): Promise<AiProviderTest> => {
  requireOwnAdmin(by);
  const parsedProvider = organizationProviderIdSchema.safeParse(provider);
  if (
    !parsedProvider.success ||
    (model !== undefined && typeof model !== "string")
  ) {
    throw aiProviderErrors.create("ai_provider.invalid");
  }
  const routes = await aiRoutesOf(env);
  if (
    !routes.organization.some(({ provider: id }) => id === parsedProvider.data)
  ) {
    throw aiProviderErrors.create("ai_provider.not_connected");
  }
  const asked = testModelOf(parsedProvider.data, model);
  let outcome: AiProviderTest = { ok: true, model: asked };
  try {
    await models(env).providerTest(
      {
        model: asked,
        purpose: "ai_provider.test",
        trigger: actorOf(by),
        work: { platform: "provider_test" },
        input: testLine,
        maxTokens: testMaxTokens,
        timeoutMs: testTimeoutMs,
        providerRetries: false,
      },
      parsedProvider.data
    );
  } catch (error) {
    const code = modelErrors.codeOf(error);
    if (code === undefined) {
      throw error;
    }
    outcome = { ok: false, model: asked, code };
  }
  await keepAuditEvent(env, drizzle(env.DB), {
    actor: actorOf(by),
    action: "ai_provider.tested",
    target: { type: "ai_provider", id: parsedProvider.data },
    detail: {
      provider: parsedProvider.data,
      model: asked,
      ok: outcome.ok,
      code: outcome.ok ? null : outcome.code,
    },
  });
  return outcome;
};

/**
 * Keeps `choice` as the organization's models while `by` is still one of
 * its admins: the write and its audit event in one batch, recorded only
 * when it changed.
 */
const writeChoice = async (
  env: Env,
  by: Identity,
  choice: AiModelChoiceNow
): Promise<void> => {
  const { defaultModel, fallbacks } = choice;
  const value = JSON.stringify(choice);
  const now = Date.now();
  const db = drizzle(env.DB);
  // A row only while they are still an admin; written only while it
  // differs, so the same choice twice records one change.
  const whileAdmin = db
    .select({
      kind: sql<string>`${aiModelsKind}`.as("kind"),
      value: sql<string>`${value}`.as("value"),
      updatedAt: sql<Date>`${now}`.as("updated_at"),
    })
    .from(sql`(SELECT 1)`)
    .where(activeMember(by.userId, ["admin"]));
  const [written] = await auditedBatch(env, db, [
    db
      .insert(orgSettings)
      .select(whileAdmin)
      .onConflictDoUpdate({
        target: orgSettings.kind,
        set: { value, updatedAt: new Date(now) },
        setWhere: sql`${orgSettings.value} <> ${value}`,
      }),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "ai_provider.models_set",
      target: { type: "organization_ai", id: aiModelsKind },
      detail: { defaultModel, fallbacks: fallbacks.join(" ") },
    }),
  ]);
  if (written.meta.changes === 0) {
    const still = await db.get<{ admin: number }>(
      sql`SELECT ${activeMember(by.userId, ["admin"])} AS admin`
    );
    if (still.admin !== 1) {
      throw roleErrors.create("role.forbidden");
    }
  }
};

/** How often a prune is tried while other writes keep getting there first. */
const pruneAttempts = 5;

/**
 * Takes every model of a provider the organization no longer has
 * connected, as connect says now, out of its choice, while `by` is still
 * one of its admins: a default of one is none until an admin chooses
 * another. The write lands only while the stored choice is the one read
 * (compare and set), so a save another admin made meanwhile is pruned in
 * turn, never overwritten; tried again while one keeps getting there
 * first. Its audit event in the same batch, recorded only when it landed.
 */
const pruneChoice = async (env: Env, by: Identity): Promise<void> => {
  for (let attempt = 0; attempt < pruneAttempts; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- again only after a conflict
    const stored = await readStoredChoice(env);
    if (stored === null) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- again only after a conflict
    const kept = choiceNow(await aiRoutesOf(env), stored.choice);
    if (
      kept === null ||
      JSON.stringify(kept) === JSON.stringify(stored.choice)
    ) {
      return;
    }
    const value = JSON.stringify(kept);
    const db = drizzle(env.DB);
    // oxlint-disable-next-line no-await-in-loop -- again only after a conflict
    const [written] = await auditedBatch(env, db, [
      db
        .update(orgSettings)
        .set({ value, updatedAt: new Date() })
        .where(
          and(
            eq(orgSettings.kind, aiModelsKind),
            eq(orgSettings.value, stored.value),
            activeMember(by.userId, ["admin"])
          )
        ),
      outboxedIfChanged(db, {
        actor: actorOf(by),
        action: "ai_provider.models_set",
        target: { type: "organization_ai", id: aiModelsKind },
        detail: {
          defaultModel: kept.defaultModel,
          fallbacks: kept.fallbacks.join(" "),
        },
      }),
    ]);
    if (written.meta.changes > 0) {
      return;
    }
    // Unchanged since it was read: what stopped the write was `by` no
    // longer being an admin. Changed: another write got there first.
    // oxlint-disable-next-line no-await-in-loop -- again only after a conflict
    const now = await readStoredChoice(env);
    if (now?.value === stored.value) {
      throw roleErrors.create("role.forbidden");
    }
  }
  log.error("ai_models.prune_conflict", { attempts: pruneAttempts });
  throw aiProviderErrors.create("ai_provider.failed");
};

/**
 * Sets the organization's models, each one of a provider it connected,
 * while `by` is one of its own admins: the write and its audit event in
 * one batch, recorded only when it changed.
 */
const setModels = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<void> => {
  requireOwnAdmin(by);
  const parsed = aiModelChoiceSchema.safeParse(input);
  if (!parsed.success) {
    throw aiProviderErrors.create("ai_provider.invalid");
  }
  const routes = await aiRoutesOf(env);
  const { defaultModel } = parsed.data;
  const fallbacks = [...new Set(parsed.data.fallbacks)].filter(
    (model) => model !== defaultModel
  );
  if (
    ![defaultModel, ...fallbacks].every((model) =>
      isConnectedModel(routes, model)
    )
  ) {
    throw aiProviderErrors.create("ai_provider.model_unavailable");
  }
  await writeChoice(env, by, { defaultModel, fallbacks });
  // A provider removed since the check above leaves none of its models.
  await pruneChoice(env, by);
};

/**
 * Removes the provider's key from connect, which audits it in the same
 * write when it had one, in the admin's name.
 */
const removeProvider = async (
  env: Env,
  by: Identity,
  provider: unknown
): Promise<void> => {
  await requireOwnAdminNow(env, by);
  const parsed = organizationProviderIdSchema.safeParse(provider);
  if (!parsed.success) {
    throw aiProviderErrors.create("ai_provider.invalid");
  }
  let removed: boolean;
  try {
    removed = await env.CONNECT.removeAiProviderKey(parsed.data, actorOf(by));
  } catch (error) {
    throw refusalOf(error);
  }
  if (removed) {
    drainConnectOutboxSoon(env);
  }
  // Its models go from the choice too, so none is offered or saved again.
  await pruneChoice(env, by);
};

/** The organization's AI providers over `/rpc`, for admins. */
export class AiProvidersRpc extends CoreRpcTarget implements AiProvidersApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(): Promise<AiProvidersListing> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      return await listing(this.#env);
    });
  }

  async add(request: AiProviderAdd): Promise<AiProviderListed> {
    return await withPerson(
      this.#check,
      async (person) => await addProvider(this.#env, person, request)
    );
  }

  async test(provider: AiProviderId, model?: string): Promise<AiProviderTest> {
    return await withPerson(
      this.#check,
      async (person) => await testProvider(this.#env, person, provider, model)
    );
  }

  async setModels(choice: z.input<typeof aiModelChoiceSchema>): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await setModels(this.#env, person, choice);
    });
  }

  async remove(provider: AiProviderId): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await removeProvider(this.#env, person, provider);
    });
  }
}
