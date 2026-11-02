import type { AuditEventType } from "@grasp-os/shared/audit-log";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// Apart from audit-log.tsx: the dashboard and the inbox name an event's
// type without the log's page.

export const typeLabels: Record<AuditEventType, MessageDescriptor> = {
  read: msg`Read`,
  action: msg`Action`,
  decision: msg`Decision`,
  permission: msg`Permission`,
  model_call: msg`Model call`,
  config: msg`Configuration`,
  platform_update: msg`Platform update`,
};
