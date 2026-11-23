import type { AuditRetention } from "@grasp-os/shared/audit-log";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import type { KeyValueItem } from "@grasp-os/ui/components/key-value";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";

import { loadFromCore, notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";

// Settings › Audit trail › Integrity and archive: how long Grasp keeps
// what it records (`audit.retention`), as name and value in the dialog,
// one list with the chain's last check. The archive itself is searched
// from the events' Filters (activity/audit-log.tsx).

/** How long Grasp keeps events and run details, as core answered: a list of facts. */
const RetentionView = ({
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
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {notLoadedText(retention, i18n) ?? ""}
        </AlertDescription>
      </Alert>
    );
  }
  const kept = retention?.data;
  // While it is read, each value waits at its own width.
  const fact = (
    id: string,
    label: string,
    days: number | undefined
  ): KeyValueItem =>
    days === undefined
      ? { id, label, value: dayCount(30), loading: true }
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
