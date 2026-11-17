import type { AuditPage } from "@grasp-os/shared/audit-log";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import {
  LogExport,
  LogFilters,
  LogRecords,
  readLog,
} from "../activity/audit-log.tsx";
import { logSearchOf } from "../activity/log-search.ts";
import type { LogSearch } from "../activity/log-search.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { ArchiveSearch, RetentionRows } from "../settings/audit-archive.tsx";
import { AuditChainCheck } from "../settings/audit-chain.tsx";
import { SectionNotLoaded, SettingsError } from "../settings/section.tsx";

// Settings › Audit trail, for admins: whether core's audit log is whole
// and how long it keeps what it records (settings/audit-chain.tsx,
// settings/audit-archive.tsx), then the log itself, searched by its filters
// (in the address), page by page, each record in words, with its export
// and its archive. One page of cards, no tabs. Core checks the role on
// every call; every search of the log is itself recorded in it.

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
  return (
    <>
      <AuditChainCheck last={last}>
        <RetentionRows />
      </AuditChainCheck>
      <SectionCard
        actions={
          <>
            {log.state === "ready" ? (
              <ArchiveSearch
                directory={log.data.directory}
                key={JSON.stringify(filters)}
                search={filters}
              />
            ) : null}
            <LogExport search={filters} />
          </>
        }
        density="compact"
        description={t`Who did what in Grasp, and when.`}
        flush
        title={t`Events`}
      >
        {/* Filters and records start again from new filters. */}
        <LogFilters key={JSON.stringify(filters)} search={filters} />
        {log.state === "ready" ? (
          <LogRecords
            directory={log.data.directory}
            first={log.data.page}
            key={logKey(filters, log.data.page)}
            search={filters}
          />
        ) : (
          <SectionNotLoaded page={log} />
        )}
      </SectionCard>
    </>
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
