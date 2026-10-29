import type {
  ErasureRecord,
  ErasureRecordsPage,
} from "@grasp-os/shared/members";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { ErasureAreas } from "../settings/erasures.tsx";
import {
  SettingsError,
  SettingsLoading,
  SettingsSection,
} from "../settings/settings-parts.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Erasures, for Grasp's staff alone (GRA-903, GRA-1195; Nick's D4: staff
// view, never act): every erasure the client's admins asked for, by the
// person's ID and the name frozen when it was asked for, who asked and
// how far each area got. Nothing here changes anything, and core puts
// each visit on the audit log as the staff member's before it answers.

/** One erasure, as staff see it. */
const ErasureEntry = ({ record }: { record: ErasureRecord }) => {
  const asked = formatDateTime(record.requestedAt);
  const by = record.requestedBy.name;
  return (
    <div className="flex flex-col gap-3 border-t px-5 py-4">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{record.name}</span>
          <span className="text-muted-foreground truncate">
            <Trans>
              {record.userId} · asked by {by} on {asked}
            </Trans>
          </span>
        </div>
        {record.completedAt === null ? (
          <Badge variant="outline">
            <Trans>In progress</Trans>
          </Badge>
        ) : (
          <Badge variant="secondary">
            <Trans>Erased</Trans>
          </Badge>
        )}
      </div>
      <ErasureAreas areas={record.areas} />
    </div>
  );
};

/** Every erasure: the latest page first, older ones on request. */
const ErasureList = ({ page }: { page: ErasureRecordsPage }) => {
  const { busy, failure, run } = useCoreAction();
  const [older, setOlder] = useState<ErasureRecord[]>([]);
  const [more, setMore] = useState(page.more);
  const records = [...page.records, ...older];
  const showMore = async (): Promise<void> => {
    const last = records.at(-1);
    const next = await run(
      async (session) =>
        await session.members.erasures(
          last === undefined
            ? undefined
            : { at: last.requestedAt, userId: last.userId }
        )
    );
    if (next !== undefined) {
      setOlder([...older, ...next.records]);
      setMore(next.more);
    }
  };
  return (
    <>
      {records.length === 0 ? (
        <p className="text-muted-foreground border-t px-5 py-6 text-center">
          <Trans>Nobody was erased.</Trans>
        </p>
      ) : null}
      {records.map((record) => (
        <ErasureEntry key={record.userId} record={record} />
      ))}
      {more ? (
        <div className="flex flex-col items-center gap-2 border-t px-5 py-3">
          <Button
            disabled={busy}
            onClick={() => {
              void showMore();
            }}
            size="sm"
            variant="ghost"
          >
            <Trans>Show older</Trans>
          </Button>
          <ErrorText>{failure}</ErrorText>
        </div>
      ) : null}
    </>
  );
};

const Erasures = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const description = t`Where each erasure the client’s admins asked for stands. Only they erase; each visit here is on their audit trail.`;
  if (page.state !== "ready") {
    return (
      <SettingsSection description={description} title={t`Erasures`}>
        <NotLoadedState heading="h3" page={page} />
      </SettingsSection>
    );
  }
  return (
    <SettingsSection description={description} title={t`Erasures`}>
      <ErasureList page={page.data} />
    </SettingsSection>
  );
};

export const Route = createFileRoute("/_shell/settings/erasures")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: Erasures,
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await session.members.erasures()
    ),
});
