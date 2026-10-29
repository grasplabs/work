import {
  aiKeyErrors,
  aiModelChoiceSchema,
  aiProviderAddSchema,
  aiProviderErrors,
  aiProviderIdSchema,
  aiProviderIds,
  aiProviders,
} from "@grasp-os/shared/ai-providers";
import type {
  AiModelChoice,
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
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { z } from "zod";

import {
  aiModelsKind,
  aiRoutesOf,
  isConnectedModel,
  readModelChoice,
} from "./ai-model-choice.ts";
import {
  auditedBatch,
  keepAuditEvent,
  outboxedIfChanged,
} from "./audit-outbox.ts";
import { activeMember } from "./auth/auth.ts";
import { orgSettings } from "./db/core/schema.ts";
import { parseModelRef } from "./model-catalog.ts";
import { modelLedger } from "./model-ledger.ts";
import type { ProviderHealth } from "./model-ledger.ts";
import { models } from "./models.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

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
//   answers is only ever a mask (`sk-…a3f2`).
// - A key that reaches somewhere other than its provider: an
//   OpenAI-compatible endpoint's base URL is checked by connect when it is
//   saved (no private, internal or metadata address, HTTPS only) and again
//   on every request, and is sealed with the key, which is only ever sent
//   there.
// - Someone other than the organization's own admins changing whose key
//   pays: every change requires one, never Grasp staff, and is audited in
//   their name with the provider and never the key.
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
  return error instanceof Error ? error : new Error("Saving the key failed");
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
    offered: aiProviderIds.map((provider) => ({
      provider,
      label: aiProviders[provider].label,
      whereItRuns: aiProviders[provider].whereItRuns,
    })),
    choice,
  };
};

/** Adds or replaces the provider's key in connect, and audits it. */
const addProvider = async (
  env: Env,
  by: Identity,
  request: unknown
): Promise<AiProviderListed> => {
  requireOwnAdmin(by);
  const parsed = aiProviderAddSchema.safeParse(request);
  if (!parsed.success) {
    throw aiProviderErrors.create("ai_provider.invalid");
  }
  const add: AiProviderAdd = parsed.data;
  const before = await env.CONNECT.aiProviderKeys();
  let saved: AiProviderKey;
  try {
    saved = await env.CONNECT.saveAiProviderKey(add);
  } catch (error) {
    throw refusalOf(error);
  }
  const replaced = before.some(({ provider }) => provider === add.provider);
  await keepAuditEvent(env, drizzle(env.DB), {
    actor: actorOf(by),
    action: replaced ? "ai_provider.replaced" : "ai_provider.added",
    target: { type: "ai_provider", id: add.provider },
    detail: {
      provider: add.provider,
      endpointHost:
        saved.baseUrl === null ? null : new URL(saved.baseUrl).hostname,
    },
  });
  return listed(saved, await modelLedger(env).providerHealth());
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
  const parsedProvider = aiProviderIdSchema.safeParse(provider);
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
  const choice: AiModelChoice = { defaultModel, fallbacks };
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

/** Removes the provider's key from connect, and audits it when it had one. */
const removeProvider = async (
  env: Env,
  by: Identity,
  provider: unknown
): Promise<void> => {
  requireOwnAdmin(by);
  const parsed = aiProviderIdSchema.safeParse(provider);
  if (!parsed.success) {
    throw aiProviderErrors.create("ai_provider.invalid");
  }
  if (!(await env.CONNECT.removeAiProviderKey(parsed.data))) {
    return;
  }
  await keepAuditEvent(env, drizzle(env.DB), {
    actor: actorOf(by),
    action: "ai_provider.removed",
    target: { type: "ai_provider", id: parsed.data },
    detail: { provider: parsed.data },
  });
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
