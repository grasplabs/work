import type {
  ModelBudget,
  ModelSettings,
  ModelSpender,
} from "@grasp-os/shared/models";
import { Progress } from "@grasp-os/ui/components/progress";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { dollars, monthEnd, percent, shareOf } from "../settings/money.ts";
import {
  SettingsBody,
  SettingsError,
  SettingsLoading,
  SettingsSection,
} from "../settings/settings-parts.tsx";

// AI spend, for admins, as in the prototype (`routes/settings/spend.tsx`):
// what the models cost this month, as core counts it against the budgets
// Grasp sets, and where it went, by workflow and by person. Core counts
// spend only against a budget, so without one there is nothing to show;
// the budgets' limits are rules, and stay on the Models page.

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
    <span className="text-2xl leading-tight font-medium tabular-nums">
      {value}
    </span>
    <span className="text-muted-foreground text-xs">{sub}</span>
  </div>
);

/** This month so far, against the budget of all calls together, and where it ends. */
const Month = ({ budget, month }: { budget: ModelBudget; month: string }) => {
  const { t } = useLingui();
  const spent = budget.spent.reduce((sum, { amount }) => sum + amount, 0);
  const share = percent(shareOf(spent, budget.limit));
  const limit = dollars(budget.limit);
  const end = monthEnd(spent, month, new Date());
  const ending = end === null ? null : dollars(end);
  return (
    <div className="bg-border grid gap-px border-t sm:grid-cols-2">
      <Figure
        label={t`This month so far`}
        sub={t`${share} of the ${limit} budget`}
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

/** Who spent part of a budget, by the name core has for them. */
const spenderName = (of: ModelSpender, i18n: I18n): string => {
  if (of.type === "deployment") {
    return i18n._(msg`All calls`);
  }
  if (of.type === "workflow") {
    const { workflowId } = of;
    const engine = of.appName ?? of.appId;
    return i18n._(msg`${workflowId} in ${engine}`);
  }
  return of.name ?? of.userId;
};

const byTitles = {
  workflow: msg`By workflow`,
  user: msg`By person`,
} as const;

/** Where a budget of each workflow or each person went: one line each, most first. */
const SpentBy = ({
  budget,
}: {
  budget: ModelBudget & { scope: "workflow" | "user" };
}) => {
  const { t, i18n } = useLingui();
  const limit = dollars(budget.limit);
  const alertAt = percent(budget.alertAt);
  const top = budget.spent.length;
  return (
    <SettingsSection
      description={t`${limit} a month for each, admins alerted at ${alertAt}.`}
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

const Spend = ({ settings }: { settings: ModelSettings }) => {
  const { t } = useLingui();
  const { month } = settings;
  const budgets =
    settings.rules.state === "on" ? settings.rules.budgets : undefined;
  if (budgets === undefined || budgets.length === 0) {
    return (
      <SettingsSection title={t`AI spend`}>
        <SettingsBody>
          <p className="text-muted-foreground">
            <Trans>
              Grasp counts what the models cost against the budgets it sets for
              you. No budget is set, so there is nothing to show.
            </Trans>
          </p>
        </SettingsBody>
      </SettingsSection>
    );
  }
  const all = budgets.find(({ scope }) => scope === "deployment");
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
        {all === undefined ? null : <Month budget={all} month={month} />}
      </SettingsSection>
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
  if (page.state !== "ready") {
    return (
      <SettingsSection title={t`AI spend`}>
        <NotLoadedState heading="h3" page={page} />
      </SettingsSection>
    );
  }
  return <Spend settings={page.data} />;
};

export const Route = createFileRoute("/_shell/settings/spend")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: SpendPage,
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await session.models.settings()
    ),
});
