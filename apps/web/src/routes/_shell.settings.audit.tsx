import type { AuditPage, FullVerification } from "@grasp-os/shared/audit-log";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import {
  LogExport,
  LogFilters,
  LogRecords,
  readLog,
} from "../activity/audit-log.tsx";
import { logSearchOf } from "../activity/log-search.ts";
import type { LogSearch } from "../activity/log-search.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { ArchivedEvents, RetentionRows } from "../settings/audit-archive.tsx";
import {
  ChainBroken,
  endedOf,
  IntegrityDialog,
} from "../settings/audit-chain.tsx";
import {
  SettingsError,
  SettingsGroup,
  SettingsStack,
} from "../settings/section.tsx";

// Settings › Audit trail, for admins: the events are the page. A broken
// hash chain shows above them (settings/audit-chain.tsx); otherwise the
// events card stands under the page's title, with the integrity check and
// how long events are kept behind one quiet button in its head, and the
// export beside it. Over the records, the filters (activity/audit-log.tsx,
// which the log's own pages share), in the address; under them the
// archive, searched with the same filters (settings/audit-archive.tsx).
// Core checks the role on every call; every search of the log is itself
// recorded in it.

const styles = stylex.create({
  // The filters in the rows' inset, over the records.
  filters: { padding: space[4] },
});

/**
 * The records' key: their filters and the first page read, so the log read
 * again, with new filters or the same ones, starts from its own first page
 * and drops the older pages loaded under the last.
 */
const logKey = (filters: LogSearch, { records, next }: AuditPage): string =>
  JSON.stringify([filters, records[0]?.seq ?? null, next]);

const AuditTrail = () => {
  const { t } = useLingui();
  const { log, last } = Route.useLoaderData();
  const filters = Route.useSearch();
  const [own, setOwn] = useState<FullVerification | null>(null);
  return (
    <SettingsStack>
      <ChainBroken ended={endedOf(own, last)} />
      <SettingsGroup
        actions={
          <>
            <IntegrityDialog last={last} onChecked={setOwn} own={own}>
              <RetentionRows />
            </IntegrityDialog>
            <LogExport search={filters} />
          </>
        }
        title={t`Events`}
      >
        {/* Filters and records start again from new filters. */}
        <div {...stylex.props(styles.filters)}>
          <LogFilters key={JSON.stringify(filters)} search={filters} />
        </div>
        {log.state === "ready" ? (
          <LogRecords
            directory={log.data.directory}
            first={log.data.page}
            key={logKey(filters, log.data.page)}
            search={filters}
          />
        ) : (
          <NotLoadedState heading="h3" page={log} />
        )}
      </SettingsGroup>
      {log.state === "ready" ? (
        <ArchivedEvents
          directory={log.data.directory}
          key={JSON.stringify(filters)}
          search={filters}
        />
      ) : null}
    </SettingsStack>
  );
};

export const Route = createFileRoute("/_shell/settings/audit")({
  validateSearch: (search: Record<string, unknown>): LogSearch =>
    logSearchOf(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { core }, deps }) => {
    const [log, last] = await Promise.all([
      loadFromCore(core, async (session) => await readLog(session, deps)),
      loadFromCore(
        core,
        async (session) => await session.audit.lastVerification()
      ),
    ]);
    return { log, last };
  },
  errorComponent: SettingsError,
  component: AuditTrail,
});
