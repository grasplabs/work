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
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { readPeople } from "../directory.ts";
import { formatDateTime } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadEveryPage } from "../inbox/outcome-pages.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import {
  SettingsError,
  SettingsGroup,
  SettingsPending,
} from "../settings/section.tsx";

// Settings › Unknown outcomes, for the organization's own admins: every
// person's open calls of unknown outcome, changes Grasp sent for them
// whose answer was lost, so an admin can follow up with each person. Read
// only: only the person a call acted for says what became of it, in their
// inbox, and only they see what was sent (core's unknown-outcomes.ts
// lists these without it). Each shows its receipt, the effect key's hash
// the audit log's events of the call and of its resolution carry, so the
// trail of each is found in an export. Core checks the role on every read.

const styles = stylex.create({
  two: { display: "grid", gap: space[1] },
  none: { paddingBlock: space[4], paddingInline: space.tableCellInline },
});

interface Outcomes {
  listed: UnknownOutcomeListing[];
  people: ReadonlyMap<string, string>;
}

const OutcomeRows = ({ outcomes }: { outcomes: Outcomes }) => {
  const { t } = useLingui();
  const { listed, people } = outcomes;
  if (listed.length === 0) {
    return (
      <div {...stylex.props(styles.none)}>
        <Text color="muted" size="sm">
          {t`No call of unknown outcome is open.`}
        </Text>
      </div>
    );
  }
  return (
    <Table aria-label={t`Unknown outcomes`}>
      <TableHeader>
        <TableRow>
          <TableHead>{t`Person`}</TableHead>
          <TableHead>{t`Change`}</TableHead>
          <TableHead>{t`Connection`}</TableHead>
          <TableHead>{t`Sent`}</TableHead>
          <TableHead>{t`Receipt`}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {listed.map((outcome) => (
          <TableRow key={outcome.id}>
            <TableCell>
              {people.get(outcome.onBehalfOf) ?? outcome.onBehalfOf}
            </TableCell>
            <TableCell>
              <span {...stylex.props(styles.two)}>
                <span>{outcome.title ?? outcome.action}</span>
                {outcome.title === undefined ? null : (
                  <Text as="span" color="muted" size="xs">
                    {outcome.action}
                  </Text>
                )}
              </span>
            </TableCell>
            <TableCell>
              <span {...stylex.props(styles.two)}>
                <span>{outcome.connectionName ?? outcome.connectionId}</span>
                {outcome.resource === null ? null : (
                  <Text as="span" color="muted" size="xs">
                    {outcome.resource}
                  </Text>
                )}
              </span>
            </TableCell>
            <TableCell>
              <time dateTime={outcome.sentAt}>
                {formatDateTime(outcome.sentAt)}
              </time>
            </TableCell>
            <TableCell>
              <Text as="span" color="muted" size="xs" wrap="anywhere">
                <code>{outcome.effectKeyHash}</code>
              </Text>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

const UnknownOutcomes = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  return (
    <SettingsGroup
      description={t`Changes Grasp sent for someone whose answer was lost, so nobody can tell whether they took effect. Only that person can say what happened, in their inbox; follow up with them.`}
      flush={page.state === "ready"}
      title={t`Calls of unknown outcome`}
    >
      {page.state === "ready" ? (
        <OutcomeRows outcomes={page.data} />
      ) : (
        <NotLoadedState heading="h3" page={page} />
      )}
    </SettingsGroup>
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
  pendingComponent: () => <SettingsPending groups={[3]} />,
  errorComponent: SettingsError,
  component: UnknownOutcomes,
  loader: async ({
    abortController,
    context: { core },
  }): Promise<Loaded<Outcomes>> => {
    // Each page of the listing within its own few seconds, and no more
    // pages once the page is left.
    const left = abortController.signal;
    const [listed, people] = await Promise.all([
      loadEveryPage(
        core,
        async (session, before) =>
          await session.unknownOutcomes.listAll(before),
        left
      ),
      loadFromCore(core, readPeople, left),
    ]);
    if (listed.state !== "ready") {
      return listed;
    }
    if (people.state !== "ready") {
      return people;
    }
    return {
      state: "ready",
      data: { listed: listed.data, people: people.data },
    };
  },
});
