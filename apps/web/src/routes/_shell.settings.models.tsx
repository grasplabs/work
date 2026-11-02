import type { ModelSettings } from "@grasp-os/shared/models";
import { isAdmin } from "@grasp-os/shared/roles";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { dollars } from "../settings/money.ts";
import {
  SettingsBody,
  SettingsError,
  SettingsLoading,
  SettingsSection,
} from "../settings/settings-parts.tsx";

// Models, for admins: the models the organization's calls may use. They
// are the organization's own choice, made with its AI provider keys in
// Settings › AI providers, so the page only shows them and points there:
// its own admins get the link, anyone else (Grasp staff, who read but
// never change whose key pays) who to ask; core checks the role. Beside
// them, the one limit every run has, and what each engine's model binding
// spent this month. What all calls spent is AI spend's
// (`_shell.settings.spend.tsx`). Nothing here limits spend: the
// organization pays its providers on its own keys.

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

const AllowedModels = ({ models }: { models: string[] }) => (
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>
          <Trans>Model</Trans>
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {models.map((model) => (
        <TableRow key={model}>
          <TableCell>{model}</TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);

/** The limit on requests every run has. */
const RunRequests = () => (
  <p className="text-muted-foreground text-sm">
    <Trans>
      Each workflow run, with the runs it starts, may make at most 100 model
      requests, retries included.
    </Trans>
  </p>
);

/** Each engine's model binding, and what it spent this month. */
const BindingSpend = ({
  bindings,
}: {
  bindings: ModelSettings["bindings"];
}) => {
  const { listed: bound, more } = bindings;
  if (bound.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        <Trans>No domain has a model bound to it.</Trans>
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
              <Trans>Domain</Trans>
            </TableHead>
            <TableHead className="text-right">
              <Trans>This month</Trans>
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
                    <span className="text-status-attention text-xs">
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
              <TableCell className="text-right">
                <span className="tabular-nums">
                  {dollars(binding.thisMonth)}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {more ? (
        <p className="text-muted-foreground text-sm">
          <Trans>
            The first {shown} by domain; more domains have models bound.
          </Trans>
        </p>
      ) : null}
    </div>
  );
};

/** What each domain's model spent: shown whether or not models are chosen. */
const EngineSpend = ({ settings }: { settings: ModelSettings }) => {
  const { t } = useLingui();
  return (
    <Section
      description={
        <Trans>
          What each domain&apos;s actions spent through its model this month. A
          workflow&apos;s own AI steps don&apos;t count here.
        </Trans>
      }
      title={t`Domain spend`}
    >
      <BindingSpend bindings={settings.bindings} />
    </Section>
  );
};

/**
 * Where the models are changed: Settings › AI providers, for the
 * organization's own admins; anyone else asks them.
 */
const WhereToChange = ({ canChange }: { canChange: boolean }) =>
  canChange ? (
    <Trans>
      To change them, go to{" "}
      <Link
        className="underline underline-offset-4"
        to="/settings/ai-providers"
      >
        Settings › AI providers
      </Link>
      .
    </Trans>
  ) : (
    <Trans>To change them, ask your admin.</Trans>
  );

const Settings = ({
  settings,
  canChange,
}: {
  settings: ModelSettings;
  canChange: boolean;
}) => {
  const { t } = useLingui();
  if (settings.models.length === 0) {
    return (
      <>
        <Section title={t`Allowed models`}>
          <p className="text-muted-foreground text-sm">
            <Trans>
              No model is chosen for your organization yet, so no model call can
              be made.
            </Trans>{" "}
            <WhereToChange canChange={canChange} />
          </p>
        </Section>
        <EngineSpend settings={settings} />
      </>
    );
  }
  return (
    <>
      <Section
        description={
          <>
            <Trans>
              Your organization chooses these with its own AI provider keys.
            </Trans>{" "}
            <WhereToChange canChange={canChange} />
          </>
        }
        title={t`Allowed models`}
      >
        <AllowedModels models={settings.models} />
      </Section>
      <Section title={t`Limits`}>
        <RunRequests />
      </Section>
      <EngineSpend settings={settings} />
    </>
  );
};

const Models = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  if (page.state !== "ready") {
    return (
      <SettingsSection title={t`Models`}>
        <NotLoadedState heading="h3" page={page} />
      </SettingsSection>
    );
  }
  return (
    <Settings
      canChange={isAdmin(identity.role) && !identity.staff}
      settings={page.data}
    />
  );
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
