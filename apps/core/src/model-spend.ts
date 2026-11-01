import type { AuditActor } from "@grasp-os/shared/audit";
import type { ModelMonthSpend } from "@grasp-os/shared/models";
import { modelSpendListed } from "@grasp-os/shared/models";
import type { Authority } from "@grasp-os/shared/permissions";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { and, count, gte, inArray, isNull, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import {
  apps,
  workflowResourceRuns,
  workflowResources,
  workflowRuns,
} from "./db/core/schema.ts";
import { personOf } from "./model-admission.ts";
import { modelLedger } from "./model-ledger.ts";
import type { LedgerScope, LedgerScopeName } from "./model-ledger.ts";
import { microsPerDollar } from "./model-prices.ts";

// What the deployment's model calls spent, in US dollars at the providers'
// list prices, for admins to read: in a UTC month, all together, per
// workflow, per person and per App's model binding, and per run lineage
// for its whole life. Nothing
// limits it: clients pay their providers on their own keys, and the
// overview is read-only. The model ledger (model-ledger.ts) counts it:
// each provider request counts against every scope here, and adds what it
// cost once it ends.
//
// A request's run lineage is a scope too: the run, and every run started
// under it, keyed by the lineage's root run (`rootRunId` on the run's
// audit actor, which the engine's record of the run gives it, never its
// input). It is counted across all their steps, retries, restarts and
// children, for the lineage's whole life (the ledger never resets it by
// month), so none of them starts afresh. A run of another App than the
// root's (a run's own mail starts other Apps' runs under it), or of the
// root's App under another App's run, counts under its account in the
// lineage instead (`accountRunId` on its actor, from its row too,
// workflows/quotas.ts `accountClaimed`). A lineage makes at most the
// platform's provider requests (`lineageModelRequests`, 100), which stops
// a runaway run. From the threat model:
//
// - Raising it: nothing a call, an App or a run passes reaches it
//   (`scopesFor` caps it at the platform's). Only a release that changes
//   the platform's limit raises it.
// - A limit missed by runs already under way: the ledger checks the
//   lineage's count as it stands against the limit each admission
//   carries (models.ts, `scopesNow`). No limit is kept on the lineage's
//   row, so none goes stale.

/** What a call's spend is counted by. */
export interface SpendInput {
  trigger: AuditActor;
  /**
   * For an independent workflow's run, whose trigger names no App's run:
   * its lineage's root, and its workflow (models.ts, `lineage`).
   */
  lineage?: { rootRunId: string; workflowId: string };
  work?:
    | { authority: Authority }
    | { onboarding: true }
    | {
        platform:
          | "brain_upkeep"
          | "dashboard_widgets"
          | "brain_recall"
          | "stephen_requests"
          | "provider_test"
          | "document_conversion";
      };
}

/** The person a call is made by or for, if any. */
export const spendPersonOf = (input: SpendInput): string | undefined =>
  // A guest's chat counts for the member it was made for (its share of
  // the requests in flight is its own: model-admission.ts).
  input.trigger.type === "guest" ? input.trigger.invitedBy : personOf(input);

const monthPattern = /^\d{4}-(?:0[1-9]|1[0-2])$/u;

/**
 * The UTC month spend counts in now, such as `2026-09`; tests set it
 * with `MODEL_BUDGET_MONTH`.
 */
export const spendMonth = (
  env: Pick<Env, "MODEL_BUDGET_MONTH">,
  now = new Date()
): string =>
  env.MODEL_BUDGET_MONTH !== undefined &&
  monthPattern.test(env.MODEL_BUDGET_MONTH)
    ? env.MODEL_BUDGET_MONTH
    : now.toISOString().slice(0, "yyyy-mm".length);

/**
 * The most provider requests one run lineage may make, retries included
 * (platform default: 100 model requests per run lineage).
 */
export const { lineageModelRequests } = platformLimits;

/** A scope a call counts against. */
interface Scoped {
  scope: LedgerScopeName;
  key: string;
  /** The most requests it may make; none for no limit. */
  requests?: number;
}

/** A workflow whose spend is counted: an App's, in its App; or an independent one (`appId` null). */
interface SpendWorkflow {
  appId: string | null;
  workflowId: string;
}

/**
 * A workflow scope's key: an App's workflow by its App and its ID in it,
 * an independent workflow by its ID alone, so neither is ever counted as
 * the other.
 */
const workflowKeySchema = z.union([
  z.tuple([z.string(), z.string()]),
  z.tuple([z.string()]),
]);

/** The key `workflow` is counted by. */
const workflowKey = ({ appId, workflowId }: SpendWorkflow): string =>
  JSON.stringify(appId === null ? [workflowId] : [appId, workflowId]);

/** The workflow a workflow scope's `key` counts; none for a bad key. */
const workflowOf = (key: string): SpendWorkflow | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    return undefined;
  }
  const workflow = workflowKeySchema.safeParse(parsed).data;
  if (workflow === undefined) {
    return undefined;
  }
  const [first, second] = workflow;
  return second === undefined
    ? { appId: null, workflowId: first }
    : { appId: first, workflowId: second };
};

