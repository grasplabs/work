import type { AuditRecord } from "@grasp-os/shared/audit-log";
import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";

import { actionWords } from "../activity/audit-words.ts";
import { typeLabels } from "../activity/type-labels.ts";
import { formatDateTime } from "../format.ts";
import { RouterLink } from "../frame/router-link.tsx";
import { Badge } from "../grasp/badge/index.ts";
import { Empty } from "../grasp/empty/index.ts";
import { Item, ItemGroup } from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";

// The latest of what Grasp and people did, for admins, from the audit
// trail: each in its sentence, with its time and type, and the way to the whole
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
    <Item
      description={formatDateTime(record.receivedAt)}
      size="sm"
      title={sentence}
      {...(record.type === null
        ? {}
        : { actions: <Badge>{i18n._(typeLabels[record.type])}</Badge> })}
    />
  );
};

/** What the card read of the trail: the latest events, and whether it stopped before the trail's end. */
export interface LatestActivity {
  records: AuditRecord[];
  older: boolean;
}

/** The latest events, newest first, and the way on to the audit trail. */
export const Activity = ({ activity }: { activity: LatestActivity }) => {
  const { records, older } = activity;
  const { t } = useLingui();
  const shown = records.slice(0, activityShown);
  return (
    <SectionCard
      flush
      footer={
        <RouterLink to="/settings/audit" variant="standalone">
          {t`The full audit trail`}
        </RouterLink>
      }
      title={t({
        message: "Activity",
        context: "dashboard: what Grasp and people did",
      })}
    >
      {shown.length === 0 ? (
        <Empty size="inline">
          {older
            ? t`Lately the trail only records its own searches: older events are in the full audit trail.`
            : t`Nothing has happened yet.`}
        </Empty>
      ) : (
        <ItemGroup aria-label={t`Latest activity`} separated>
          {shown.map((record) => (
            <Row key={record.seq} record={record} />
          ))}
        </ItemGroup>
      )}
    </SectionCard>
  );
};
