import type {
  ModelMonthSpend,
  SpendingWorkflow,
} from "@grasp-os/shared/models";
import { Stat } from "@grasp-os/ui/components/stat";
import type { I18n } from "@lingui/core";
import { msg, ph, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { dollars, monthEnd } from "../settings/money.ts";
import {
  SettingsBody,
  SettingsError,
  SettingsLoading,
  SettingsSection,
} from "../settings/settings-parts.tsx";

// AI spend, for admins, as in the prototype (`routes/settings/spend.tsx`):
// what the models cost this month, as core counts it, and which workflows
// spent most. Read-only: the organization pays its AI providers on its own
// keys, and nothing in Grasp limits what it spends.

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

/** This month so far, and where it ends. */
const Month = ({ spent, month }: { spent: number; month: string }) => {
  const { t } = useLingui();
  const end = monthEnd(spent, month, new Date());
  const ending = end === null ? null : dollars(end);
  return (
    <div className="bg-border grid gap-px border-t sm:grid-cols-2">
      <Figure
        label={t`This month so far`}
        sub={t`All model calls together`}
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

/** A workflow's name, with its domain's for an App's workflow. */
const workflowName = (of: SpendingWorkflow, i18n: I18n): string => {
  const workflow = of.name ?? of.workflowId;
  if (of.appId === null) {
    return workflow;
  }
  const engine = of.appName ?? of.appId;
  return i18n._(msg`${workflow} in ${ph({ domain: engine })}`);
};

/** The workflows whose model calls cost most this month, with their runs started this month. */
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
                  {workflowName({ appId, appName, workflowId, name }, i18n)}
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
  const spend = page.data;
  const { month } = spend;
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
        <Month month={month} spent={spend.total} />
      </SettingsSection>
      <WorkflowsThisMonth spend={spend} />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/spend")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: SpendPage,
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session) => await session.models.spend()),
});
