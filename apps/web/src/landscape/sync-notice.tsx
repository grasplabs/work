import type { LandscapeSyncStatus } from "@grasp-os/shared/landscape";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { TriangleAlertIcon } from "lucide-react";

import { formatDateTime } from "../format.ts";
import type { Loaded } from "../load-from-core.tsx";
import type { Completeness } from "./landscape-data.ts";

// How fresh the apps found in Microsoft Entra are, for admins: when the
// landscape last read the tenant's grants whole, and, when its last read
// stopped at its limit or failed, a notice saying so, so a partial list is
// never taken for the whole one.

/** Why a sync failed, in words, by the code core gave. */
const reasons: Record<string, MessageDescriptor> = {
  "landscape.inactive": msg`The Microsoft Entra connection needs an admin to connect it again.`,
  "landscape.tenant_mismatch": msg`The Microsoft Entra connection is to another organization's tenant, so nothing it read was kept.`,
  "landscape.throttled": msg`Microsoft kept throttling the reads until the day was over.`,
  "landscape.cursor_invalid": msg`Microsoft's list changed under the read. It starts over tomorrow.`,
};
const otherReason = msg`Microsoft didn't answer the reads. Grasp tries again tomorrow.`;

/** What a connection's last sync means for the list, for an admin. */
export const syncNoticeOf = (
  status: LandscapeSyncStatus
): {
  /** A notice to show, when the list isn't whole. */
  notice: { title: MessageDescriptor; reason: MessageDescriptor } | null;
  /** When the list was last read whole; null before it ever was. */
  wholeAt: string | null;
} => {
  if (status.state === "partial") {
    return {
      notice: {
        title: msg`The last read of Microsoft Entra stopped at its limit`,
        reason: msg`Your organization has more grants than one day's read takes, so some apps may be missing.`,
      },
      wholeAt: status.wholeAt,
    };
  }
  if (status.state === "failed") {
    return {
      notice: {
        title: msg`The last read of Microsoft Entra failed`,
        reason:
          (status.reason === null ? undefined : reasons[status.reason]) ??
          otherReason,
      },
      wholeAt: status.wholeAt,
    };
  }
  return { notice: null, wholeAt: status.wholeAt };
};

/** One connection's freshness, and its notice. */
const SyncNotice = ({ status }: { status: LandscapeSyncStatus }) => {
  const { t, i18n } = useLingui();
  const { notice, wholeAt } = syncNoticeOf(status);
  const when = wholeAt === null ? null : formatDateTime(wholeAt);
  const freshness =
    when === null
      ? t`Microsoft Entra hasn't been read whole yet.`
      : t`Apps found in Microsoft Entra as of ${when}.`;
  if (notice === null) {
    return <p className="text-muted-foreground">{freshness}</p>;
  }
  return (
    <Alert>
      <TriangleAlertIcon />
      <AlertTitle>{i18n._(notice.title)}</AlertTitle>
      <AlertDescription>
        {i18n._(notice.reason)} {freshness}
      </AlertDescription>
    </Alert>
  );
};

/**
 * A line saying the apps found may be incomplete, when a last read didn't
 * finish or Grasp couldn't check: for anyone the per-connection notices
 * aren't shown to (anyone but an admin, or an admin whose read of them
 * failed).
 */
export const IncompleteNotice = ({
  incomplete,
  syncs,
}: {
  incomplete: Completeness;
  syncs: Loaded<LandscapeSyncStatus[]> | null;
}) => {
  const { t } = useLingui();
  if (incomplete === "whole" || syncs?.state === "ready") {
    return null;
  }
  return (
    <p className="text-muted-foreground">
      {incomplete === "incomplete"
        ? t`The apps found in Microsoft Entra may be incomplete: its last read didn't finish.`
        : t`The apps found in Microsoft Entra may be incomplete: Grasp couldn't check its last read.`}
    </p>
  );
};

/** Each landscape connection's freshness, for admins. */
export const SyncNotices = ({
  syncs,
}: {
  syncs: Loaded<LandscapeSyncStatus[]> | null;
}) =>
  syncs?.state === "ready"
    ? syncs.data.map((status) => (
        <SyncNotice key={status.connectionId} status={status} />
      ))
    : null;
