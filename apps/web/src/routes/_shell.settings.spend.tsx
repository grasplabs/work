import type {
  ModelMonthSpend,
  ModelSettings,
  SpendingWorkflow,
} from "@grasp-os/shared/models";
import type { I18n } from "@lingui/core";
import { msg, ph, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { RouterLink } from "../frame/router-link.tsx";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../grasp/table/index.ts";
import { Text } from "../grasp/text/index.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { dollars, monthEnd } from "../settings/money.ts";
import {
  FactRow,
  FactValue,
  SectionNotLoaded,
  SettingsRows,
  SettingsError,
  SettingsLoading,
} from "../settings/section.tsx";

// AI spend, for admins: what the models cost this month, as core counts
// it, which workflows spent most, and what each App's model binding spent.
// Read-only: the organization pays its AI providers on its own keys, and
// nothing in Grasp limits what it spends. The models themselves are
// chosen on AI providers (settings/ai-providers.tsx).

/** This month so far, and where it ends if the rest goes like the days so far. */
const Month = ({ spend }: { spend: ModelMonthSpend }) => {
  const { t } = useLingui();
  const { month } = spend;
  const end = monthEnd(spend.total, month, new Date());
  const ending = end === null ? null : dollars(end);
  return (
    <SectionCard
      description={t`In US dollars, as the models are priced (${month}, UTC).`}
      flush
      title={t`This month`}
    >
      <SettingsRows>
        <FactRow label={t`So far`}>{dollars(spend.total)}</FactRow>
        {ending === null ? null : (
          <FactRow
            help={t`If the rest goes like the days so far.`}
            label={t`By the end of the month`}
          >
            {t`About ${ending}`}
          </FactRow>
        )}
      </SettingsRows>
    </SectionCard>
  );
};

/** A workflow's name, with its App's for an App's workflow. */
const workflowName = (of: SpendingWorkflow, i18n: I18n): string => {
  const workflow = of.name ?? of.workflowId;
  if (of.appId === null) {
    return workflow;
  }
  const app = of.appName ?? of.appId;
  return i18n._(msg`${workflow} in ${ph({ app })}`);
};

/** The workflows whose model calls cost most this month, with their runs started this month. */
const WorkflowsThisMonth = ({ spend }: { spend: ModelMonthSpend }) => {
  const { t, i18n } = useLingui();
  const top = spend.workflows.length;
  const none = top === 0;
  return (
    <SectionCard
      description={t`What their model calls cost this month, most first.`}
      flush={!none}
      {...(spend.more
        ? { footer: t`The ${top} that spent most; more spent less.` }
        : {})}
      title={t`Workflows`}
    >
      {none ? (
        <Text size="sm" tone="muted">
          {t`No workflow has called a model this month.`}
        </Text>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t`Workflow`}</TableHead>
              <TableHead align="end">{t`Runs`}</TableHead>
              <TableHead align="end">{t`This month`}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {spend.workflows.map(
              ({ appId, appName, workflowId, name, amount, runs }) => (
                <TableRow key={JSON.stringify([appId, workflowId])}>
                  <TableCell wrap>
                    {workflowName({ appId, appName, workflowId, name }, i18n)}
                  </TableCell>
                  <TableCell align="end">
                    {t`${plural(runs, { one: "# run", other: "# runs" })}`}
                  </TableCell>
                  <TableCell align="end">{dollars(amount)}</TableCell>
                </TableRow>
              )
            )}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
};

/** Each App's model binding, and what it spent this month. */
const AppSpend = ({ settings }: { settings: Loaded<ModelSettings> }) => {
  const { t } = useLingui();
  const description = t`Through each App's own model; workflows' AI steps count above.`;
  if (settings.state !== "ready") {
    return (
      <SectionCard description={description} title={t`App spend`}>
        <SectionNotLoaded page={settings} />
      </SectionCard>
    );
  }
  const { listed: bound, more } = settings.data.bindings;
  const shown = bound.length;
  return (
    <SectionCard
      description={description}
      flush={shown > 0}
      {...(more
        ? { footer: t`The first ${shown} by App; more Apps have models bound.` }
        : {})}
      title={t`App spend`}
    >
      {shown === 0 ? (
        <Text size="sm" tone="muted">
          {t`No App has a model bound to it.`}
        </Text>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t`App`}</TableHead>
              <TableHead align="end">{t`This month`}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bound.map((binding) => {
              const { alias, model } = binding;
              return (
                <TableRow key={`${binding.appId}/${alias}`}>
                  <TableCell wrap>
                    <FactValue
                      note={
                        model === null
                          ? t`What it is bound to can't be read, so it serves nothing.`
                          : t`${alias} · ${model}`
                      }
                    >
                      <RouterLink
                        params={{ app: binding.appId }}
                        to="/apps/$app/settings"
                      >
                        {binding.appName}
                      </RouterLink>
                    </FactValue>
                  </TableCell>
                  <TableCell align="end">
                    {dollars(binding.thisMonth)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
};

const SpendPage = () => {
  const { t } = useLingui();
  const { spend, settings } = Route.useLoaderData();
  if (spend.state !== "ready") {
    return (
      <SectionCard title={t`This month`}>
        <SectionNotLoaded page={spend} />
      </SectionCard>
    );
  }
  return (
    <>
      <Month spend={spend.data} />
      <WorkflowsThisMonth spend={spend.data} />
      <AppSpend settings={settings} />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/spend")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: SpendPage,
  loader: async ({ context: { core } }) => {
    const [spend, settings] = await Promise.all([
      loadFromCore(core, async (session) => await session.models.spend()),
      loadFromCore(core, async (session) => await session.models.settings()),
    ]);
    return { spend, settings };
  },
});
