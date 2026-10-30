import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { identifierSchema } from "./ids.ts";
import type { ModelBindingBudget } from "./resource-bindings.ts";

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
  "model.eu_only":
    "This call must stay in the EU, and that model isn't hosted in the EU. Choose one that is.",
  "model.sensitive_data":
    "This call carries sensitive data, and that model may not take it. Choose one this deployment allows for sensitive data.",
  "model.over_budget":
    "A model budget this call counts against is used up, so this model call can't be made. Ask your admin to have Grasp raise the budget.",
  "model.run_limit":
    "This workflow run, with the runs it started, has reached the most model calls or model spend one run may have: spent, or held for calls whose cost isn't settled yet. No more model calls can be made in it.",
  "model.budget_busy":
    "Model calls still under way hold what's left of a model budget this call counts against. Try again once they finish.",
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
 * Whose spend a budget counts: all calls, each workflow's, each person's,
 * each run lineage's (a run and the runs it starts).
 */
export type ModelBudgetScope = "deployment" | "workflow" | "user" | "run";

/**
 * What can refuse a call as over its budget (`model.over_budget`'s
 * `because`): one of the deployment's budgets ({@link ModelBudgetScope}),
 * the monthly limit the company's admins set for the person
 * ({@link PersonLimits}), or one of a model binding's caps, for its
 * month, its UTC day or one request.
 */
export type ModelBudgetCap =
  | ModelBudgetScope
  | "person"
  | "binding"
  | "binding_day"
  | "binding_request";

/**
 * What a `model.over_budget` refusal says, by the cap that refused it:
 * what is used up, and when it resets, or that no wait helps.
 */
const overBudgetMessages: Readonly<Record<ModelBudgetCap, string>> = {
  deployment:
    "This deployment's model budget for the month is used up, so no more model calls can be made until it resets at the start of next month (UTC). Ask your admin to have Grasp raise the budget.",
  workflow:
    "This workflow's model budget for the month is used up, so it can make no more model calls until the budget resets at the start of next month (UTC). Ask your admin to have Grasp raise the budget.",
  user: "The model budget for the month of the person this call is made for is used up, so no more model calls can be made for them until it resets at the start of next month (UTC). Ask your admin to have Grasp raise the budget.",
  run: "This workflow run, with the runs it started, has used up the model budget one run may spend, so no more model calls can be made in it.",
  person:
    "The monthly model limit your company's admins set for the person this call is made for is used up, so no more model calls can be made for them until it resets at the start of next month (UTC). Ask one of your company's admins to raise it in Settings.",
  binding:
    "This model binding's budget for the month is used up, so the App can make no more calls through it until the budget resets at the start of next month (UTC). Ask your admin to raise the binding's monthly budget.",
  binding_day:
    "This model binding's budget for the day is used up, so the App can make no more calls through it until the budget resets at midnight (UTC). Ask your admin to raise the binding's daily budget.",
  binding_request:
    "This model call could cost more than this model binding's cap per request has room for, so it was stopped before it went out. Send less, or ask your admin to raise the binding's budget per request.",
};

/** Whether `value` names a {@link ModelBudgetCap}. */
const isModelBudgetCap = (value: unknown): value is ModelBudgetCap =>
  typeof value === "string" && Object.hasOwn(overBudgetMessages, value);

/**
 * What a `model.over_budget` refusal says when the cap that refused it,
 * `because`, may be told: that cap's own message, or the family's, which
 * names none.
 */
export const overBudgetMessage = (because: unknown): string =>
  isModelBudgetCap(because)
    ? overBudgetMessages[because]
    : modelErrors.create("model.over_budget").message;

/**
 * What a `model.budget_busy` refusal says, by the cap held: which budget
 * calls under way hold, never whose calls, how many or how long.
 */
const busyBudgetMessages: Readonly<
  Record<Exclude<ModelBudgetCap, "binding_request">, string>
> = {
  deployment:
    "Model calls still under way hold what's left of this deployment's model budget for the month. Try again once they finish.",
  workflow:
    "Model calls still under way hold what's left of this workflow's model budget for the month. Try again once they finish.",
  user: "Model calls still under way hold what's left of the model budget for the month of the person this call is made for. Try again once they finish.",
  run: "Model calls still under way hold what's left of the model budget this workflow run, with the runs it started, may spend. Try again once they finish.",
  person:
    "Model calls still under way hold what's left of the monthly model limit your company's admins set for the person this call is made for. Try again once they finish.",
  binding:
    "Model calls still under way hold what's left of this model binding's budget for the month. Try again once they finish.",
  binding_day:
    "Model calls still under way hold what's left of this model binding's budget for the day. Try again once they finish.",
};

/** Whether `value` names a cap a `model.budget_busy` refusal can hold. */
const isBusyCap = (value: unknown): value is keyof typeof busyBudgetMessages =>
  typeof value === "string" && Object.hasOwn(busyBudgetMessages, value);

/**
 * What a `model.budget_busy` refusal says when the cap held, `because`,
 * may be told: that cap's own message, or the family's, which names none.
 */
