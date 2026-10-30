import { aiModelChoiceSchema } from "@grasp-os/shared/ai-providers";
import type {
  AiModelChoice,
  AiProviderRoutes,
} from "@grasp-os/shared/ai-providers";
import { log } from "@grasp-os/shared/log";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { orgSettings } from "./db/core/schema.ts";
import { parseModelRef } from "./model-catalog.ts";

// The organization's own AI providers, as core's model gateway routes by
// them (models.ts): which providers it connected, from connect, which holds
// their keys (`aiProviderRoutes`, never a key), and the models its admins
// chose, its default and fallbacks, kept beside its other settings
// (`org_settings`, kind `ai_models`): the only models its calls may use.

/** The setting's kind in `org_settings`. */
export const aiModelsKind = "ai_models";

/** The organization's providers and Grasp's, from connect: never a key. */
export const aiRoutesOf = async (
  env: Pick<Env, "CONNECT">
): Promise<AiProviderRoutes> => await env.CONNECT.aiProviderRoutes();

/**
 * The models the organization's admins chose, as stored, checked again as
 * read: none until they chose, or when it no longer parses.
 */
export const readModelChoice = async (
  env: Pick<Env, "DB">
): Promise<AiModelChoice | null> => {
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
  const parsed = aiModelChoiceSchema.safeParse(value);
  if (!parsed.success) {
    log.warn("ai_models.unreadable", {});
    return null;
  }
  return parsed.data;
};

/** Whether `model` is one of a provider the organization connected. */
export const isConnectedModel = (
  routes: AiProviderRoutes,
  model: string
): boolean => {
  const ref = parseModelRef(model);
  return (
    ref !== undefined &&
    routes.organization.some(({ provider }) => provider === ref.provider)
  );
};

/**
 * The models the organization's calls may use, in order: its default,
 * then its fallbacks, each of a provider it still has connected. None
 * until it chose.
 */
export const chosenModels = (
  routes: AiProviderRoutes,
  choice: AiModelChoice | null
): string[] =>
  choice === null
    ? []
    : [
        ...new Set(
          [choice.defaultModel, ...choice.fallbacks].filter((model) =>
            isConnectedModel(routes, model)
          )
        ),
      ];
