import type { AuditActor } from "@grasp-os/shared/audit";
import type { budgetsSchema } from "@grasp-os/shared/deployment-config";
import { modelSpendListed } from "@grasp-os/shared/models";
import type {
  ModelBudget,
  ModelBudgetScope,
  ModelSpender,
} from "@grasp-os/shared/models";
import type { Authority } from "@grasp-os/shared/permissions";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { apps, users } from "./db/core/schema.ts";
import { modelLedger } from "./model-ledger.ts";
import type { LedgerScope, LedgerScopeName } from "./model-ledger.ts";
import { microsPerDollar } from "./model-prices.ts";

// Model budgets, one of the client's rules for model calls (model-rules.ts):
// what the deployment's calls may cost in a UTC month, all together, per
// workflow and per person, in US dollars at the providers' list prices.
//
// The model ledger (model-ledger.ts) enforces them: before each provider
// request is sent, a retry too, it reserves the most the request can cost
// against each of its scopes at once, and refuses it, sending nothing,
// when any scope's spend and reservations leave no room for it. Once the
// request ends, its reservation turns into what its usage cost; a request
// whose usage can't be known is charged its whole reservation. Admins are
// alerted once per month and threshold value when a budget's spend reaches
// its alert threshold or its limit, with an audit event (`model.budget.alert`
// and `model.budget.exhausted`) and a log line.
//
// A request's run is a scope too, counted with no budget yet, so a run's
// spend is known across its retries and steps.

type Budgets = z.output<typeof budgetsSchema>;
type Budget = NonNullable<NonNullable<Budgets>["deployment"]>;

/** What budgets count a call by. */
export interface BudgetInput {
  trigger: AuditActor;
  work?: { authority: Authority } | { onboarding: true };
}

/** The person a call is made by or for, if any. */
const personOf = ({ trigger, work }: BudgetInput): string | undefined => {
  if (trigger.type === "person" || trigger.type === "staff") {
    return trigger.userId;
  }
  if (trigger.type === "agent") {
    return trigger.onBehalfOf;
  }
  // A guest's chat spends the budget of the member it was made for.
  if (trigger.type === "guest") {
    return trigger.invitedBy;
  }
  return work !== undefined && "authority" in work
    ? work.authority.onBehalfOf
    : undefined;
};

const monthPattern = /^\d{4}-(?:0[1-9]|1[0-2])$/u;

/**
 * The UTC month budgets count in now, such as `2026-09`; tests set it
 * with `MODEL_BUDGET_MONTH`.
 */
export const budgetMonth = (
  env: Pick<Env, "MODEL_BUDGET_MONTH">,
  now = new Date()
): string =>
  env.MODEL_BUDGET_MONTH !== undefined &&
  monthPattern.test(env.MODEL_BUDGET_MONTH)
    ? env.MODEL_BUDGET_MONTH
    : now.toISOString().slice(0, "yyyy-mm".length);

/** A scope a call counts against, and the budget the deployment sets for it. */
interface Scoped {
  scope: LedgerScopeName;
  key: string;
  budget: Budget | undefined;
  names: Record<string, string>;
}

/** The workflow and run scopes of a workflow's call. */
const workflowScopes = (budgets: Budgets, trigger: AuditActor): Scoped[] =>
  trigger.type === "workflow"
    ? [
        {
          scope: "workflow",
          key: JSON.stringify([trigger.appId, trigger.workflowId]),
          budget: budgets?.workflow,
          names: { app: trigger.appId, workflow: trigger.workflowId },
        },
        {
          scope: "run",
          key: trigger.runId,
          budget: undefined,
          names: { run: trigger.runId },
        },
      ]
    : [];

/**
 * The scopes a call's requests count against, each with its budget where
 * the deployment sets one: the deployment, always; the workflow and the
 * run, for a workflow's call; and the person it is made by or for. A
 * scope without a budget is counted, and limits nothing.
 */
export const scopesFor = (
  budgets: Budgets,
  input: BudgetInput
): LedgerScope[] => {
  const person = personOf(input);
  const scopes: Scoped[] = [
    {
      scope: "deployment",
      key: "deployment",
      budget: budgets?.deployment,
      names: {},
    },
    ...workflowScopes(budgets, input.trigger),
    ...(person === undefined
      ? []
      : [
          {
            scope: "user" as const,
            key: person,
            budget: budgets?.user,
            names: { user: person },
          },
        ]),
  ];
  return scopes.map(({ scope, key, budget, names }) => {
    if (budget === undefined) {
      return { scope, key, limitMicros: null, alertMicros: null, names };
    }
    const limitMicros = Math.round(budget.limit * microsPerDollar);
    return {
      scope,
      key,
      limitMicros,
      alertMicros: Math.ceil((limitMicros * budget.alertAt) / 100),
      names,
    };
  });
};

