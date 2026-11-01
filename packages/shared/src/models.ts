import { defineErrorFamily } from "./errors.ts";

/** Why the model gateway refused or failed a model call. */
export const modelErrors = defineErrorFamily({
  "model.invalid_call": "That isn't a valid model call.",
  "model.unconfigured": "Models aren't set up for this deployment yet.",
  "model.no_provider":
    "No AI provider is connected yet. Connect an AI provider to use models.",
  "model.provider_key_failed":
    "Your AI provider is refusing your key. An admin can check or replace it in Settings › AI providers.",
  "model.provider_unavailable":
    "The AI provider isn't answering, so this call wasn't answered. This is usually an outage on their side; try again in a while.",
  "model.not_allowed": "This deployment doesn't allow that model.",
  "model.run_limit":
    "This workflow run, with the runs it started, has made the most model calls one run may make. No more model calls can be made in it.",
  "model.queued":
    "Other model calls running now fill this share of the model requests that may run at once, so this one waits its turn. Try again after the wait it names: it isn't a fault, and it goes on once a share comes free.",
  "model.rate_limited":
    "Your AI provider is limiting requests (a rate or spending limit at the provider), so this call wasn't answered. Try again after a while.",
  "model.unpriced":
    "What this model call would cost can't be bounded at known prices, so it wasn't sent. Choose another model, or send less.",
  "model.answer_too_long":
    "That model can't give an answer as long as this call asks for, so it wasn't sent. Choose a model with a larger window, or ask for a shorter answer.",
  "model.ledger_unavailable":
    "Model spend can't be accounted for right now, so no model call was made. Try again later.",
  "model.quota_policy_unavailable":
    "This deployment's quota policy can't be read right now, so no model call was made. Try again later.",
  "model.quota_policy_behind":
    "This deployment's quota policy is behind the one its model spend was last accounted under, so no model call was made. Ask your admin to have Grasp check the deployment's quota policy.",
  "model.failed": "The model call failed. Try again later.",
  "model.invalid_output":
    "The model's answer didn't match the expected shape, also when asked again.",
});

/** One of {@link modelErrors}' codes: why the model gateway refused or failed a call. */
export type ModelErrorCode = Parameters<typeof modelErrors.create>[0];

/**
 * How hard a model thinks before it answers, least first: the levels
 * Claude and OpenAI both take. A model takes some, all or none of them
 * (`ChatsApi.efforts`).
 */
export const modelEfforts = ["low", "medium", "high", "xhigh", "max"] as const;

/** One of {@link modelEfforts}. */
export type ModelEffort = (typeof modelEfforts)[number];

/** The effort of a call that names none. */
export const defaultModelEffort: ModelEffort = "medium";

/** The efforts a model takes, and the one a call that names none gets. */
export interface ModelEfforts {
  /** Least first; empty for a model that doesn't think. */
  levels: ModelEffort[];
  /**
   * {@link defaultModelEffort} as the model takes it: on a model without
   * medium, the level it gets instead. Null for one that doesn't think.
   */
  default: ModelEffort | null;
}

/**
 * A workflow that spent: an App's own, by its ID in its App, or an
 * independent workflow (`appId` null), by its ID.
 */
export interface SpendingWorkflow {
  /** Null for an independent workflow. */
  appId: string | null;
  /** Null for an independent workflow, or once the App is gone. */
  appName: string | null;
  workflowId: string;
  /** An App's workflow's is its ID; an independent one's, null once it is gone. */
  name: string | null;
}

/** Most workflows one spend overview lists. */
export const modelSpendListed = 50;

/**
 * The model gateway's settings, as admins read them: the models the
 * organization's calls may use, and what the Apps' model bindings spent.
 */
export interface ModelSettings {
  /**
   * The models the deployment allows, as `<provider>/<model>`. Empty while
   * models aren't set up: every call is refused then.
   */
  models: string[];
  /** The UTC month spend counts in now, such as `2026-09`. */
  month: string;
  /**
   * The Apps' active model bindings, by App name and alias, with what each
   * spent this month: at most {@link bindingSpendListed}, and whether more
   * are bound.
   */
  bindings: { listed: ModelBindingSpend[]; more: boolean };
}

/** Most model bindings the settings list the spend of. */
export const bindingSpendListed = 100;

/**
 * An App's model binding (resource-bindings.ts), and what its requests
 * spent: the calls the App's actions make through it, never a workflow's
 * own model steps.
 */
export interface ModelBindingSpend {
  appId: string;
  appName: string;
  alias: string;
  /**
   * `<provider>/<model>`; null when its stored target can't be read, so
   * it serves nothing.
   */
  model: string | null;
  /** US dollars spent this month (UTC, `month`). */
  thisMonth: number;
}

/** A workflow's model spend this month, and its runs. */
export interface WorkflowMonthSpend extends SpendingWorkflow {
  /** US dollars charged this month. */
  amount: number;
  /** Its runs started this month, of any version. */
  runs: number;
}

/** What the models cost this month: every call of the deployment, and the workflows that spent most. */
export interface ModelMonthSpend {
  /** The UTC month it counts, such as `2026-10`. */
  month: string;
  /** US dollars charged this month for every call. */
  total: number;
  /** The workflows that spent most, most first: at most {@link modelSpendListed}. */
  workflows: WorkflowMonthSpend[];
  /** More workflows spent than `workflows` lists. */
  more: boolean;
}

/** The model gateway's settings, over `/rpc`, for admins only. */
export interface ModelsApi {
  /** The settings, and what the model bindings spent this month. */
  settings: () => Promise<ModelSettings>;
  /** What the models cost this month: all calls, and the workflows that spent most with their runs. */
  spend: () => Promise<ModelMonthSpend>;
}
