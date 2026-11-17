import type { UnknownOutcomeListing } from "@grasp-os/shared/connect";
import { useLingui } from "@lingui/react/macro";

import type { CoreConnection } from "../core-connection.ts";
import { loadEveryPage } from "../dashboard/outcome-pages.ts";
import { readPeople } from "../directory.ts";
import { formatDateTime } from "../format.ts";
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
import { FactValue, SectionNotLoaded } from "./section.tsx";

// Settings › Unknown outcomes, for the organization's own
// admins: every person's open calls of unknown outcome, changes Grasp sent
// for them whose answer was lost, so an admin can follow up with each
// person. Read only: only the person a call acted for says what became of
// it, on their dashboard, and only they see what was sent (core's
// unknown-outcomes.ts lists these without it). Each shows its receipt, the
// effect key's hash the audit log's events of the call and of its
// resolution carry, so the trail of each is found in an export. Core
// checks the role on every read.

export interface Outcomes {
  listed: UnknownOutcomeListing[];
  people: ReadonlyMap<string, string>;
}

/** Every open call of unknown outcome, each page within its own few seconds, none after `left`. */
export const readOutcomes = async (
  core: Pick<CoreConnection, "withSession">,
  left: AbortSignal
): Promise<Loaded<Outcomes>> => {
  const [listed, people] = await Promise.all([
    loadEveryPage(
      core,
      async (session, before) => await session.unknownOutcomes.listAll(before),
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
  return { state: "ready", data: { listed: listed.data, people: people.data } };
};

const OutcomeRows = ({ outcomes }: { outcomes: Outcomes }) => {
  const { t } = useLingui();
  const { listed, people } = outcomes;
  return (
    <Table>
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
            <TableCell wrap>
              {outcome.title === undefined ? (
                outcome.action
              ) : (
                <FactValue note={outcome.action}>{outcome.title}</FactValue>
              )}
            </TableCell>
            <TableCell wrap>
              {outcome.resource === null ? (
                (outcome.connectionName ?? outcome.connectionId)
              ) : (
                <FactValue note={outcome.resource}>
                  {outcome.connectionName ?? outcome.connectionId}
                </FactValue>
              )}
            </TableCell>
            <TableCell>
              <time dateTime={outcome.sentAt}>
                {formatDateTime(outcome.sentAt)}
              </time>
            </TableCell>
            <TableCell wrap>
              <code>{outcome.effectKeyHash}</code>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

/** The open calls of unknown outcome, as read. */
export const UnknownOutcomes = ({ page }: { page: Loaded<Outcomes> }) => {
  const { t } = useLingui();
  const rows = page.state === "ready" && page.data.listed.length > 0;
  return (
    <SectionCard
      description={t`Changes Grasp sent for someone whose answer was lost, so nobody can tell whether they took effect. Only that person can say what happened, on their dashboard; follow up with them.`}
      flush={rows}
      title={t`Unknown outcomes`}
    >
      {page.state === "ready" ? null : <SectionNotLoaded page={page} />}
      {page.state === "ready" && rows ? (
        <OutcomeRows outcomes={page.data} />
      ) : null}
      {page.state === "ready" && !rows ? (
        <Text tone="muted">{t`No call of unknown outcome is open.`}</Text>
      ) : null}
    </SectionCard>
  );
};
