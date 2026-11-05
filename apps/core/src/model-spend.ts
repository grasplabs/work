import type { AuditActor } from "@grasp-os/shared/audit";
import type { ModelMonthSpend } from "@grasp-os/shared/models";
import { modelSpendListed } from "@grasp-os/shared/models";
import type { Authority } from "@grasp-os/shared/permissions";
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import {
  apps,
  modelUsage,
  workflowResourceRuns,
  workflowResources,
  workflowRuns,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";

// What the deployment's model calls spent, in US dollars at the providers'
// list prices, for admins to read: in a UTC month, all together, per
// workflow, per person and per App's model binding. Nothing limits it:
// clients pay their providers on their own keys, and the overview is
// read-only. Each response is recorded after it, as one `model_usage` row
// (model-usage.ts), and the overview is a query over those rows, as the
// usual gateways keep spend: metered after the response, never reserved
// before it, so the accounting can never fail a call. A row whose write
// failed is logged and missing from the overview; the provider's invoice
// is the bill.

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
  /** The App's model binding the call is made through. */
  binding?: { app: string; alias: string };
}

/**
 * The person a call is made by or for, if any: who makes it, whom an
 * agent or a run acts for, and for a guest's chat the member who invited
 * them.
 */
export const spendPersonOf = ({
  trigger,
  work,
}: SpendInput): string | undefined => {
  if (trigger.type === "person" || trigger.type === "staff") {
    return trigger.userId;
  }
  if (trigger.type === "agent") {
    return trigger.onBehalfOf;
  }
  if (trigger.type === "guest") {
    return trigger.invitedBy;
  }
  return work !== undefined && "authority" in work
    ? work.authority.onBehalfOf
    : undefined;
};

const monthPattern = /^\d{4}-(?:0[1-9]|1[0-2])$/u;

/**
 * The UTC month spend counts in now, such as `2026-09`; tests set it
 * with `SPEND_MONTH`.
 */
export const spendMonth = (
  env: Pick<Env, "SPEND_MONTH">,
  now = new Date()
): string =>
  env.SPEND_MONTH !== undefined && monthPattern.test(env.SPEND_MONTH)
    ? env.SPEND_MONTH
    : now.toISOString().slice(0, "yyyy-mm".length);

/** What a usage row is counted by: whom, which workflow, run and binding. */
export interface SpendKeys {
  personId: string | null;
  triggerType: string;
  workflowAppId: string | null;
  workflowId: string | null;
  runId: string | null;
  bindingAppId: string | null;
  bindingAlias: string | null;
}

/**
 * What a call's usage counts by, from its trigger, work and lineage, which
 * core's host sets, never App code: an App run's workflow and lineage by
 * its trigger (its account's run where it has one, workflows/quotas.ts
 * `accountClaimed`); an independent workflow's run by its `lineage`.
 */
export const spendKeysOf = (input: SpendInput): SpendKeys => {
  const { trigger, lineage, binding } = input;
  let workflow: Pick<SpendKeys, "workflowAppId" | "workflowId" | "runId"> = {
    workflowAppId: null,
    workflowId: null,
    runId: null,
  };
  if (trigger.type === "workflow") {
    workflow = {
      workflowAppId: trigger.appId,
      workflowId: trigger.workflowId,
      runId: trigger.accountRunId ?? trigger.rootRunId ?? trigger.runId,
    };
  } else if (lineage !== undefined) {
    workflow = {
      workflowAppId: null,
      workflowId: lineage.workflowId,
      runId: lineage.rootRunId,
    };
  }
  return {
    personId: spendPersonOf(input) ?? null,
    triggerType: trigger.type,
    ...workflow,
    bindingAppId: binding?.app ?? null,
    bindingAlias: binding?.alias ?? null,
  };
};

/** Micros in a US dollar: what the platform's spend is reported in. */
const microsPerDollar = 1_000_000;

/** The organization's own spend: never Grasp's features on Grasp's key. */
const organizationIn = (month: string) =>
  and(eq(modelUsage.period, month), eq(modelUsage.credential, "organization"));

/** A workflow whose spend is counted: an App's, in its App; or an independent one (`appId` null). */
interface SpendWorkflow {
  appId: string | null;
  workflowId: string;
}

/** The key `workflow` is told apart by. */
const workflowKey = ({ appId, workflowId }: SpendWorkflow): string =>
  JSON.stringify(appId === null ? [workflowId] : [appId, workflowId]);

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

/** The App IDs of `workflows`, and the IDs of the independent ones. */
const idsOf = (workflows: readonly SpendWorkflow[]) => ({
  appIds: [
    ...new Set(
      workflows.flatMap(({ appId }) => (appId === null ? [] : [appId]))
    ),
  ],
  workflowIds: [
    ...new Set(
      workflows.flatMap(({ appId, workflowId }) =>
        appId === null ? [workflowId] : []
      )
    ),
  ],
});

