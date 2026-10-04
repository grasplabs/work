import type { AuditRecord } from "@grasp-os/shared/audit-log";
import { Badge } from "@grasp-os/ui/components/badge";
import { i18n } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";

import { typeLabels } from "../activity/audit-log.tsx";
import { actionWords } from "../activity/audit-words.ts";
import { formatDateTime } from "../format.ts";
import { DashboardCard, DashboardCardHeader } from "./dashboard-card.tsx";

// The latest of what Grasp and people did, for admins, from the audit
// trail (the prototype's Activity, `components/dashboard/action-panel.tsx`):
// each in its sentence, with its time and type, and the way to the whole
// trail. Only admins may read the audit log; anyone else has no card.

/** How many of the latest events the card shows; the rest are in the audit trail. */
export const activityShown = 8;

const Row = ({ record }: { record: AuditRecord }) => {
  const { t } = useLingui();
  const action = record.event?.action;
  const text = action === undefined ? undefined : actionWords(action);
  let sentence = t`Unreadable event`;
  if (text !== undefined) {
    sentence = i18n._(text);
  } else if (action !== undefined) {
    sentence = action;
  }
  return (
    <li className="flex items-start gap-3 border-t px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-muted-foreground text-xs tabular-nums">
          {formatDateTime(record.receivedAt)}
        </span>
        <span>{sentence}</span>
      </div>
      {record.type === null ? null : (
        <Badge variant="outline">{i18n._(typeLabels[record.type])}</Badge>
      )}
    </li>
  );
};

/** The latest events, newest first, and the way on to the audit trail. */
export const Activity = ({ records }: { records: AuditRecord[] }) => {
  const { t } = useLingui();
  const shown = records.slice(0, activityShown);
  return (
    <DashboardCard id="dashboard-activity">
      <DashboardCardHeader
        id="dashboard-activity"
        title={t({
          message: "Activity",
          context: "dashboard: what Grasp and people did",
        })}
      />
      {shown.length === 0 ? (
        <p className="text-muted-foreground border-t px-4 py-6 text-center">
          <Trans>Nothing has happened yet.</Trans>
        </p>
      ) : (
        <ul aria-label={t`Latest activity`}>
          {shown.map((record) => (
            <Row key={record.seq} record={record} />
          ))}
        </ul>
      )}
      <Link
        className="hover:bg-muted focus-visible:bg-muted flex h-12 flex-none items-center gap-2 border-t px-4 outline-none"
        to="/settings/audit"
      >
        <span className="flex-1">
          <Trans>The full audit trail</Trans>
        </span>
        <ChevronRightIcon
          aria-hidden="true"
          className="text-muted-foreground size-4"
        />
      </Link>
    </DashboardCard>
  );
};
