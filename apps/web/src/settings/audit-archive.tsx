import type { AuditPage, AuditRetention } from "@grasp-os/shared/audit-log";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";

import { auditFilterOf, LogRecords } from "../activity/audit-log.tsx";
import type { LogSearch } from "../activity/log-search.ts";
import type { Directory } from "../directory.ts";
import { Alert } from "../grasp/alert/index.ts";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogPanel,
  DialogTitle,
  DialogTrigger,
} from "../grasp/dialog/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import {
  FactRow,
  LoadingLines,
  SectionNotLoaded,
  SettingsRows,
} from "./section.tsx";

// Settings › Audit trail: how long Grasp keeps what it records
// (`audit.retention`), as facts in a card, and the events retention moved
// out of the log into its archive, searched in a Dialog with the page's own
// filters (`audit.searchArchive`), 25 a page. The log's
// search finds only what the log still holds, so without this an archived
// event could only be found by verifying the chain. Core keeps both to
// admins, and records each search of the archive as a search.

/** How long Grasp keeps events and run details, as core answered: a card of facts. */
export const RetentionView = ({
  retention,
}: {
  /** Undefined while it is read. */
  retention: Loaded<AuditRetention> | undefined;
}) => {
  const { t } = useLingui();
  const dayCount = (days: number): string =>
    t({
      message: plural(days, { one: "# day", other: "# days" }),
      context: "how long something is kept",
    });
  if (retention === undefined || retention.state !== "ready") {
    return (
      <SectionCard title={t`Retention`}>
        {retention === undefined ? (
          <LoadingLines lines={3} />
        ) : (
          <SectionNotLoaded page={retention} />
        )}
      </SectionCard>
    );
  }
  const { auditDays, archiveDays, runDays } = retention.data;
  return (
    <SectionCard flush title={t`Retention`}>
      <SettingsRows>
        <FactRow help={t`Then events move to the archive.`} label={t`Events`}>
          {dayCount(auditDays)}
        </FactRow>
        <FactRow
          help={t`Counted from when each event was recorded; then deleted.`}
          label={t({
            message: "Archive",
            context: "where retention keeps older audit events",
          })}
        >
          {dayCount(archiveDays)}
        </FactRow>
        <FactRow
          help={t`After a run ends; then its inputs, outputs and messages go.`}
          label={t`Workflow run details`}
        >
          {dayCount(runDays)}
        </FactRow>
      </SettingsRows>
    </SectionCard>
  );
};

/**
 * Archived events that match the page's filters, in a Dialog from the
 * events card's head: retention moved them out of the log, so its search
 * finds them only here. Core searches as the dialog opens.
 */
export const ArchiveSearch = ({
  search,
  directory,
}: {
  search: LogSearch;
  directory: Directory;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [first, setFirst] = useState<AuditPage>();
  const [open, setOpen] = useState(false);
  const read = async (): Promise<void> => {
    const page = await run(
      async ({ audit }) => await audit.searchArchive(auditFilterOf(search))
    );
    if (page !== undefined) {
      setFirst(page);
    }
  };
  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);
        if (next && first === undefined) {
          void read();
        }
      }}
      open={open}
    >
      <DialogTrigger size="sm" variant="ghost">
        {t`Search the archive`}
      </DialogTrigger>
      <DialogPanel closeLabel={t`Close`}>
        <DialogTitle>{t`Archived events`}</DialogTitle>
        <DialogDescription>
          {t`Older events, searched with the filters on the page.`}
        </DialogDescription>
        <DialogBody>
          {busy && first === undefined ? <LoadingLines lines={5} /> : null}
          {failure === undefined ? null : (
            <Alert variant="danger">{failure}</Alert>
          )}
          {first === undefined ? null : (
            <LogRecords
              archive
              directory={directory}
              first={first}
              search={search}
            />
          )}
        </DialogBody>
      </DialogPanel>
    </Dialog>
  );
};

/** Retention, for an admin on Settings › Audit trail, read as the page shows. */
export const RetentionCard = () => {
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
