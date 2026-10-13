import type { AuditActor } from "@grasp-os/shared/audit";
import type { budgetsSchema } from "@grasp-os/shared/deployment-config";
import { modelSpendListed } from "@grasp-os/shared/models";
import type {
  ModelBudget,
  ModelBudgetScope,
  ModelSpender,
} from "@grasp-os/shared/models";
import type { Authority } from "@grasp-os/shared/permissions";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import type { ModelBindingBudget } from "@grasp-os/shared/resource-bindings";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { apps, users, workflowRuns } from "./db/core/schema.ts";
import { modelLedger } from "./model-ledger.ts";
import type { LedgerScope, LedgerScopeName } from "./model-ledger.ts";
import { microsPerDollar } from "./model-prices.ts";

// Model budgets, one of the client's rules for model calls (model-rules.ts):
// what the deployment's calls may cost in a UTC month, all together, per
// workflow and per person, and per run lineage for its whole life, in US
// dollars at the providers' list prices.
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
// A request's run lineage is a scope too: the run, and every run started
// under it, keyed by the lineage's root run (`rootRunId` on the run's
// audit actor, which the engine's record of the run gives it, never its
// input). It is counted across all their steps, retries, restarts and
// children, for the lineage's whole life (the ledger never resets it by
// month), so none of them starts afresh. It has a budget only where the
// deployment sets `run`; whatever it sets, a lineage makes at most the
// provider requests the deployment's quota policy allows
// (`lineageModelRequests`, @grasp-os/shared/quota-policy): the platform's
// 100, or fewer where its operator lowered it. From the threat model:
//
// - Raising it: the operator can only lower it (the policy's schema caps
//   it at the platform's, and `scopesFor` again); nothing a call, an App
//   or a run passes reaches it. Only a release that changes the
//   platform's limit raises it.
// - A lowered limit missed by runs already under way: the gateway reads
//   the policy for every provider request (models.ts, `scopesNow`), and
//   the ledger checks the lineage's count as it stands against the limit
//   that admission carries. A lineage already at or past a lowered limit
//   sends nothing more. No limit is kept on the lineage's row, so none
//   goes stale; each request's receipt keeps the limit and generation it
//   was admitted under, as the record of it.
// - Requests under an older policy after one under a newer: the ledger
//   keeps the highest generation an admission carried, and refuses one
//   under a lower (`policyBehind`); the gateway reads the policy again and
//   tries once more. One that read the policy just before a newer
//   generation was recorded, and reaches the ledger before anything under
//   it, is admitted as if it came first: at most the requests already on
//   their way when the policy changed.
// - A rebuilt lineage starting afresh: a lineage whose spend row was lost
//   comes back used up under any policy (model-ledger.ts, `#rebuildScope`).
// - A policy that can't be read: a workflow's request is held back, never
//   admitted without its limit.
//
// A model binding of an App (resource-bindings.ts) may have caps of its
// own, set by the admin who approved it, on top of all these: per UTC
// month and day, scopes of the ledger like the others (`bindingScopes`),
// and per request of the App as a whole, which the gateway holds every
// provider request of that request to (`bindingRequestMicros`, models.ts).
// How each way a binding could spend past its caps is closed:
//
// - Requests racing a day's or month's cap: the ledger admits each
//   provider request against the binding's scopes in the same transaction
//   as every other scope, so concurrent requests never oversubscribe it.
// - A retry or a second attempt escaping the cap per request: each
//   provider request reserves its own bound, and is admitted only if it
//   fits beside what the request's earlier ones still hold; one whose
//   outcome is unknown holds all of its reservation, so a retry after a
//   server error never gets its room back. A request's provider requests
//   go one at a time, so its own count needs no lock.
// - An answer streaming past the cap: a request reserves the most its
//   answer can cost (the declaration's token bound) before it is sent, so
//   no answer outgrows what was admitted.
// - A cap changed or revoked between requests: the binding's row is read
//   for every request (resource-bindings.ts), each admission takes the
//   caps as they are then, and a revoked binding sends nothing. Spend is
//   keyed by the App and alias, so approving the alias again changes the
//   cap and keeps what was spent.
// - Caps stored damaged: the binding serves nothing, never uncapped.
// - A model with no safe price: no cap can bound it, so it is refused, as
//   under any other budget.

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

