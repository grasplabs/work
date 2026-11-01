import type {
  ModelBudget,
  ModelMonthSpend,
  ModelSettings,
  ModelSpender,
} from "@grasp-os/shared/models";
import { isAdmin } from "@grasp-os/shared/roles";
import { Progress } from "@grasp-os/ui/components/progress";
import { Stat } from "@grasp-os/ui/components/stat";
import type { I18n } from "@lingui/core";
import { msg, ph, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { dollars, monthEnd, percent, shareOf } from "../settings/money.ts";
import { PersonLimitsSection } from "../settings/person-limits.tsx";
import {
  SettingsBody,
  SettingsError,
  SettingsLoading,
  SettingsSection,
} from "../settings/settings-parts.tsx";

// AI spend, for admins, as in the prototype (`routes/settings/spend.tsx`):
// what the models cost this month, as core counts it against the budgets
// Grasp sets, and where it went, by workflow, person and run. Core counts
// every call, budget or not, so the month's total and the workflows that
// spent most show without one; the budgets' limits are rules, and stay on
// the Models page. The limits the company's admins set per person show
// here too, beside what each person spent (settings/person-limits.tsx).

/** One number of the top row: what it is, the amount, and a line that puts it in its place. */
const Figure = ({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) => (
  <div className="bg-card flex flex-col gap-0.5 px-5 py-4">
    <span className="text-muted-foreground text-xs">{label}</span>
    <Stat>{value}</Stat>
    <span className="text-muted-foreground text-xs">{sub}</span>
  </div>
);

/** What `spent` is of the budget of all calls together, if one is set. */
const ofBudget = (
  spent: number,
  budget: ModelBudget | undefined,
  i18n: I18n
): string => {
  if (budget === undefined) {
    return i18n._(msg`No budget is set for all calls together`);
  }
  const share = percent(shareOf(spent, budget.limit));
  const limit = dollars(budget.limit);
  return i18n._(msg`${share} of the ${limit} budget`);
};

/** This month so far, against the budget of all calls together if one is set, and where it ends. */
const Month = ({
  spent,
  budget,
  month,
}: {
  spent: number;
  budget: ModelBudget | undefined;
  month: string;
}) => {
  const { t, i18n } = useLingui();
  const end = monthEnd(spent, month, new Date());
  const ending = end === null ? null : dollars(end);
  return (
    <div className="bg-border grid gap-px border-t sm:grid-cols-2">
      <Figure
        label={t`This month so far`}
        sub={ofBudget(spent, budget, i18n)}
        value={dollars(spent)}
      />
      {ending === null ? null : (
        <Figure
          label={t`By the end of the month`}
          sub={t`If the rest of the month goes like the days so far`}
          value={t`About ${ending}`}
        />
      )}
    </div>
  );
};

/** How much of a run's ID names it beside its workflow and start time. */
const shortRunId = 8;

/** Who spent part of a budget, by the name core has for them. */
const spenderName = (of: ModelSpender, i18n: I18n): string => {
  if (of.type === "deployment") {
    return i18n._(msg`All calls`);
  }
  if (of.type === "workflow") {
    const workflow = of.name ?? of.workflowId;
    if (of.appId === null) {
      return workflow;
    }
    const engine = of.appName ?? of.appId;
    return i18n._(msg`${workflow} in ${ph({ domain: engine })}`);
  }
  if (of.type === "run") {
    const { runId } = of;
    if (of.workflowId === null || of.startedAt === null) {
      return i18n._(msg`Run ${runId}`);
    }
    // Runs of one workflow told apart by when each started, and its ID.
    const workflow = of.workflowName ?? of.workflowId;
    const started = formatDateTime(of.startedAt);
    const shortId = runId.slice(0, shortRunId);
    const rootId = of.rootRunId?.slice(0, shortRunId);
    if (of.appId === null) {
      // An independent workflow's run in another run's chain.
      return rootId === undefined
        ? i18n._(msg`Run ${shortId} of ${workflow}, started ${started}`)
        : i18n._(
            msg`Run ${shortId} of ${workflow}, started ${started}, in the run chain started by run ${rootId}`
          );
    }
    const engine = of.appName ?? of.appId;
    // An account in another run's lineage: never shown as its root.
    if (rootId !== undefined) {
      return i18n._(
        msg`Run ${shortId} of ${workflow} in ${ph({ domain: engine })}, started ${started}, in the run chain started by run ${rootId}`
      );
    }
    return i18n._(
      msg`Run ${shortId} of ${workflow} in ${ph({ domain: engine })}, started ${started}`
    );
  }
  return of.name ?? of.userId;
};

const byTitles = {
  workflow: msg`By workflow`,
  user: msg`By person`,
  run: msg`By workflow run`,
} as const;

/** What a budget of each workflow, person or run allows each one. */
const eachLimit = (
  budget: ModelBudget & { scope: "workflow" | "user" | "run" },
  i18n: I18n
): string => {
  const limit = dollars(budget.limit);
  const alertAt = percent(budget.alertAt);
  return budget.scope === "run"
    ? i18n._(
        msg`${limit} for each run, with the runs it starts, over its whole life, admins alerted at ${alertAt}. What each spent so far, this month or before.`
      )
    : i18n._(msg`${limit} a month for each, admins alerted at ${alertAt}.`);
};

/** Where a budget of each workflow, person or run went: one line each, most first. */
const SpentBy = ({
  budget,
}: {
  budget: ModelBudget & { scope: "workflow" | "user" | "run" };
}) => {
  const { t, i18n } = useLingui();
  const top = budget.spent.length;
  return (
    <SettingsSection
      description={eachLimit(budget, i18n)}
      title={i18n._(byTitles[budget.scope])}
    >
      {budget.spent.length === 0 ? (
        <SettingsBody>
          <p className="text-muted-foreground">
            <Trans>Nothing spent yet.</Trans>
          </p>
        </SettingsBody>
      ) : (
        <ul>
          {budget.spent.map(({ of, amount }) => {
            const name = spenderName(of, i18n);
            const share = shareOf(amount, budget.limit);
            const shown = percent(share);
            return (
              <li
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1.5 border-t px-5 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto]"
                key={JSON.stringify(of)}
              >
                <span className="truncate">{name}</span>
                <Progress
                  aria-label={t`${name}: ${shown} of the limit`}
                  className="col-span-2 row-start-2 md:col-span-1 md:row-start-auto"
                  value={Math.min(share, 100)}
                />
                <span className="col-start-2 row-start-1 text-right tabular-nums md:col-start-auto md:row-start-auto">
                  {dollars(amount)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {budget.more ? (
        <p className="text-muted-foreground border-t px-5 py-3">
          <Trans>The {top} who spent most; more spent less.</Trans>
        </p>
      ) : null}
    </SettingsSection>
  );
};

/**
 * The workflows whose model calls cost most this month, with their runs
 * started this month: shown when no budget of each workflow lists them.
 */
const WorkflowsThisMonth = ({ spend }: { spend: ModelMonthSpend }) => {
  const { t, i18n } = useLingui();
  const top = spend.workflows.length;
  return (
    <SettingsSection
      description={t`What each workflow's model calls cost this month, most first, and how often it ran.`}
      title={t`Workflows this month`}
    >
      {spend.workflows.length === 0 ? (
        <SettingsBody>
          <p className="text-muted-foreground">
            <Trans>No workflow has called a model this month.</Trans>
          </p>
        </SettingsBody>
      ) : (
        <ul>
          {spend.workflows.map(
            ({ appId, appName, workflowId, name, amount, runs }) => (
              <li
                className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-6 border-t px-5 py-3"
                key={JSON.stringify([appId, workflowId])}
              >
                <span className="truncate">
                  {spenderName(
                    { type: "workflow", appId, appName, workflowId, name },
                    i18n
                  )}
                </span>
                <span className="text-muted-foreground text-right tabular-nums">
                  {t`${plural(runs, { one: "# run", other: "# runs" })}`}
                </span>
                <span className="text-right tabular-nums">
                  {dollars(amount)}
                </span>
              </li>
            )
          )}
        </ul>
      )}
      {spend.more ? (
        <p className="text-muted-foreground border-t px-5 py-3">
          <Trans>The {top} that spent most; more spent less.</Trans>
        </p>
      ) : null}
    </SettingsSection>
  );
};

const Spend = ({
  settings,
  spend,
}: {
  settings: ModelSettings;
  spend: ModelMonthSpend;
}) => {
  const { t } = useLingui();
  const { month } = settings;
  if (settings.rules.state === "invalid") {
    return (
      <SettingsSection title={t`AI spend`}>
        <SettingsBody>
          <ErrorText>
            {t`The rules in this deployment's configuration can't be read, so every model call is refused. Contact Grasp.`}
          </ErrorText>
        </SettingsBody>
      </SettingsSection>
    );
  }
  const { budgets } = settings.rules;
  const all = budgets.find(({ scope }) => scope === "deployment");
  const eachWorkflow = budgets.some(({ scope }) => scope === "workflow");
  return (
    <>
      <SettingsSection
        description={
          <Trans>
            What the models cost that work for you in Grasp this month ({month},
            UTC), in US dollars, as they are priced.
          </Trans>
        }
        title={t`AI spend`}
      >
        <Month budget={all} month={month} spent={spend.total} />
      </SettingsSection>
      {eachWorkflow ? null : <WorkflowsThisMonth spend={spend} />}
      {budgets.map((budget) =>
        budget.scope === "deployment" ? null : (
          <SpentBy
            budget={{ ...budget, scope: budget.scope }}
            key={budget.scope}
          />
        )
      )}
    </>
  );
};

const SpendPage = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  if (page.state !== "ready") {
    return (
      <SettingsSection title={t`AI spend`}>
        <NotLoadedState heading="h3" page={page} />
      </SettingsSection>
    );
  }
  return (
    <>
      <Spend settings={page.data.settings} spend={page.data.spend} />
      <PersonLimitsSection
        editable={isAdmin(identity.role)}
        limits={page.data.limits}
      />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/spend")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: SpendPage,
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session) => {
      const [settings, spend, limits] = await Promise.all([
        session.models.settings(),
        session.models.spend(),
        session.models.limits(),
      ]);
      return { settings, spend, limits };
    }),
});
