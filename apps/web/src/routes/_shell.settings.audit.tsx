import type { AuditPage } from "@grasp-os/shared/audit-log";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import {
  LogExport,
  LogFilters,
  LogRecords,
  readLog,
} from "../activity/audit-log.tsx";
import { logSearchOf } from "../activity/log-search.ts";
import type { LogSearch } from "../activity/log-search.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  Tabs,
  TabsList,
  TabsContent,
  TabsTrigger,
} from "../grasp/tabs/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { ArchiveSearch, RetentionCard } from "../settings/audit-archive.tsx";
import { AuditChainCheck } from "../settings/audit-chain.tsx";
import { SectionNotLoaded, SettingsError } from "../settings/section.tsx";

// Settings → Audit trail, for admins, as in the prototype
// (`routes/settings/audit.tsx`): core's audit log, searched by its filters
// (in the address), page by page, each record in words, with its export
// and its chain check (settings/audit-chain.tsx). Core checks the role on
// every call; every search of the log is itself recorded in it.

/**
 * The records' key: their filters and the first page read, so the log read
 * again, with new filters or the same ones, starts from its own first page
 * and drops the older pages loaded under the last.
 */
/** The page's address: the log's filters, and the tab it shows. */
type AuditSearch = LogSearch & { view?: "integrity" };

const styles = stylex.create({
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space5,
    paddingBlockStart: grasp.space4,
  },
});

const logKey = (filters: LogSearch, { records, next }: AuditPage): string =>
  JSON.stringify([filters, records[0]?.seq ?? null, next]);

const AuditTrail = () => {
  const { t } = useLingui();
  const { log, last } = Route.useLoaderData();
  const { view, ...filters } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <Tabs
      onValueChange={(next) => {
        void navigate({
          to: "/settings/audit",
          search: (now) => ({
            ...now,
            view: next === "integrity" ? "integrity" : undefined,
          }),
        });
      }}
      value={view ?? "events"}
    >
      <TabsList aria-label={t`Audit trail`}>
        <TabsTrigger value="events">{t`Events`}</TabsTrigger>
        <TabsTrigger value="integrity">{t`Integrity`}</TabsTrigger>
      </TabsList>
      <TabsContent value="events">
        <div {...stylex.props(styles.panel)}>
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
            flush
            title={t`Who did what in Grasp, and when`}
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
        </div>
      </TabsContent>
      <TabsContent value="integrity">
        <div {...stylex.props(styles.panel)}>
          <AuditChainCheck last={last} />
          <RetentionCard />
        </div>
      </TabsContent>
    </Tabs>
  );
};

export const Route = createFileRoute("/_shell/settings/audit")({
  validateSearch: (search: Record<string, unknown>): AuditSearch => ({
    ...logSearchOf(search),
    ...(search.view === "integrity" ? { view: "integrity" as const } : {}),
  }),
  // The tab is no filter: switching it reads nothing again.
  loaderDeps: ({ search: { view: _tab, ...filters } }) => filters,
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
