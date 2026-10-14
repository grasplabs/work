import type { UnknownOutcomeListing } from "@grasp-os/shared/connect";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { readPeople } from "../directory.ts";
import { formatDateTime } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import {
  SettingsError,
  SettingsLoading,
  SettingsSection,
} from "../settings/settings-parts.tsx";

// Settings → Unknown outcomes, for the organization's own admins: every
// person's open calls of unknown outcome, changes Grasp sent for them
// whose answer was lost, so an admin can follow up with each person. Read
// only: only the person a call acted for says what became of it, on their
// dashboard, and only they see what was sent (core's unknown-outcomes.ts
// lists these without it). Core checks the role on every read.

interface Outcomes {
  listed: UnknownOutcomeListing[];
  people: ReadonlyMap<string, string>;
}

const OutcomeRows = ({ outcomes }: { outcomes: Outcomes }) => {
  const { listed, people } = outcomes;
  if (listed.length === 0) {
    return (
      <p className="text-muted-foreground border-t px-5 py-4">
        <Trans>No call of unknown outcome is open.</Trans>
      </p>
    );
  }
  return (
    <div className="border-t">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <Trans>Person</Trans>
            </TableHead>
            <TableHead>
              <Trans>Change</Trans>
            </TableHead>
            <TableHead>
              <Trans>Connection</Trans>
            </TableHead>
            <TableHead>
              <Trans>Sent</Trans>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {listed.map((outcome) => (
            <TableRow key={outcome.id}>
              <TableCell>
                {people.get(outcome.onBehalfOf) ?? outcome.onBehalfOf}
              </TableCell>
              <TableCell>
                <span className="flex flex-col">
                  <span>{outcome.title ?? outcome.action}</span>
                  {outcome.title === undefined ? null : (
                    <span className="text-muted-foreground text-xs">
                      {outcome.action}
                    </span>
                  )}
                </span>
              </TableCell>
              <TableCell>
                <span className="flex flex-col">
                  <span>{outcome.connectionName ?? outcome.connectionId}</span>
                  {outcome.resource === null ? null : (
                    <span className="text-muted-foreground text-xs">
                      {outcome.resource}
                    </span>
                  )}
                </span>
              </TableCell>
              <TableCell>
                <time dateTime={outcome.sentAt}>
                  {formatDateTime(outcome.sentAt)}
                </time>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

const UnknownOutcomes = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  return (
    <SettingsSection
      description={
        <Trans>
          Changes Grasp sent for someone whose answer was lost, so nobody can
          tell whether they took effect. Only that person can say what happened,
          on their dashboard; follow up with them.
        </Trans>
      }
      title={t`Unknown outcomes`}
    >
      {page.state === "ready" ? (
        <OutcomeRows outcomes={page.data} />
      ) : (
        <div className="border-t">
          <NotLoadedState heading="h3" page={page} />
        </div>
      )}
    </SettingsSection>
  );
};

export const Route = createFileRoute("/_shell/settings/outcomes")({
  // Only the organization's own admins list everyone's: anyone else who
  // follows a link here goes to their own settings. Core refuses them all
  // the same; this only spares them a refusal.
  beforeLoad: ({ context: { identity } }) => {
    if (!isMemberAdmin(identity)) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/settings/profile", replace: true });
    }
  },
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: UnknownOutcomes,
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session): Promise<Outcomes> => {
      const [listed, people] = await Promise.all([
        session.unknownOutcomes.listAll(),
        readPeople(session),
      ]);
      return { listed, people };
    }),
});
