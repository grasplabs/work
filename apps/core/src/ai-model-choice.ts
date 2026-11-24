import {
  aiModelChoiceNowSchema,
  aiSourceSchema,
  graspAi,
} from "@grasp-os/shared/ai-providers";
import type {
  AiModelChoiceNow,
  AiProviderId,
  AiProviderRoutes,
  AiSource,
} from "@grasp-os/shared/ai-providers";
import { log } from "@grasp-os/shared/log";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { orgSettings } from "./db/core/schema.ts";
import { parseModelRef } from "./model-catalog.ts";

// The organization's own AI providers, as core's model gateway routes by
// them (models.ts): which providers it connected, from connect, which holds
// their keys (`aiProviderRoutes`, never a key), and the models its admins
// chose, its default and fallbacks, kept beside its other settings
// (`org_settings`, kind `ai_models`): the only models its calls may use.
// A provider's removal drops its models from the choice (ai-providers.ts),
// and the choice is read as it stands, each model of a provider still
// connected (`choiceNow`), so a removed one is never offered, saved again
// or called.

/** The setting's kind in `org_settings`. */
export const aiModelsKind = "ai_models";

/** The organization's providers and Grasp's, from connect: never a key. */
export const aiRoutesOf = async (
  env: Pick<Env, "CONNECT">
): Promise<AiProviderRoutes> => await env.CONNECT.aiProviderRoutes();

/**
 * The models the organization's admins chose, and the stored value they
 * were read from, for a write that only lands while it is still that
 * value: none until they chose, or when it no longer parses.
 */
export const readStoredChoice = async (
  env: Pick<Env, "DB">
): Promise<{ value: string; choice: AiModelChoiceNow } | null> => {
  const [row] = await drizzle(env.DB)
    .select({ value: orgSettings.value })
    .from(orgSettings)
    .where(eq(orgSettings.kind, aiModelsKind));
  if (row === undefined) {
    return null;
  }
  let value: unknown = undefined;
  try {
    value = JSON.parse(row.value);
  } catch {
    value = undefined;
  }
  const parsed = aiModelChoiceNowSchema.safeParse(value);
  if (!parsed.success) {
    log.warn("ai_models.unreadable", {});
    return null;
  }
  return { value: row.value, choice: parsed.data };
};

/**
 * The models the organization's admins chose, as stored, checked again as
 * read: none until they chose, or when it no longer parses.
 */
export const readModelChoice = async (
  env: Pick<Env, "DB">
): Promise<AiModelChoiceNow | null> => {
  const stored = await readStoredChoice(env);
  return stored?.choice ?? null;
};

/** The setting's kind in `org_settings` for whose key the organization's AI runs on. */
export const aiSourceKind = "ai_source";

const storedSourceSchema = z.strictObject({ source: aiSourceSchema });

/**
 * Whose key the organization's AI runs on: its own until its admins chose
 * Grasp's AI, and its own again when what is stored no longer parses.
 * Never Grasp's key by default or by mistake: Grasp pays for every call
 * on it.
 */
export const readAiSource = async (env: Pick<Env, "DB">): Promise<AiSource> => {
  const [row] = await drizzle(env.DB)
    .select({ value: orgSettings.value })
    .from(orgSettings)
    .where(eq(orgSettings.kind, aiSourceKind));
  if (row === undefined) {
    return "own";
  }
  let value: unknown = undefined;
  try {
    value = JSON.parse(row.value);
  } catch {
    value = undefined;
  }
  const parsed = storedSourceSchema.safeParse(value);
  if (!parsed.success) {
    log.warn("ai_source.unreadable", {});
    return "own";
  }
  return parsed.data.source;
};

/** Whether this deployment has Grasp's key for Grasp's AI. */
export const graspAiAvailable = (routes: AiProviderRoutes): boolean =>
  routes.platform.includes(graspAi.provider);

/** Whether `model` is one of `providers`. */
const isModelOf = (
  providers: readonly AiProviderId[],
  model: string
): boolean => {
  const ref = parseModelRef(model);
  return (
    ref !== undefined && providers.some((provider) => provider === ref.provider)
  );
};

/** The providers the organization connected. */
const connectedOf = (routes: AiProviderRoutes): AiProviderId[] =>
  routes.organization.map(({ provider }) => provider);

/** Whether `model` is one of a provider the organization connected. */
export const isConnectedModel = (
  routes: AiProviderRoutes,
  model: string
): boolean => isModelOf(connectedOf(routes), model);

/**
 * `choice` without the models of providers other than `providers`: its
 * default none when it was of one of them.
 */
export const choiceOf = (
  providers: readonly AiProviderId[],
  choice: AiModelChoiceNow | null
): AiModelChoiceNow | null =>
  choice === null
    ? null
    : {
        defaultModel:
          choice.defaultModel !== null &&
          isModelOf(providers, choice.defaultModel)
            ? choice.defaultModel
            : null,
        fallbacks: choice.fallbacks.filter((model) =>
          isModelOf(providers, model)
        ),
      };

/** The choice as it stands: each model of a provider still connected. */
export const choiceNow = (
  routes: AiProviderRoutes,
  choice: AiModelChoiceNow | null
): AiModelChoiceNow | null => choiceOf(connectedOf(routes), choice);

/**
 * The models the organization's calls may use, in order: its default,
 * then its fallbacks, each of a provider it still has connected. None
 * until it chose.
 */
export const chosenModels = (
  routes: AiProviderRoutes,
  choice: AiModelChoiceNow | null
): string[] => {
  const now = choiceNow(routes, choice);
  return now === null
    ? []
    : [
        ...new Set(
          now.defaultModel === null
            ? now.fallbacks
            : [now.defaultModel, ...now.fallbacks]
        ),
      ];
};

/**
 * The models the organization's calls may use now, in order. On its own
 * key, the ones its admins chose (`chosenModels`). On Grasp's AI, Grasp's
 * one model and no other, whatever it chose or connected; none where this
 * deployment has no key of Grasp's for it, never a model on its own key
 * instead: a call goes on the key the organization chose, or nowhere.
 */
export const usableModels = (
  routes: AiProviderRoutes,
  choice: AiModelChoiceNow | null,
  source: AiSource
): string[] => {
  if (source === "grasp") {
    return graspAiAvailable(routes) ? [graspAi.model] : [];
  }
  return chosenModels(routes, choice);
};
