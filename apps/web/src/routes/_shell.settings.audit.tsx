import type { AuditPage } from "@grasp-os/shared/audit-log";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import {
  LogExport,
  LogFilters,
  LogRecords,
  logSearchOf,
  readLog,
} from "../activity/audit-log.tsx";
import type { LogSearch } from "../activity/audit-log.tsx";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import {
  SettingsBody,
  SettingsLoading,
  SettingsSection,
} from "../settings/settings-parts.tsx";

// Settings → Audit trail, for admins, as in the prototype
// (`routes/settings/audit.tsx`): core's audit log, searched by its filters
// (in the address), page by page, each record in words, with its export
// and its chain check. Core checks the role on every call; every search
// of the log is itself recorded in it.

/**
 * The records' key: their filters and the first page read, so the log read
 * again, with new filters or the same ones, starts from its own first page
 * and drops the older pages loaded under the last.
 */
const logKey = (filters: LogSearch, { records, next }: AuditPage): string =>
  JSON.stringify([filters, records[0]?.seq ?? null, next]);

const AuditTrail = () => {
  const { t } = useLingui();
  const log = Route.useLoaderData();
  const filters = Route.useSearch();
  return (
    <SettingsSection
      action={<LogExport search={filters} />}
      description={t`Everything done in Grasp, by whom and when, kept in a chain nobody can change unseen.`}
      title={t`Audit trail`}
    >
      <SettingsBody>
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
          <NotLoadedState page={log} />
        )}
      </SettingsBody>
    </SettingsSection>
  );
};

export const Route = createFileRoute("/_shell/settings/audit")({
  validateSearch: (search: Record<string, unknown>): LogSearch =>
    logSearchOf(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { core }, deps }) =>
    await loadFromCore(core, async (session) => await readLog(session, deps)),
  pendingComponent: SettingsLoading,
  component: AuditTrail,
});
