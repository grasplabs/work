import type { AuditRetention } from "@grasp-os/shared/audit-log";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";

import { Alert } from "../grasp/alert/index.ts";
import { KeyValueList } from "../grasp/key-value/index.ts";
import type { KeyValueItem } from "../grasp/key-value/index.ts";
import { loadFromCore, notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";

// Settings › Audit trail › Integrity and archive: how long Grasp keeps what
// it records (`audit.retention`), as name and value in the dialog, one
// list with the chain's last check. The archive
// itself is searched from the events' Filters (activity/audit-log.tsx).

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
    return <Alert tone="danger">{notLoadedText(retention, i18n) ?? ""}</Alert>;
  }
  const kept = retention?.data;
  // While it is read, each value waits at its own width.
  const fact = (key: string, days: number | undefined): KeyValueItem =>
    days === undefined
      ? { key, value: "", pending: true }
      : { key, value: dayCount(days) };
  return (
    <KeyValueList
      items={[
        fact(t`Events in the log`, kept?.auditDays),
        fact(t`Events in the archive`, kept?.archiveDays),
        fact(t`Workflow run details`, kept?.runDays),
      ]}
      variant="inline"
    />
  );
};

/** Retention, for an admin on Settings › Audit trail, read as the page shows. */
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