/**
 * The most provider requests one run lineage may make under any quota
 * policy, retries included (platform default: 100 model requests per run
 * lineage); a deployment's policy may lower it.
 */
export const { lineageModelRequests } = platformLimits;

/** A scope a call counts against, and the budget the deployment sets for it. */
interface Scoped {
  scope: LedgerScopeName;
  key: string;
  budget: Budget | undefined;
  names: Record<string, string>;
  /** The most requests it may make; none for no limit. */
  requests?: number;
}

/** The workflow and run lineage scopes of a workflow's call. */
const workflowScopes = (
  budgets: Budgets,
  trigger: AuditActor,
  requests: number
): Scoped[] => {
  if (trigger.type !== "workflow") {
    return [];
  }
  const lineage = trigger.rootRunId ?? trigger.runId;
  return [
    {
      scope: "workflow",
      key: JSON.stringify([trigger.appId, trigger.workflowId]),
      budget: budgets?.workflow,
      names: { app: trigger.appId, workflow: trigger.workflowId },
    },
    {
      scope: "run",
      key: lineage,
      budget: budgets?.run,
      names: { run: lineage },
      requests,
    },
  ];
};

/**
 * The scopes a call's requests count against, each with its budget where
 * the deployment sets one: the deployment, always; the workflow and the
 * run lineage, for a workflow's call; and the person it is made by or
 * for. A scope without a budget is counted, and limits no spend; the run
 * lineage's requests are limited whatever the budgets, to
 * `lineageRequests` (the quota policy's), never above the platform's.
 */
