import { modelEfforts } from "@grasp-os/shared/models";
import type { ModelEffort, ModelEfforts } from "@grasp-os/shared/models";

// The model a person asks with and how hard it thinks: one choice, kept in
// this browser for each person, so the next question, on any page and
// after a reload, asks as the last one did. Only what they chose is kept;
// what applies is worked out against what core offers now
// (`chats.models()`, `chats.efforts()`), so a model no longer allowed, or
// an effort the model doesn't take, falls back to the default.

/** What a person last chose, as far as they chose it. */
export interface ModelChoice {
  model?: string;
  effort?: ModelEffort;
}

/** The model and effort a question names: no effort for a model that doesn't think. */
export interface ResolvedChoice {
  model: string;
  effort: ModelEffort | undefined;
  /** The efforts the model takes, least first; none for one that doesn't think. */
  levels: readonly ModelEffort[];
}

const isEffort = (value: unknown): value is ModelEffort =>
  modelEfforts.some((effort) => effort === value);

/**
 * `choice` against what core offers: its model while it is allowed, else
 * the default (the first); its effort while that model takes it, else the
 * model's own default.
 */
export const resolveChoice = (
  models: readonly string[],
  efforts: Readonly<Record<string, ModelEfforts>>,
  choice: ModelChoice
): ResolvedChoice => {
  const model =
    choice.model !== undefined && models.includes(choice.model)
      ? choice.model
      : (models[0] ?? "");
  const offered = Object.hasOwn(efforts, model) ? efforts[model] : undefined;
  const levels = offered?.levels ?? [];
  const effort =
    choice.effort !== undefined && levels.includes(choice.effort)
      ? choice.effort
      : (offered?.default ?? undefined);
  return { model, effort, levels };
};

const keyOf = (userId: string): string => `grasp.chat.choice.${userId}`;

/** What `userId` last chose in this browser; nothing when it can't be read. */
export const readChoice = (userId: string): ModelChoice => {
  let stored: unknown;
  try {
    stored = JSON.parse(localStorage.getItem(keyOf(userId)) ?? "null");
  } catch {
    // Storage refused (a private window) or not JSON: nothing chosen.
    return {};
  }
  if (typeof stored !== "object" || stored === null) {
    return {};
  }
  const model: unknown = Reflect.get(stored, "model");
  const effort: unknown = Reflect.get(stored, "effort");
  return {
    ...(typeof model === "string" ? { model } : {}),
    ...(isEffort(effort) ? { effort } : {}),
  };
};

/** Keeps `choice` as `userId`'s in this browser, where storage allows. */
export const writeChoice = (userId: string, choice: ModelChoice): void => {
  try {
    localStorage.setItem(keyOf(userId), JSON.stringify(choice));
  } catch {
    // Storage refused: the choice lasts until the page reloads.
  }
};
