import type { AuditPage, AuditRetention } from "@grasp-os/shared/audit-log";
import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { BracesIcon, DownloadIcon, SheetIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  auditFilterOf,
  exportHref,
  LogRecords,
} from "../activity/audit-log.tsx";
import type { LogSearch } from "../activity/audit-log.tsx";
import type { Directory } from "../directory.ts";
import { ErrorText } from "../error-text.tsx";
import { LoadingLines } from "../frame/page-states.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import {
  SettingsBody,
  SettingsRow,
  SettingsSection,
} from "./settings-parts.tsx";

// Settings › Audit trail, below the log: how long the deployment keeps
// what it records (`audit.retention`), and the events retention moved out
// of the log into its archive, searched with the page's own filters
// (`audit.searchArchive`), a stretch of the archive per page. The log's
// search finds only what the log still holds, so without this an archived
// event could only be found by verifying the chain. Core keeps both to
// admins, and records each search of the archive as a search.

/** A number of days, or why there is none. */
const Days = ({ days }: { days: number | null }) =>
  days === null ? (
    <span className="text-destructive">
      <Trans>Not set correctly</Trans>
    </span>
  ) : (
    <Plural one="# day" other="# days" value={days} />
  );

/** How long the deployment keeps events and run details, as core answered. */
export const RetentionView = ({
  retention,
}: {
  /** Undefined while it is read. */
  retention: Loaded<AuditRetention> | undefined;
}) => {
  const { t } = useLingui();
  if (retention === undefined || retention.state !== "ready") {
    return (
      <SettingsSection title={t`Retention`}>
        <SettingsBody>
          {retention === undefined ? (
            <LoadingLines lines={3} />
          ) : (
            <NotLoaded page={retention} />
          )}
        </SettingsBody>
      </SettingsSection>
    );
  }
  const { auditDays, archiveDays, runDays } = retention.data;
  const invalid = [auditDays, archiveDays, runDays].includes(null);
  return (
    <SettingsSection
      description={t`How long Grasp keeps what it records, as your deployment is set up. Grasp sets this with you.`}
      title={t`Retention`}
    >
      <SettingsRow
        description={t`Searched above. After this, events move to the archive.`}
        label={t`Audit trail`}
      >
        <Days days={auditDays} />
      </SettingsRow>
      <SettingsRow
        description={t`From when each event was recorded, archive included. After this, archived events are deleted.`}
        label={t({
          message: "Archive",
          context: "where retention keeps older audit events",
        })}
      >
        <Days days={archiveDays} />
      </SettingsRow>
      <SettingsRow
        description={t`After a run ends. After this, its inputs, outputs and messages are removed.`}
        label={t`Workflow run details`}
      >
        <Days days={runDays} />
      </SettingsRow>
      {invalid ? (
        <p className="text-muted-foreground border-t px-5 py-4">
          <Trans>
            Where a period isn’t set correctly, nothing is moved or removed on
            its account until Grasp corrects it.
          </Trans>
        </p>
      ) : null}
    </SettingsSection>
  );
};

/**
 * The audit trail with its archive, as one download in the chain's order,
 * filtered as shown: core records the export, checks the session as it
 * reads, and names in JSON what archive retention already purged.
 */
const ArchiveExport = ({ search }: { search: LogSearch }) => (
  <DropdownMenu>
    <DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>
      <DownloadIcon data-icon="inline-start" />
      <Trans>Export with archive</Trans>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-44">
      <DropdownMenuItem
        onClick={() => {
          // Core sends it as a file to save: the page stays.
          window.location.assign(exportHref(search, "csv", true));
        }}
      >
        <SheetIcon />
        <Trans>Export CSV</Trans>
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => {
          window.location.assign(exportHref(search, "json", true));
        }}
      >
        <BracesIcon />
        <Trans>Export JSON</Trans>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);

/** Archived events that match the page's filters, once asked for. */
const ArchivedEvents = ({
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
    <SettingsSection
      action={
        <div className="flex flex-wrap gap-2">
          {first === undefined ? (
            <Button
              disabled={busy}
              onClick={() => {
                void open();
              }}
              size="sm"
              variant="outline"
            >
              <Trans>Search the archive</Trans>
            </Button>
          ) : null}
          <ArchiveExport search={search} />
        </div>
      }
      description={t`Events older than the audit trail keeps, moved to the archive. The search and the export use the filters above.`}
      title={t`Archived events`}
    >
      {failure === undefined ? null : (
        <div className="border-t px-5 py-3">
          <ErrorText>{failure}</ErrorText>
        </div>
      )}
      {first === undefined ? null : (
        <LogRecords
          archive
          directory={directory}
          first={first}
          search={search}
        />
      )}
    </SettingsSection>
  );
};

/**
 * Retention and the archive, for an admin on Settings › Audit trail.
 * Keyed by the page's filters, so new filters ask the archive afresh.
 */
export const AuditArchive = ({
  search,
  directory,
}: {
  search: LogSearch;
  directory: Directory;
}) => {
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
  return (
    <>
      <ArchivedEvents directory={directory} search={search} />
      <RetentionView retention={retention} />
    </>
  );
};
