import type { AuditPage, AuditRetention } from "@grasp-os/shared/audit-log";
import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import type { KeyValueItem } from "@grasp-os/ui/components/key-value";
import {
  CodeIcon,
  DownloadIcon,
  Icon,
  SheetIcon,
} from "@grasp-os/ui/lib/icons";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";

import {
  auditFilterOf,
  exportHref,
  LogRecords,
} from "../activity/audit-log.tsx";
import type { LogSearch } from "../activity/log-search.ts";
import type { Directory } from "../directory.ts";
import { loadFromCore, notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { Failure, SettingsGroup } from "./section.tsx";

// Settings › Audit trail, beside the log: how long Grasp keeps what it
// records (`audit.retention`), as name and value in the Integrity dialog,
// one list with the chain's last check; and the events retention moved out
// of the log into its archive, searched with the page's own filters
// (`audit.searchArchive`), a stretch of the archive per page. The log's
// search finds only what the log still holds, so without this an archived
// event could only be found by verifying the chain. Core keeps both to
// admins, and records each search of the archive as a search.

/** How long Grasp keeps events and run details, as core answered: a list of facts. */
export const RetentionView = ({
  retention,
}: {
  /** Undefined while it is read. */
  retention: Loaded<AuditRetention> | undefined;
}) => {
  const { t, i18n } = useLingui();
  const dayCount = (days: number): string =>
    t({
      message: plural(days, { one: "# day", other: "# days" }),
      context: "how long something is kept",
    });
  if (retention !== undefined && retention.state !== "ready") {
    return <Failure>{notLoadedText(retention, i18n)}</Failure>;
  }
  const kept = retention?.data;
  // While it is read, each value waits at its own width.
  const fact = (
    id: string,
    label: string,
    days: number | undefined
  ): KeyValueItem =>
    days === undefined
      ? { id, label, value: "", loading: true }
      : { id, label, value: dayCount(days) };
  return (
    <KeyValueList
      items={[
        fact("log", t`Events in the log`, kept?.auditDays),
        fact("archive", t`Events in the archive`, kept?.archiveDays),
        fact("runs", t`Workflow run details`, kept?.runDays),
      ]}
      orientation="horizontal"
    />
  );
};

/** Retention, for an admin on Settings › Audit trail, read as the dialog shows. */
export const RetentionRows = () => {
  const core = useCore();
  const [retention, setRetention] = useState<Loaded<AuditRetention>>();
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      const loaded = await loadFromCore(
        core,
        async (session) => await session.audit.retention(),
        left.signal
      );
      if (!left.signal.aborted) {
        setRetention(loaded);
      }
    };
    void read();
    return () => {
      left.abort();
    };
  }, [core]);
  return <RetentionView retention={retention} />;
};

/**
 * The audit trail with its archive, as one download in the chain's order,
 * filtered as shown: core records the export, checks the session as it
 * reads, and names in JSON what archive retention already purged.
 */
const ArchiveExport = ({ search }: { search: LogSearch }) => {
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="outline">
          <Icon icon={DownloadIcon} />
          {t`Export with archive`}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          icon={SheetIcon}
          onSelect={() => {
            // Core sends it as a file to save: the page stays.
            window.location.assign(exportHref(search, "csv", true));
          }}
        >
          {t`Export CSV`}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={CodeIcon}
          onSelect={() => {
            window.location.assign(exportHref(search, "json", true));
          }}
        >
          {t`Export JSON`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/**
 * Archived events that match the page's filters, once asked for. Keyed by
 * the page's filters, so new filters ask the archive afresh.
 */
export const ArchivedEvents = ({
  search,
  directory,
}: {
  search: LogSearch;
  directory: Directory;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [first, setFirst] = useState<AuditPage>();
  const open = async (): Promise<void> => {
    const page = await run(
      async ({ audit }) => await audit.searchArchive(auditFilterOf(search))
    );
    if (page !== undefined) {
      setFirst(page);
    }
  };
  return (
    <SettingsGroup
      actions={
        <>
          {first === undefined ? (
            <Button
              disabled={busy}
              onClick={() => {
                void open();
              }}
              size="xs"
              variant="outline"
            >
              {t`Search the archive`}
            </Button>
          ) : null}
          <ArchiveExport search={search} />
        </>
      }
      description={t`Events older than the audit trail keeps, moved to the archive. The search and the export use the filters above.`}
      flush={failure === undefined}
      title={t`Archived events`}
    >
      {failure === undefined ? null : <Failure>{failure}</Failure>}
      {failure !== undefined || first === undefined ? null : (
        <LogRecords
          archive
          directory={directory}
          first={first}
          search={search}
        />
      )}
    </SettingsGroup>
  );
};
