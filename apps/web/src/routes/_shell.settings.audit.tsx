import type {
  AuditPage,
  AuditRecord,
  FullVerification,
} from "@grasp-os/shared/audit-log";
import { Card, CardContent } from "@grasp-os/ui/components/card";
import { SectionHeader } from "@grasp-os/ui/components/section-header";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute } from "@tanstack/react-router";
import { useId, useState } from "react";

import { EventDetails } from "../activity/audit-event.tsx";
import { LogBar, LogRecords, readLog } from "../activity/audit-log.tsx";
import { logSearchOf } from "../activity/log-search.ts";
import type { LogSearch } from "../activity/log-search.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { RetentionRows } from "../settings/audit-archive.tsx";
import {
  ChainBroken,
  endedOf,
  IntegrityDialog,
} from "../settings/audit-chain.tsx";
import { SettingsError } from "../settings/settings-parts.tsx";

// Settings › Audit trail, for admins: the events are the page. A broken
// hash chain shows above them (settings/audit-chain.tsx); otherwise only
// the events card stands under the page's title, with the integrity check,
// the archive and how long events are kept behind one quiet button in its
// head. Over the table, a search, Filters and Export (activity/
// audit-log.tsx); an event's details, in Damsko's Inspector, open in a
// Sheet (activity/audit-event.tsx). Core checks the role on every call;
// every search of the log is itself recorded in it.

const styles = stylex.create({
  // The events' title over their card, on the page's ground, a small step
  // above it, its words where the rows' start.
  group: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: space["2"],
    minWidth: 0,
  },
  head: { paddingInline: space.tableCellInline },
});

/**
 * The records' key: their filters and the first page read, so the log read
 * again, with new filters or the same ones, starts from its own first page
 * and drops the older pages loaded under the last.
 */
const logKey = (filters: LogSearch, { records, next }: AuditPage): string =>
  JSON.stringify([filters, records[0]?.seq ?? null, next]);

const AuditTrail = () => {
  const { log, last } = Route.useLoaderData();
  const filters = Route.useSearch();
  const [own, setOwn] = useState<FullVerification | null>(null);
  const [open, setOpen] = useState<AuditRecord>();
  // New filters close the details, so what they find is in view: their
  // own searches (their events, similar ones, what it was about) too.
  const searched = JSON.stringify(filters);
  const [openFor, setOpenFor] = useState(searched);
  if (openFor !== searched) {
    setOpenFor(searched);
    setOpen(undefined);
  }
  const directory = log.state === "ready" ? log.data.directory : undefined;
  const titleId = useId();
  return (
    <>
      <ChainBroken ended={endedOf(own, last)} />
      <section aria-labelledby={titleId} {...stylex.props(styles.group)}>
        <div {...stylex.props(styles.head)}>
          <SectionHeader
            actions={
              <IntegrityDialog last={last} onChecked={setOwn} own={own}>
                <RetentionRows />
              </IntegrityDialog>
            }
            id={titleId}
            title={
              filters.archive === true ? (
                <Trans>Archived events</Trans>
              ) : (
                <Trans>Events</Trans>
              )
            }
            variant="group"
          />
        </div>
        <Card size="sm">
          <CardContent flush>
            {log.state === "ready" ? (
              <>
                {/* The bar starts again from new filters. */}
                <LogBar
                  directory={log.data.directory}
                  key={JSON.stringify(filters)}
                  search={filters}
                />
                <LogRecords
                  directory={log.data.directory}
                  first={log.data.page}
                  key={logKey(filters, log.data.page)}
                  onDetails={setOpen}
                  open={open?.seq}
                  search={filters}
                />
              </>
            ) : (
              <NotLoadedState heading="h3" page={log} />
            )}
          </CardContent>
        </Card>
      </section>
      {open === undefined || directory === undefined ? null : (
        <EventDetails
          archive={filters.archive === true}
          directory={directory}
          key={open.seq}
          onClose={() => {
            setOpen(undefined);
          }}
          record={open}
        />
      )}
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