/**
 * The workflow and run lineage scopes of a workflow's call: an App run's,
 * by its trigger; an independent workflow's run, by its workflow and its
 * lineage's root (`lineage`). Either way its lineage's requests are held
 * to `requests`, every run of it together.
 */
const workflowScopes = (
  { trigger, lineage: independent }: SpendInput,
  requests: number
): Scoped[] => {
  if (trigger.type !== "workflow") {
    return independent === undefined
      ? []
      : [
          {
            scope: "workflow",
            key: workflowKey({
              appId: null,
              workflowId: independent.workflowId,
            }),
          },
          { scope: "run", key: independent.rootRunId, requests },
        ];
  }
  const lineage = trigger.accountRunId ?? trigger.rootRunId ?? trigger.runId;
  return [
    { scope: "workflow", key: workflowKey(trigger) },
    { scope: "run", key: lineage, requests },
  ];
};

/** `scoped` as the ledger takes it. */
const ledgerScope = ({ scope, key, requests }: Scoped): LedgerScope => ({
  scope,
  key,
  limitRequests: requests ?? null,
});

/**
 * The scopes a call's requests count against: the deployment, always; the
 * workflow and the run lineage, for a workflow's call; and the person it
 * is made by or for. The run lineage's requests are limited to
 * `lineageRequests` (the quota limits'), never above the platform's.
 */
export const scopesFor = (
  input: SpendInput,
  lineageRequests: number
): LedgerScope[] => {
  const person = spendPersonOf(input);
  const scopes: Scoped[] = [
    { scope: "deployment", key: "deployment" },
    ...workflowScopes(input, Math.min(lineageRequests, lineageModelRequests)),
    ...(person === undefined ? [] : [{ scope: "user" as const, key: person }]),
  ];
  return scopes.map(ledgerScope);
};

/** A model binding a call is made through (resource-model.ts). */
export interface SpendBinding {
  app: string;
  alias: string;
}

/**
 * The key a model binding's spend is counted by: the App and alias, never
 * the binding's row, so approving the alias again keeps what was spent.
 */
export const bindingKey = ({ app, alias }: SpendBinding): string =>
  JSON.stringify([app, alias]);

/**
 * The scopes a call through a model binding counts against besides
 * `scopesFor`'s: the binding's month.
 */
export const bindingScopes = (binding: SpendBinding): LedgerScope[] => [
  { scope: "binding", key: bindingKey(binding), limitRequests: null },
];

/**
 * The scopes a call on Grasp's own key counts against (one of Grasp's own
 * AI features, models.ts): Grasp's alone, so the organization's spend (the
 * deployment's, a workflow's, a run's, a person's) shows only what its own
 * keys cost. A run lineage's limit of requests, which holds every call,
 * still holds it. Still admitted and metered by the ledger, so what it
 * costs shows to Grasp's staff.
 */
export const platformScopes = (
  input: SpendInput,
  lineageRequests: number
): LedgerScope[] => [
  { scope: "platform", key: "platform", limitRequests: null },
  ...workflowScopes(input, Math.min(lineageRequests, lineageModelRequests))
    .filter(({ scope }) => scope === "run")
    .map(ledgerScope),
];

/** Names of Apps and independent workflows, by ID, as core still has them. */
interface Names {
  apps: ReadonlyMap<string, string>;
  workflows: ReadonlyMap<string, string>;
}

/** The name of `workflow`: an App's workflow's is its ID; an independent one's, null once it is gone. */
const workflowNameOf = (
  { appId, workflowId }: SpendWorkflow,
  names: Pick<Names, "workflows">
): string | null =>
  appId === null ? (names.workflows.get(workflowId) ?? null) : workflowId;

/** The name of `appId`'s App; null for none, or once it is gone. */
const appNameOf = (
  appId: string | null,
  names: Pick<Names, "apps">
): string | null => (appId === null ? null : (names.apps.get(appId) ?? null));