/** Whether any of `scopes` has a budget, which a request must fit. */
export const hasBudget = (scopes: readonly LedgerScope[]): boolean =>
  scopes.some(({ limitMicros }) => limitMicros !== null);

/** A workflow budget's key, as `scopesFor` writes it: its App and workflow. */
const workflowKeySchema = z.tuple([z.string(), z.string()]);

/** The App and workflow a workflow budget's `key` counts; none for a bad key. */
const workflowOf = (key: string): [string, string] | undefined => {
  try {
    return workflowKeySchema.safeParse(JSON.parse(key)).data;
  } catch {
    return undefined;
  }
};

/** Names of Apps and people, by ID, as core still has them. */
interface Names {
  apps: ReadonlyMap<string, string>;
  people: ReadonlyMap<string, string>;
}

/** What a spend row counted, by its scope and key; none for a bad key. */
const spenderOf = (
  scope: ModelBudgetScope,
  key: string,
  names: Names
): ModelSpender | undefined => {
  if (scope === "deployment") {
    return { type: "deployment" };
  }
  if (scope === "user") {
    return { type: "user", userId: key, name: names.people.get(key) ?? null };
  }
  const workflow = workflowOf(key);
  if (workflow === undefined) {
    return undefined;
  }
  const [appId, workflowId] = workflow;
  return {
    type: "workflow",
    appId,
    appName: names.apps.get(appId) ?? null,
    workflowId,
  };
};

/** The names of the Apps and people `rows` count spend for. */
const namesOf = async (
  db: DrizzleD1Database,
  rows: readonly { scope: ModelBudgetScope; key: string }[]
): Promise<Names> => {
  const appIds = [
    ...new Set(
      rows.flatMap(({ scope, key }) => {
        const workflow = scope === "workflow" ? workflowOf(key) : undefined;
        return workflow === undefined ? [] : [workflow[0]];
      })
    ),
  ];
  const userIds = rows
    .filter(({ scope }) => scope === "user")
    .map(({ key }) => key);
  const [appRows, userRows] = await Promise.all([
    appIds.length === 0
      ? []
      : db
          .select({ id: apps.id, name: apps.name })
          .from(apps)
          .where(inArray(apps.id, appIds)),
    userIds.length === 0
      ? []
      : db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, userIds)),
  ]);
  return {
    apps: new Map(appRows.map(({ id, name }) => [id, name])),
    people: new Map(userRows.map(({ id, name }) => [id, name])),
  };
};

/**
 * Each budget `budgets` sets, with what was charged against it in
 * `period` (reservations still held are not spend yet), most first (at most `modelSpendListed`, and
 * whether more spent), and the names of the Apps and people it counts for
 * where core still has them: for admins to read (models-rpc.ts).
 */
export const budgetSpend = async (
  env: Pick<Env, "DB" | "MODEL_LEDGER" | "DURABLE_OBJECT_JURISDICTION">,
  budgets: Budgets,
  period: string
): Promise<ModelBudget[]> => {
  const set = (["deployment", "workflow", "user"] as const).flatMap((scope) => {
    const budget = budgets?.[scope];
    return budget === undefined ? [] : [{ scope, budget }];
  });
  if (set.length === 0) {
    return [];
  }
  // One more than are listed, to tell whether any are left out.
  const spent = await modelLedger(env).spendOf(
    period,
    set.map(({ scope }) => scope),
    modelSpendListed + 1
  );
  const read = set.map(({ scope, budget }) => {
    const rows = spent[scope] ?? [];
    return {
      scope,
      budget,
      rows: rows.slice(0, modelSpendListed),
      more: rows.length > modelSpendListed,
    };
  });
  const names = await namesOf(
    drizzle(env.DB),
    read.flatMap(({ scope, rows }) => rows.map(({ key }) => ({ scope, key })))
  );
  return read.map(({ scope, budget, rows, more }) => ({
    scope,
    limit: budget.limit,
    alertAt: budget.alertAt,
    spent: rows.flatMap(({ key, spentMicros }) => {
      const of = spenderOf(scope, key, names);
      return of === undefined
        ? []
        : [{ of, amount: spentMicros / microsPerDollar }];
    }),
    more,
  }));
};