export const scopesFor = (
  budgets: Budgets,
  input: BudgetInput,
  lineageRequests: number
): LedgerScope[] => {
  const person = personOf(input);
  const scopes: Scoped[] = [
    {
      scope: "deployment",
      key: "deployment",
      budget: budgets?.deployment,
      names: {},
    },
    ...workflowScopes(
      budgets,
      input.trigger,
      Math.min(lineageRequests, lineageModelRequests)
    ),
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
  return scopes.map(({ scope, key, budget, names, requests }) => {
    const limitRequests = requests ?? null;
    if (budget === undefined) {
      return {
        scope,
        key,
        limitMicros: null,
        alertMicros: null,
        limitRequests,
        names,
      };
    }
    const limitMicros = Math.round(budget.limit * microsPerDollar);
    return {
      scope,
      key,
      limitMicros,
      alertMicros: Math.ceil((limitMicros * budget.alertAt) / 100),
      limitRequests,
      names,
    };
  });
};

const dayPattern = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;

/**
 * The UTC day a binding's daily cap counts in now, such as `2026-10-12`;
 * tests set it with `MODEL_BUDGET_DAY`.
 */
export const budgetDay = (
  env: Pick<Env, "MODEL_BUDGET_DAY">,
  now = new Date()
): string =>
  env.MODEL_BUDGET_DAY !== undefined && dayPattern.test(env.MODEL_BUDGET_DAY)
    ? env.MODEL_BUDGET_DAY
    : now.toISOString().slice(0, "yyyy-mm-dd".length);

/**
 * The UTC month and day a request counts in, read off one clock: at a
 * month's last instant both are that month's.
 */
export const budgetPeriods = (
  env: Pick<Env, "MODEL_BUDGET_MONTH" | "MODEL_BUDGET_DAY">,
  now = new Date()
): { month: string; day: string } => ({
  month: budgetMonth(env, now),
  day: budgetDay(env, now),
});

/** A model binding a call is made through, with its own caps (resource-model.ts). */
export interface BindingBudgetInput {
  app: string;
  alias: string;
  budget: ModelBindingBudget | null;
}

/** A binding's `cap` as a limit in micros, alerting where its budget says. */
const limitOf = (
  budget: ModelBindingBudget | null,
  cap: "perDay" | "perMonth"
): Pick<LedgerScope, "limitMicros" | "alertMicros"> => {
  const dollars = budget?.[cap];
  if (budget === null || dollars === undefined) {
    return { limitMicros: null, alertMicros: null };
  }
  const limitMicros = Math.round(dollars * microsPerDollar);
  return {
    limitMicros,
    alertMicros: Math.ceil((limitMicros * budget.alertAt) / 100),
  };
};

/**
 * The scopes a call through a model binding counts against besides
 * `scopesFor`'s: the binding's month and its UTC `day`, each with its cap
 * where the binding sets one, and counted where it doesn't, so a cap set
 * later counts what was already spent.
 *
 * Both are keyed by the App and alias, never the binding's row: approving
 * the alias again (another budget, a later version's declaration) changes
 * the cap, never what was spent against it. The day's key carries the
 * day, so each day is counted on its own within the month the ledger
 * keeps it under, and alerted once.
 */
export const bindingScopes = (
  binding: BindingBudgetInput,
  day: string
): LedgerScope[] => {
  const names = { app: binding.app, binding: binding.alias };
  return [
    {
      scope: "binding",
      key: JSON.stringify([binding.app, binding.alias]),
      ...limitOf(binding.budget, "perMonth"),
      limitRequests: null,
      names,
    },
    {
      scope: "binding_day",
      key: JSON.stringify([binding.app, binding.alias, day]),
      ...limitOf(binding.budget, "perDay"),
      limitRequests: null,
      names: { ...names, day },
    },
  ];
};

/**
 * The most one request of the App through `binding` may reserve, every
 * provider request it sends together, in micros; none without a cap.
 */
export const bindingRequestMicros = (
  binding: BindingBudgetInput | undefined
): number | undefined => {
  const dollars = binding?.budget?.perRequest;
  return dollars === undefined
    ? undefined
    : Math.round(dollars * microsPerDollar);
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

/** Names of Apps and people, and root runs' App and workflow, by ID, as core still has them. */
interface Names {
  apps: ReadonlyMap<string, string>;
  people: ReadonlyMap<string, string>;
  runs: ReadonlyMap<
    string,
    { appId: string; workflowId: string; startedAt: Date }
  >;
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
  if (scope === "run") {
    const run = names.runs.get(key);
    return {
      type: "run",
      runId: key,
      appId: run?.appId ?? null,
      appName: run === undefined ? null : (names.apps.get(run.appId) ?? null),
      workflowId: run?.workflowId ?? null,
      startedAt: run?.startedAt.toISOString() ?? null,
    };
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

/** The names of the Apps, people and root runs `rows` count spend for. */
const namesOf = async (
  db: DrizzleD1Database,
  rows: readonly { scope: ModelBudgetScope; key: string }[]
): Promise<Names> => {
  const runIds = rows
    .filter(({ scope }) => scope === "run")
    .map(({ key }) => key);
  const runRows =
    runIds.length === 0
      ? []
      : await db
          .select({
            id: workflowRuns.id,
            appId: workflowRuns.appId,
            workflowId: workflowRuns.workflowId,
            startedAt: workflowRuns.createdAt,
          })
          .from(workflowRuns)
          .where(inArray(workflowRuns.id, runIds));
  const appIds = [
    ...new Set([
      ...rows.flatMap(({ scope, key }) => {
        const workflow = scope === "workflow" ? workflowOf(key) : undefined;
        return workflow === undefined ? [] : [workflow[0]];
      }),
      ...runRows.map(({ appId }) => appId),
    ]),
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
    runs: new Map(
      runRows.map(({ id, appId, workflowId, startedAt }) => [
        id,
        { appId, workflowId, startedAt },
      ])
    ),
  };
};

/**
 * Each budget `budgets` sets, with what was charged against it in
 * `period` (a run lineage's: in its whole life; reservations still held
 * are not spend yet), most first (at most `modelSpendListed`, and
 * whether more spent), and the names of the Apps and people it counts for
 * where core still has them: for admins to read (models-rpc.ts).
 */
export const budgetSpend = async (
  env: Pick<Env, "DB" | "MODEL_LEDGER" | "DURABLE_OBJECT_JURISDICTION">,
  budgets: Budgets,
  period: string
): Promise<ModelBudget[]> => {
  const set = (["deployment", "workflow", "user", "run"] as const).flatMap(
    (scope) => {
      const budget = budgets?.[scope];
      return budget === undefined ? [] : [{ scope, budget }];
    }
  );
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