/** The names of the Apps and independent workflows `workflows` are in or are. */
const workflowNamesOf = async (
  db: DrizzleD1Database,
  workflows: readonly SpendWorkflow[]
): Promise<Names> => {
  const { appIds, workflowIds } = idsOf(workflows);
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
  const { appIds, workflowIds } = idsOf(workflows);
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
 * What the models cost in `month` on the organization's keys: the
 * deployment's total, and the workflows that spent most (at most
 * `modelSpendListed`), an App's and an independent one's alike, each with
 * its name and its App's where core still has them, and its runs started
 * in the month: for admins to read (models-rpc.ts).
 */
export const monthSpend = async (
  env: Pick<Env, "DB">,
  month: string
): Promise<ModelMonthSpend> => {
  const db = drizzle(env.DB);
  const spent = sql<number>`sum(${modelUsage.cost})`;
  const [totals, rows] = await Promise.all([
    db.select({ total: spent }).from(modelUsage).where(organizationIn(month)),
    // One more than are listed, to tell whether any are left out.
    db
      .select({
        appId: modelUsage.workflowAppId,
        workflowId: modelUsage.workflowId,
        amount: spent,
      })
      .from(modelUsage)
      .where(and(organizationIn(month), isNotNull(modelUsage.workflowId)))
      .groupBy(modelUsage.workflowAppId, modelUsage.workflowId)
      .orderBy(desc(spent))
      .limit(modelSpendListed + 1),
  ]);
  const listed = rows
    .slice(0, modelSpendListed)
    .flatMap(({ appId, workflowId, amount }) =>
      // Never expected: the query keeps only rows with a workflow.
      workflowId === null ? [] : [{ workflow: { appId, workflowId }, amount }]
    );
  const workflows = listed.map(({ workflow }) => workflow);
  const [names, runs] = await Promise.all([
    workflowNamesOf(db, workflows),
    monthRunsOf(db, workflows, month),
  ]);
  return {
    month,
    total: totals[0]?.total ?? 0,
    workflows: listed.map(({ workflow, amount }) => ({
      ...workflow,
      name: workflowNameOf(workflow, names),
      appName: appNameOf(workflow.appId, names),
      amount,
      runs: runs.get(workflowKey(workflow)) ?? 0,
    })),
    more: rows.length > modelSpendListed,
  };
};

/** A model binding, by its App and alias. */
export interface SpendBinding {
  app: string;
  alias: string;
}

/** The key a model binding's spend is told apart by. */
export const bindingKey = ({ app, alias }: SpendBinding): string =>
  JSON.stringify([app, alias]);

/**
 * What the calls through each of `bindings` spent in `month`, in US
 * dollars, by `bindingKey`: only the bindings that spent anything. The
 * binding's App and alias, never its row, so approving the alias again
 * keeps what was spent.
 */
export const bindingSpendOf = async (
  env: Pick<Env, "DB">,
  month: string,
  bindings: readonly SpendBinding[]
): Promise<Map<string, number>> => {
  const appIds = [...new Set(bindings.map(({ app }) => app))];
  if (appIds.length === 0) {
    return new Map();
  }
  const rows = await drizzle(env.DB)
    .select({
      app: modelUsage.bindingAppId,
      alias: modelUsage.bindingAlias,
      amount: sql<number>`sum(${modelUsage.cost})`,
    })
    .from(modelUsage)
    .where(
      and(
        organizationIn(month),
        inList(modelUsage.bindingAppId, appIds),
        isNotNull(modelUsage.bindingAlias)
      )
    )
    .groupBy(modelUsage.bindingAppId, modelUsage.bindingAlias);
  return new Map(
    rows.flatMap(({ app, alias, amount }) =>
      app === null || alias === null
        ? []
        : [[bindingKey({ app, alias }), amount] as const]
    )
  );
};

/** What one model cost one of Grasp's features on Grasp's keys in a month. */
export interface PlatformSpendByPeriod {
  period: string;
  /** The feature as recorded; null for a request without one. */
  feature: string | null;
  model: string;
  micros: number;
}

/**
 * What Grasp's own features cost on its keys in each of `periods`, by
 * feature and model, the dearest first: none that came to nothing.
 */
export const platformSpend = async (
  env: Pick<Env, "DB">,
  periods: readonly string[]
): Promise<PlatformSpendByPeriod[]> => {
  const spent = sql<number>`sum(${modelUsage.cost})`;
  const rows = await drizzle(env.DB)
    .select({
      period: modelUsage.period,
      feature: modelUsage.feature,
      model: modelUsage.model,
      amount: spent,
    })
    .from(modelUsage)
    .where(
      and(
        eq(modelUsage.credential, "platform"),
        inList(modelUsage.period, periods)
      )
    )
    .groupBy(modelUsage.period, modelUsage.feature, modelUsage.model)
    .orderBy(desc(spent));
  return rows.flatMap(({ amount, ...row }) => {
    const micros = Math.round(amount * microsPerDollar);
    return micros > 0 ? [{ ...row, micros }] : [];
  });
};
