import type { UnknownOutcomeListing } from "@grasp-os/shared/connect";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import { DataTable } from "@grasp-os/ui/components/data-table";
import type { DataTableColumn } from "@grasp-os/ui/components/data-table";
import { Text } from "@grasp-os/ui/components/text";
import { font } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { readPeople } from "../directory.ts";
import { formatDateTime } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { PageSkeletonSettings } from "../frame/skeletons/settings.tsx";
import { loadEveryPage } from "../inbox/outcome-pages.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { SettingsError, SettingsGroup } from "../settings/section.tsx";

// Settings → Unknown outcomes, for the organization's own admins: every
// person's open calls of unknown outcome, changes Grasp sent for them
// whose answer was lost, so an admin can follow up with each person. Read
// only: only the person a call acted for says what became of it, in their
// inbox, and only they see what was sent (core's unknown-outcomes.ts
// lists these without it). Each shows its receipt, the effect key's hash
// the audit log's events of the call and of its resolution carry, so the
// trail of each is found in an export. Core checks the role on every read.

interface Outcomes {
  listed: UnknownOutcomeListing[];
  people: ReadonlyMap<string, string>;
}

const styles = stylex.create({
  // A cell's main words, and a quieter line under them.
  lines: { display: "grid", minWidth: 0 },
  receipt: {
    fontFamily: font.mono,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    overflowWrap: "anywhere",
  },
});

/** A cell's words, with a quieter line under them where there is one. */
const Lines = ({ main, under }: { main: string; under?: string | null }) => (
  <span {...stylex.props(styles.lines)}>
    <span>{main}</span>
    {under === undefined || under === null ? null : (
      <Text as="span" color="muted" size="xs">
        {under}
      </Text>
    )}
  </span>
);

/** The calls' columns: who, what, through which connection, when, and the receipt. */
const outcomeColumns = (
  words: {
    person: string;
    change: string;
    connection: string;
    sent: string;
    receipt: string;
  },
  personOf: (outcome: UnknownOutcomeListing) => string
): DataTableColumn<UnknownOutcomeListing>[] => [
  { id: "person", header: words.person, value: personOf },
  {
    id: "change",
    header: words.change,
    value: (outcome) => outcome.title ?? outcome.action,
    cell: (outcome) =>
      outcome.title === undefined ? (
        outcome.action
      ) : (
        <Lines main={outcome.title} under={outcome.action} />
      ),
  },
  {
    id: "connection",
    header: words.connection,
    value: (outcome) => outcome.connectionName ?? outcome.connectionId,
    cell: (outcome) => (
      <Lines
        main={outcome.connectionName ?? outcome.connectionId}
        under={outcome.resource}
      />
    ),
  },
  {
    id: "sent",
    header: words.sent,
    value: (outcome) => outcome.sentAt,
    cell: (outcome) => (
      <time dateTime={outcome.sentAt}>{formatDateTime(outcome.sentAt)}</time>
    ),
  },
  {
    id: "receipt",
    header: words.receipt,
    value: (outcome) => outcome.effectKeyHash,
    cell: (outcome) => (
      <code {...stylex.props(styles.receipt)}>{outcome.effectKeyHash}</code>
    ),
  },
];

/** The open calls of unknown outcome, one row each. */
const OutcomeRows = ({ outcomes }: { outcomes: Outcomes }) => {
  const { t } = useLingui();
  const { listed, people } = outcomes;
  const columns = outcomeColumns(
    {
      person: t`Person`,
      change: t`Change`,
      connection: t`Connection`,
      sent: t`Sent`,
      receipt: t`Receipt`,
    },
    (outcome) => people.get(outcome.onBehalfOf) ?? outcome.onBehalfOf
  );
  return (
    <DataTable
      aria-label={t`Unknown outcomes`}
      columns={columns}
      emptyState={{
        title: t`No call of unknown outcome is open.`,
        description: t`Each one sent for someone shows here until they say what became of it.`,
      }}
      getRowId={(outcome) => outcome.id}
      rows={listed}
      searchable={false}
    />
  );
};

const UnknownOutcomes = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  return (
    <SettingsGroup
      description={t`Changes Grasp sent for someone whose answer was lost, so nobody can tell whether they took effect. Only that person can say what happened, in their inbox; follow up with them.`}
      flush={page.state === "ready"}
      title={t`Calls`}
    >
      {page.state === "ready" ? (
        <OutcomeRows outcomes={page.data} />
      ) : (
        <NotLoadedState heading="h3" page={page} />
      )}
    </SettingsGroup>
  );
};

/** The calls' card while they are read. */
const OutcomesPending = () => (
  <PageSkeletonSettings help={false} sections={[3]} />
);

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
  pendingComponent: OutcomesPending,
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
