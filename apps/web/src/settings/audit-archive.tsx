import type { AuditRetention } from "@grasp-os/shared/audit-log";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";

import { FactRow, RowAlert } from "../grasp/setting-row/index.ts";
import { loadFromCore, notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";

// Settings › Audit trail › Integrity and archive: how long Grasp keeps what
// it records (`audit.retention`), as facts in the dialog. The archive
// itself is searched from the events' Filters (activity/audit-log.tsx).

/** How long Grasp keeps events and run details, as core answered: rows of facts. */
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
  if (retention === undefined) {
    return null;
  }
  if (retention.state !== "ready") {
    return (
      <RowAlert variant="danger">
        {notLoadedText(retention, i18n) ?? ""}
      </RowAlert>
    );
  }
  const { auditDays, archiveDays, runDays } = retention.data;
  return (
    <>
      <FactRow help={t`Then events move to the archive.`} label={t`In the log`}>
        {dayCount(auditDays)}
      </FactRow>
      <FactRow
        help={t`From when each event was recorded; then deleted.`}
        label={t`In the archive`}
      >
        {dayCount(archiveDays)}
      </FactRow>
      <FactRow
        help={t`After a run ends; then its inputs, outputs and messages go.`}
        label={t`Workflow run details`}
      >
        {dayCount(runDays)}
      </FactRow>
    </>
  );
};

/** Retention, for an admin on Settings › Audit trail, read as the page shows, as rows. */
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