export const busyBudgetMessage = (because: unknown): string =>
  isBusyCap(because)
    ? busyBudgetMessages[because]
    : modelErrors.create("model.budget_busy").message;

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

/** What spent part of a budget this month, with its name where core has one. */
export type ModelSpender =
  | { type: "deployment" }
  | ({ type: "workflow" } & SpendingWorkflow)
  | {
      type: "user";
      userId: string;
      /** Null once the person is gone. */
      name: string | null;
    }
  | {
      /**
       * A run lineage, by its root run, or an account in one: the first
       * run of another App in it, or of the root's App under another
       * App's run, whose runs there count on their own (`rootRunId`).
       */
      type: "run";
      runId: string;
      /** The lineage's root run, for an account; null when `runId` is the root. */
      rootRunId: string | null;
      /** Its App; null for an independent workflow's run, or once the run's record is gone. */
      appId: string | null;
      /** Null for no App, or once the App, or the run's record, is gone. */
      appName: string | null;
      /** Null once the run's record is gone. */
      workflowId: string | null;
      /** Its workflow's name; null once the workflow, or the run's record, is gone. */
      workflowName: string | null;
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
export interface WorkflowMonthSpend extends SpendingWorkflow {
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

/**
 * Whom a limit the company's admins set applies to: everyone without an
 * exception (`default`), or an exception for one person or one team.
 */
export const personLimitSubjectSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("default") }),
  z.strictObject({ type: z.literal("person"), userId: identifierSchema }),
  z.strictObject({ type: z.literal("team"), teamId: identifierSchema }),
]);

/** One of {@link personLimitSubjectSchema}. */
export type PersonLimitSubject = z.infer<typeof personLimitSubjectSchema>;

/** The most chat messages an hour a limit may allow a person. */
export const maxMessagesAnHour = 3600;

/** The most US dollars a month a limit may allow a person. */
export const maxMonthlyLimit = 1_000_000;

/**
 * A limit the company's admins set for a person: the most their model
 * calls may cost in a UTC month, in US dollars, and the most chat
 * messages they may send an hour. Null for none: then only Grasp's
 * budgets, and the chat door's own rate, hold them.
 */
export const personLimitSchema = z.strictObject({
  monthly: z.number().min(0).max(maxMonthlyLimit).nullable(),
  messagesAnHour: z.int().min(1).max(maxMessagesAnHour).nullable(),
});

/** One of {@link personLimitSchema}. */
export type PersonLimit = z.infer<typeof personLimitSchema>;

/**
 * Where a person's limit comes from: their own exception, a team's, the
 * default, or none.
 */
export type PersonLimitFrom = "person" | "team" | "default" | "none";

/** A person's limit as it applies to them, and what they spent against it this month. */
export interface PersonLimitSpend {
  userId: string;
  name: string;
  from: PersonLimitFrom;
  limit: PersonLimit;
  /** US dollars charged against their monthly limit this month. */
  spent: number;
}

/** An exception an admin set for a person or a team, with its name where core has one. */
export interface PersonLimitException {
  subject: Exclude<PersonLimitSubject, { type: "default" }>;
  /** Null once the person or team is gone. */
  name: string | null;
  limit: PersonLimit;
}

/** Most people the limits list. */
export const personLimitsListed = 1000;

/**
 * The limits the company's admins set per person, within Grasp's budgets,
 * and each person's spend against theirs this month.
 */
export interface PersonLimits {
  /** The UTC month spend counts in, such as `2026-10`. */
  month: string;
  /** The limit for everyone without an exception. */
  default: PersonLimit;
  exceptions: PersonLimitException[];
  /**
   * The most a monthly limit may be, in US dollars: the lower of Grasp's
   * budgets for one person and for the whole deployment; null when
   * neither is set.
   */
  ceiling: number | null;
  /** The organization's people, by name: at most {@link personLimitsListed}. */
  people: PersonLimitSpend[];
  /** More people are in the organization than `people` lists. */
  more: boolean;
  /** The organization's teams, by name: what an exception for a team may name. */
  teams: { teamId: string; name: string }[];
}

/**
 * What setting a limit came to. `set`: done. `above_budget`: refused, as
 * its monthly limit is above Grasp's budget (`ceiling`, US dollars).
 * `rules_invalid`: refused, as Grasp's budgets can't be read to check it.
 * `not_found`: the person or team isn't in the organization.
 */
export type PersonLimitSet =
  | { state: "set" }
  | { state: "above_budget"; ceiling: number }
  | { state: "rules_invalid" }
  | { state: "not_found" };

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
  /** The limits per person, and what each person spent against theirs. */
  limits: () => Promise<PersonLimits>;
  /** Sets the limit for `subject`, never above Grasp's budgets. Audited. */
  setLimit: (
    subject: PersonLimitSubject,
    limit: PersonLimit
  ) => Promise<PersonLimitSet>;
  /**
   * Removes `subject`'s exception, or the default, leaving no default
   * limit. Audited when there was one.
   */
  removeLimit: (subject: PersonLimitSubject) => Promise<void>;
}
