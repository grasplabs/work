import { defineErrorFamily } from "./errors.ts";
import type { ModelBindingBudget } from "./resource-bindings.ts";

/** Why the model gateway refused or failed a model call. */
export const modelErrors = defineErrorFamily({
  "model.invalid_call": "That isn't a valid model call.",
  "model.unconfigured": "Models aren't set up for this deployment yet.",
  "model.not_allowed": "This deployment doesn't allow that model.",
  "model.eu_only":
    "This call must stay in the EU, and that model isn't hosted in the EU. Choose one that is.",
  "model.sensitive_data":
    "This call carries sensitive data, and that model may not take it. Choose one this deployment allows for sensitive data.",
  "model.over_budget":
    "This month's model budget is used up, so no more model calls can be made for this. Ask your admin to have Grasp raise the budget.",
  "model.run_limit":
    "This workflow run, with the runs it started, has reached the most model calls or model spend one run may have: spent, or held for calls whose cost isn't settled yet. No more model calls can be made in it.",
  "model.budget_busy":
    "Model calls still under way hold what's left of this month's model budget. Try again once they finish.",
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
 * Whose spend a budget counts: all calls, each workflow's, each person's,
 * each run lineage's (a run and the runs it starts).
 */
export type ModelBudgetScope = "deployment" | "workflow" | "user" | "run";

/** What spent part of a budget this month, with its name where core has one. */
export type ModelSpender =
  | { type: "deployment" }
  | {
      type: "workflow";
      appId: string;
      /** Null once the App is gone. */
      appName: string | null;
      workflowId: string;
    }
  | {
      type: "user";
      userId: string;
      /** Null once the person is gone. */
      name: string | null;
    }
  | {
      /** A run lineage, by its root run. */
      type: "run";
      runId: string;
      /** Null once the run's record is gone. */
      appId: string | null;
      /** Null once the App, or the run's record, is gone. */
      appName: string | null;
      workflowId: string | null;
      /** When the root run started, ISO 8601; null once its record is gone. */
      startedAt: string | null;
    };

/** Most workflows or people one budget lists the spend of. */
export const modelSpendListed = 50;

/** One budget the deployment sets, and what it counted this month. */
export interface ModelBudget {
  scope: ModelBudgetScope;
  /**
   * US dollars a month: for the deployment, all its calls together; for a
   * workflow or a person, each one on its own. For a run lineage, each
   * one on its own, for its whole life.
   */
  limit: number;
  /** The percent of the limit at which admins are alerted. */
  alertAt: number;
  /**
   * This month's spend in US dollars, most first: the deployment's, or
   * that of each workflow or person that spent, at most
   * {@link modelSpendListed} of them; for run lineages, what each spent
   * in its whole life. Empty while nothing was spent.
   */
  spent: { of: ModelSpender; amount: number }[];
  /** More workflows, people or run lineages spent than `spent` lists. */
  more: boolean;
}

/** The client's rules beyond the allowlist, while they apply. */
export interface ModelRulesSettings {
  /** Which calls must stay with a model hosted in the EU; null for none. */
  eu: {
    /** The allowed models hosted in the EU. */
    models: string[];
    /** Every call of the deployment. */
    deployment: boolean;
    /** Workflows whose AI steps must stay in the EU. */
    workflows: { app: string; workflow: string }[];
    /** Connections whose data must stay in the EU. */
    connections: string[];
  } | null;
  /**
   * Which models may take sensitive data: from a sensitive collection
   * (marked in Knowledge), from a connection listed here, or in a chat, App
   * or run that read either. Null for no data rule.
   */
  sensitive: { models: string[]; connections: string[] } | null;
  budgets: ModelBudget[];
}

/**
 * The model gateway's settings, as admins read them. They are deployment
 * config that Grasp sets for the client, so nobody changes them in the
 * product.
 */
export interface ModelSettings {
  /**
   * The models the deployment allows, as `<provider>/<model>`. Empty while
   * models aren't set up: every call is refused then.
   */
  models: string[];
  /**
   * The client's other rules: `invalid` when they don't parse, and every
   * call is refused.
   */
  rules: { state: "invalid" } | ({ state: "on" } & ModelRulesSettings);
  /** The UTC month budgets count in now, such as `2026-09`. */
  month: string;
  /** The UTC day a model binding's daily cap counts in now, such as `2026-09-30`. */
  day: string;
  /** Reservations held for review (`HeldRequest`), oldest first. */
  held: HeldRequest[];
  /**
   * The Apps' active model bindings, by App name and alias, with their
   * caps and what each spent: at most {@link bindingSpendListed}, and
   * whether more are bound.
   */
  bindings: { listed: ModelBindingSpend[]; more: boolean };
}

/** Most model bindings the settings list the spend of. */
export const bindingSpendListed = 100;

/**
 * How far a model binding's spend is into its caps: under its alert
 * threshold (or capless), at it, or at a cap. The most of its day's and
 * month's.
 */
export type ModelBindingAlert = "none" | "alerted" | "reached";

/**
 * An App's model binding (resource-bindings.ts), its own caps, and what
 * its requests spent: the calls the App's actions make through it, never
 * a workflow's own model steps.
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
  /** Its own caps; null for none, and while `budgetDamaged`. */
  budget: ModelBindingBudget | null;
  /** Its caps can't be read, so it serves nothing. */
  budgetDamaged: boolean;
  /** US dollars spent today (UTC, `day`) and this month (`month`). */
  today: number;
  thisMonth: number;
  alert: ModelBindingAlert;
}

/**
 * A model request's reservation the model ledger couldn't read to settle:
 * it stays held against its budgets until an admin releases it or charges
 * it in full.
 */
export interface HeldRequest {
  id: string;
  /** `<provider>/<model>`. */
  model: string;
  /** The UTC month it counts in. */
  period: string;
  /** What it holds, in US dollars: the most it could have cost. */
  amount: number;
  /** When it was sent, as an ISO timestamp. */
  sentAt: string;
  /**
   * A budget record it counts against is damaged, so it can only be
   * released: a charge would count against a wrong total.
   */
  releaseOnly: boolean;
}

/** What an admin decides about a held reservation. */
export type HeldHow = "release" | "charge";

/**
 * What an admin's decision on a held reservation came to. `decided`: done
 * now, `amount` charged in US dollars. `already_decided`: an earlier
 * decision, someone else's maybe, stands, and this one changed nothing.
 * `release_only`: a charge refused, as the budget records it counts
 * against are damaged; it is still held, and can be released. `not_held`:
 * there is no such held reservation.
 */
export type HeldDecision =
  | { state: "decided"; how: HeldHow; amount: number }
  | {
      state: "already_decided";
      how: HeldHow;
      amount: number;
      /** When it was decided, as an ISO timestamp. */
      decidedAt: string;
    }
  | { state: "release_only" }
  | { state: "not_held" };

/** Most held requests listed at once. */
export const heldListed = 100;

/** A workflow's model spend this month, and its runs. */
export interface WorkflowMonthSpend {
  appId: string;
  /** Null once the App is gone. */
  appName: string | null;
  workflowId: string;
  /** US dollars charged this month. */
  amount: number;
  /** Its runs started this month, of any version. */
  runs: number;
}

/**
 * What the models cost this month, budget or not: every call of the
 * deployment, and the workflows that spent most.
 */
export interface ModelMonthSpend {
  /** The UTC month it counts, such as `2026-10`. */
  month: string;
  /** US dollars charged this month for every call; held reservations aren't spend yet. */
  total: number;
  /** The workflows that spent most, most first: at most {@link modelSpendListed}. */
  workflows: WorkflowMonthSpend[];
  /** More workflows spent than `workflows` lists. */
  more: boolean;
}

/** The model gateway's settings, over `/rpc`, for admins only. */
export interface ModelsApi {
  /** The settings, and this month's spend against each budget. */
  settings: () => Promise<ModelSettings>;
  /**
   * What the models cost this month, whether or not a budget is set: all
   * calls, and the workflows that spent most with their runs.
   */
  spend: () => Promise<ModelMonthSpend>;
  /** The reservations held for review, oldest first. */
  held: () => Promise<HeldRequest[]>;
  /**
   * Settles a held reservation: `release` charges nothing, `charge` all it
   * holds. Audited. One already decided is left as it is, and answered
   * with that decision.
   */
  resolveHeld: (id: string, how: HeldHow) => Promise<HeldDecision>;
}
