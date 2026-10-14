import type {
  ModelBindingSpend,
  ModelBudget,
  ModelBudgetScope,
  ModelRulesSettings,
  ModelSettings,
} from "@grasp-os/shared/models";
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { dollars, percent } from "../settings/money.ts";
import {
  SettingsBody,
  SettingsError,
  SettingsLoading,
  SettingsSection,
} from "../settings/settings-parts.tsx";

// Models, for admins: the models the deployment allows and the client's
// rules for model calls (EU routing, which models take sensitive data,
// budgets). They are deployment config that Grasp sets as agreed with the
// client, so the page only shows them, as core reads them; core checks
// the role. What was spent against the budgets is AI spend's
// (`_shell.settings.spend.tsx`). Beside them, each engine's model binding
// with the caps an admin set on it (on the engine's Resources tab) and
// what it spent against them today and this month.

/** A list of IDs for a sentence, or `none`. */
const listed = (ids: readonly string[]): string =>
  ids.length === 0 ? i18n._(msg`none`) : formatList(ids);

const Section = ({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) => (
  <SettingsSection description={description} title={title}>
    <SettingsBody>{children}</SettingsBody>
  </SettingsSection>
);

const AllowedModels = ({
  models,
  rules,
}: {
  models: string[];
  rules: ModelRulesSettings | undefined;
}) => (
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>
          <Trans>Model</Trans>
        </TableHead>
        <TableHead>
          <span className="sr-only">
            <Trans>Rules</Trans>
          </span>
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {models.map((model) => (
        <TableRow key={model}>
          <TableCell>{model}</TableCell>
          <TableCell>
            <span className="flex gap-2">
              {rules?.eu?.models.includes(model) === true ? (
                <Badge variant="secondary">
                  <Trans>Hosted in the EU</Trans>
                </Badge>
              ) : null}
              {rules?.sensitive?.models.includes(model) === true ? (
                <Badge variant="secondary">
                  <Trans>Takes sensitive data</Trans>
                </Badge>
              ) : null}
            </span>
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);

const EuRouting = ({ eu }: { eu: ModelRulesSettings["eu"] }) => {
  const { t } = useLingui();
  if (eu === null) {
    return (
      <p className="text-muted-foreground text-sm">
        <Trans>No call has to stay in the EU.</Trans>
      </p>
    );
  }
  const workflows = listed(
    eu.workflows.map(({ app, workflow }) => `${workflow} (${app})`)
  );
  const connections = listed(eu.connections);
  return (
    <ul className="flex flex-col gap-1 text-sm">
      <li>
        {eu.deployment
          ? t`Every call stays in the EU: yes.`
          : t`Every call stays in the EU: no.`}
      </li>
      <li>
        <Trans>Workflows whose AI steps stay in the EU: {workflows}.</Trans>
      </li>
      <li>
        <Trans>Connections whose data stays in the EU: {connections}.</Trans>
      </li>
    </ul>
  );
};

const DataRules = ({
  sensitive,
}: {
  sensitive: ModelRulesSettings["sensitive"];
}) => {
  if (sensitive === null) {
    return (
      <p className="text-muted-foreground text-sm">
        <Trans>
          There is no data rule: any allowed model may take sensitive data.
        </Trans>
      </p>
    );
  }
  const connections = listed(sensitive.connections);
  return (
    <ul className="flex flex-col gap-1 text-sm">
      <li>
        <Trans>
          Only the models marked as taking sensitive data may be sent data from
          a sensitive collection (marked in Knowledge) or a sensitive
          connection, or from a chat, domain or run that read one.
        </Trans>
      </li>
      <li>
        <Trans>Sensitive connections: {connections}.</Trans>
      </li>
    </ul>
  );
};

const scopeTitles: Record<ModelBudgetScope, MessageDescriptor> = {
  deployment: msg`All calls together`,
  workflow: msg`Each workflow`,
  user: msg`Each person`,
  run: msg`Each workflow run, with the runs it starts`,
};

/** One budget's rule: its limit, and when admins are alerted. */
const BudgetRule = ({ budget }: { budget: ModelBudget }) => {
  const limit = dollars(budget.limit);
  const alertAt = percent(budget.alertAt);
  return (
    <div className="flex flex-col gap-1">
      <h3 className="font-medium">{i18n._(scopeTitles[budget.scope])}</h3>
      <p className="text-muted-foreground text-sm">
        {budget.scope === "run" ? (
          <Trans>
            {limit} for the run&apos;s whole life, admins alerted at {alertAt}.
            Its calls stop once it&apos;s used up or held by calls whose cost
            isn&apos;t settled yet.
          </Trans>
        ) : (
          <Trans>
            {limit} a month, admins alerted at {alertAt}. Calls stop once
            it&apos;s used up.
          </Trans>
        )}
      </p>
    </div>
  );
};

/** The limit on requests every run has, whatever the budgets. */
const RunRequests = () => (
  <p className="text-muted-foreground text-sm">
    <Trans>
      Each workflow run, with the runs it starts, may make at most 100 model
      requests, retries included.
    </Trans>
  </p>
);

const Budgets = ({ budgets }: { budgets: ModelBudget[] }) => {
  if (budgets.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-muted-foreground text-sm">
          <Trans>
            No budget is set: model calls aren&apos;t limited by cost.
          </Trans>
        </p>
        <RunRequests />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {budgets.map((budget) => (
        <BudgetRule budget={budget} key={budget.scope} />
      ))}
      <RunRequests />
      <p className="text-sm">
        <Trans>
          What was spent this month is under{" "}
          <Link className="underline underline-offset-4" to="/settings/spend">
            AI spend
          </Link>
          .
        </Trans>
      </p>
    </div>
  );
};

/** A binding's caps, each on a line of its own; or why it has none. */
const BindingCaps = ({ binding }: { binding: ModelBindingSpend }) => {
  if (binding.budgetDamaged) {
    return (
      <span className="text-destructive">
        <Trans>Its budget can&apos;t be read, so it serves nothing.</Trans>
      </span>
    );
  }
  const { budget } = binding;
  if (budget === null) {
    return (
      <span className="text-muted-foreground">
        <Trans>No caps of its own</Trans>
      </span>
    );
  }
  const { perRequest, perDay, perMonth } = budget;
  const request = perRequest === undefined ? null : dollars(perRequest);
  const daily = perDay === undefined ? null : dollars(perDay);
  const monthly = perMonth === undefined ? null : dollars(perMonth);
  const alertAt = percent(budget.alertAt);
  return (
    <ul className="flex flex-col gap-0.5">
      {request === null ? null : (
        <li>
          <Trans>{request} a request</Trans>
        </li>
      )}
      {daily === null ? null : (
        <li>
          <Trans>{daily} a day</Trans>
        </li>
      )}
      {monthly === null ? null : (
        <li>
          <Trans>{monthly} a month</Trans>
        </li>
      )}
      {daily === null && monthly === null ? null : (
        <li className="text-muted-foreground">
          <Trans>Admins alerted at {alertAt}</Trans>
        </li>
      )}
    </ul>
  );
};

/** What a binding spent in a period, and of what cap when it has one. */
const SpentOf = ({
  amount,
  cap,
}: {
  amount: number;
  cap: number | undefined;
}) => {
  const spent = dollars(amount);
  if (cap === undefined) {
    return <span className="tabular-nums">{spent}</span>;
  }
  const limit = dollars(cap);
  return (
    <span className="tabular-nums">
      <Trans>
        {spent} of {limit}
      </Trans>
    </span>
  );
};

/** How far a binding's spend is into its caps, when it is anywhere near them. */
const BindingAlert = ({ binding }: { binding: ModelBindingSpend }) => {
  if (binding.alert === "reached") {
    return (
      <Badge variant="destructive">
        <Trans>Cap reached</Trans>
      </Badge>
    );
  }
  if (binding.alert === "alerted") {
    return (
      <Badge variant="secondary">
        <Trans>Past the alert</Trans>
      </Badge>
    );
  }
  return null;
};

/** Each engine's model binding, its caps, and what it spent against them. */
const BindingBudgets = ({
  bindings,
  day,
}: {
  bindings: ModelSettings["bindings"];
  day: string;
}) => {
  const { listed: bound, more } = bindings;
  if (bound.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        <Trans>No engine has a model bound to it.</Trans>
      </p>
    );
  }
  const shown = bound.length;
  return (
    <div className="flex flex-col gap-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <Trans>Engine</Trans>
            </TableHead>
            <TableHead>
              <Trans>Caps</Trans>
            </TableHead>
            <TableHead className="text-right">
              <Trans>Today ({day}, UTC)</Trans>
            </TableHead>
            <TableHead className="text-right">
              <Trans>This month</Trans>
            </TableHead>
            <TableHead>
              <span className="sr-only">
                <Trans>Alert</Trans>
              </span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {bound.map((binding) => (
            <TableRow key={`${binding.appId}/${binding.alias}`}>
              <TableCell>
                <span className="flex flex-col gap-0.5">
                  <Link
                    className="underline underline-offset-4"
                    params={{ engine: binding.appId }}
                    to="/domains/$engine"
                  >
                    {binding.appName}
                  </Link>
                  <span className="text-muted-foreground font-mono">
                    {binding.alias}
                  </span>
                  {binding.model === null ? (
                    <span className="text-destructive text-xs">
                      <Trans>
                        What it is bound to can&apos;t be read, so it serves
                        nothing.
                      </Trans>
                    </span>
                  ) : (
                    // A model ID can be long: cut, with all of it on hover.
                    <span
                      className="text-muted-foreground block max-w-64 truncate font-mono text-xs"
                      title={binding.model}
                    >
                      {binding.model}
                    </span>
                  )}
                </span>
              </TableCell>
              <TableCell>
                <BindingCaps binding={binding} />
              </TableCell>
              <TableCell className="text-right">
                <SpentOf amount={binding.today} cap={binding.budget?.perDay} />
              </TableCell>
              <TableCell className="text-right">
                <SpentOf
                  amount={binding.thisMonth}
                  cap={binding.budget?.perMonth}
                />
              </TableCell>
              <TableCell>
                <BindingAlert binding={binding} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {more ? (
        <p className="text-muted-foreground text-sm">
          <Trans>
            The first {shown} by engine; more engines have models bound.
          </Trans>
        </p>
      ) : null}
    </div>
  );
};

/**
 * The engine budgets section: shown whatever the gateway's configuration
 * says, as what was spent stays worth seeing while calls are refused.
 */
const EngineBudgets = ({ settings }: { settings: ModelSettings }) => {
  const { t } = useLingui();
  return (
    <Section
      description={
        <Trans>
          Caps an admin set on an engine&apos;s model, on the engine&apos;s
          Resources tab, on top of the deployment&apos;s budgets, and what the
          engine&apos;s actions spent through it. A workflow&apos;s own AI steps
          don&apos;t count here.
        </Trans>
      }
      title={t`Engine budgets`}
    >
      <BindingBudgets bindings={settings.bindings} day={settings.day} />
    </Section>
  );
};

const Settings = ({ settings }: { settings: ModelSettings }) => {
  const { t } = useLingui();
  if (settings.models.length === 0) {
    return (
      <>
        <Section title={t`Allowed models`}>
          <p className="text-muted-foreground text-sm">
            <Trans>
              Models aren&apos;t set up for this deployment yet, so no model
              call can be made. Grasp sets them up.
            </Trans>
          </p>
        </Section>
        <EngineBudgets settings={settings} />
      </>
    );
  }
  const { rules } = settings;
  const on = rules.state === "on" ? rules : undefined;
  return (
    <>
      <Section
        description={
          <Trans>
            Grasp sets these for your organization, as agreed with you. To
            change them, contact Grasp.
          </Trans>
        }
        title={t`Allowed models`}
      >
        {rules.state === "invalid" ? (
          <ErrorText>
            {t`The rules in this deployment's configuration can't be read, so every model call is refused. Contact Grasp.`}
          </ErrorText>
        ) : null}
        <AllowedModels models={settings.models} rules={on} />
      </Section>
      {on === undefined ? null : (
        <>
          <Section title={t`EU routing`}>
            <EuRouting eu={on.eu} />
          </Section>
          <Section title={t`Data rules`}>
            <DataRules sensitive={on.sensitive} />
          </Section>
          <Section title={t`Budgets`}>
            <Budgets budgets={on.budgets} />
          </Section>
        </>
      )}
      <EngineBudgets settings={settings} />
    </>
  );
};

const Models = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  if (page.state !== "ready") {
    return (
      <SettingsSection title={t`Models`}>
        <NotLoadedState heading="h3" page={page} />
      </SettingsSection>
    );
  }
  return <Settings settings={page.data} />;
};

export const Route = createFileRoute("/_shell/settings/models")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: Models,
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await session.models.settings()
    ),
});