/** The names of the Apps and independent workflows `workflows` are in or are. */
const workflowNamesOf = async (
  db: DrizzleD1Database,
  workflows: readonly SpendWorkflow[]
): Promise<Names> => {
  const appIds = [
    ...new Set(
      workflows.flatMap(({ appId }) => (appId === null ? [] : [appId]))
    ),
  ];
  const workflowIds = [
    ...new Set(
      workflows.flatMap(({ appId, workflowId }) =>
        appId === null ? [workflowId] : []
      )
    ),
  ];
  const [appRows, workflowRows] = await Promise.all([
    appIds.length === 0
      ? []
      : db
          .select({ id: apps.id, name: apps.name })
          .from(apps)
          .where(inArray(apps.id, appIds)),
    workflowIds.length === 0
      ? []
      : db
          .select({ id: workflowResources.id, name: workflowResources.name })
          .from(workflowResources)
          // A deleted workflow is gone: its spend stays, by its ID, with
          // no name, so nothing links to it.
          .where(
            and(
              inArray(workflowResources.id, workflowIds),
              isNull(workflowResources.deletedAt)
            )
          ),
  ]);
  return {
    apps: new Map(appRows.map(({ id, name }) => [id, name])),
    workflows: new Map(workflowRows.map(({ id, name }) => [id, name])),
  };
};

/** The first millisecond of UTC month `month` (`yyyy-mm`), and of the one after. */
const monthBounds = (month: string): { from: Date; until: Date } => {
  const from = new Date(`${month}-01T00:00:00Z`);
  const until = new Date(from);
  until.setUTCMonth(until.getUTCMonth() + 1);
  return { from, until };
};

/**
 * The runs of `workflows` started in `month`, of any version, by each
 * one's key: an App's workflow's runs, and an independent workflow's.
 */
const monthRunsOf = async (
  db: DrizzleD1Database,
  workflows: readonly SpendWorkflow[],
  month: string
): Promise<Map<string, number>> => {
  const { from, until } = monthBounds(month);
  const appIds = [
    ...new Set(
      workflows.flatMap(({ appId }) => (appId === null ? [] : [appId]))
    ),
  ];
  const workflowIds = workflows.flatMap(({ appId, workflowId }) =>
    appId === null ? [workflowId] : []
  );
  const [appRuns, independentRuns] = await Promise.all([
    appIds.length === 0
      ? []
      : db
          .select({
            appId: workflowRuns.appId,
            workflowId: workflowRuns.workflowId,
            runs: count(),
          })
          .from(workflowRuns)
          .where(
            and(
              inArray(workflowRuns.appId, appIds),
              gte(workflowRuns.createdAt, from),
              lt(workflowRuns.createdAt, until)
            )
          )
          .groupBy(workflowRuns.appId, workflowRuns.workflowId),
    workflowIds.length === 0
      ? []
      : db
          .select({
            workflowId: workflowResourceRuns.workflowResourceId,
            runs: count(),
          })
          .from(workflowResourceRuns)
          .where(
            and(
              inArray(workflowResourceRuns.workflowResourceId, workflowIds),
              gte(workflowResourceRuns.createdAt, from),
              lt(workflowResourceRuns.createdAt, until)
            )
          )
          .groupBy(workflowResourceRuns.workflowResourceId),
  ]);
  return new Map([
    ...appRuns.map(
      ({ runs, ...workflow }) => [workflowKey(workflow), runs] as const
    ),
    ...independentRuns.map(
      ({ runs, workflowId }) =>
        [workflowKey({ appId: null, workflowId }), runs] as const
    ),
  ]);
};

/**
 * What the models cost in `month`: the deployment's total, and the workflows that spent most (at most
 * `modelSpendListed`), an App's and an independent one's alike, each
 * with its name and its App's where core still has them, and its runs
 * started in the month: for admins to read (models-rpc.ts).
 */
export const monthSpend = async (
  env: Pick<Env, "DB" | "MODEL_LEDGER" | "DURABLE_OBJECT_JURISDICTION">,
  month: string
): Promise<ModelMonthSpend> => {
  // One more than are listed, to tell whether any are left out.
  const spent = await modelLedger(env).spendOf(
    month,
    ["deployment", "workflow"],
    modelSpendListed + 1
  );
  const total = (spent.deployment ?? []).reduce(
    (sum, { spentMicros }) => sum + spentMicros,
    0
  );
  const rows = (spent.workflow ?? []).flatMap(({ key, spentMicros }) => {
    const workflow = workflowOf(key);
    return workflow === undefined ? [] : [{ workflow, spentMicros }];
  });
  const listed = rows.slice(0, modelSpendListed);
  const db = drizzle(env.DB);
  const [names, runs] = await Promise.all([
    workflowNamesOf(
      db,
      listed.map(({ workflow }) => workflow)
    ),
    monthRunsOf(
      db,
      listed.map(({ workflow }) => workflow),
      month
    ),
  ]);
  return {
    month,
    total: total / microsPerDollar,
    workflows: listed.map(({ workflow, spentMicros }) => ({
      ...workflow,
      name: workflowNameOf(workflow, names),
      appName: appNameOf(workflow.appId, names),
      amount: spentMicros / microsPerDollar,
      runs: runs.get(workflowKey(workflow)) ?? 0,
    })),
    more: rows.length > modelSpendListed,
  };
};
