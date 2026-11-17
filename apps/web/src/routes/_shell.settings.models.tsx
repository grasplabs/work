import type { ModelSettings } from "@grasp-os/shared/models";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import { Trans, useLingui } from "@lingui/react/macro";
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
import {
  FactRow,
  SectionNotLoaded,
  SettingsError,
  SettingsLoading,
  SettingsRows,
} from "../settings/section.tsx";

// Models, for admins: the models the organization's calls may use. They
// are the organization's own choice, made with its AI provider keys in
// Settings › AI providers, so the page only shows them and points there:
// its own admins get the link, anyone else (Grasp staff, who read but
// never change whose key pays) who to ask; core checks the role. Beside
// them, the one limit every run has (`platformLimits.lineageModelRequests`,
// which core holds a run to). What each App's model and all calls spent
// is AI spend's (`_shell.settings.spend.tsx`). Nothing here limits spend:
// the organization pays its providers on its own keys.

/** Where the models are changed: Settings › AI providers, for the organization's own admins; anyone else asks them. */
const WhereToChange = ({ canChange }: { canChange: boolean }) =>
  canChange ? (
    <Trans>
      To change them, go to{" "}
      <RouterLink to="/settings/ai-providers">
        Settings › AI providers
      </RouterLink>
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
  const requests = platformLimits.lineageModelRequests;
  if (settings.models.length === 0) {
    return (
      <SectionCard title={t`Allowed models`}>
        <Text tone="muted">
          <Trans>
            No model is chosen for your organization yet, so no model call can
            be made.
          </Trans>{" "}
          <WhereToChange canChange={canChange} />
        </Text>
      </SectionCard>
    );
  }
  return (
    <>
      <SectionCard
        description={
          <>
            {t`Your organization chooses these with its own AI provider keys.`}{" "}
            <WhereToChange canChange={canChange} />
          </>
        }
        flush
        title={t`Allowed models`}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t`Model`}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {settings.models.map((model) => (
              <TableRow key={model}>
                <TableCell wrap>{model}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SectionCard>
      <SectionCard flush title={t`Limits`}>
        <SettingsRows>
          <FactRow
            help={t`With the runs it starts, retries included.`}
            label={t`Each workflow run`}
          >
            {t`At most ${requests} model requests`}
          </FactRow>
        </SettingsRows>
      </SectionCard>
    </>
  );
};

const Models = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  if (page.state !== "ready") {
    return (
      <SectionCard title={t`Models`}>
        <SectionNotLoaded page={page} />
      </SectionCard>
    );
  }
  return <Settings canChange={isMemberAdmin(identity)} settings={page.data} />;
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
