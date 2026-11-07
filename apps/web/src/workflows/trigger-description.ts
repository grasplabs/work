import type { ConnectorEventType } from "@grasp-os/shared/connect";
import { connectorEventActions } from "@grasp-os/shared/connect";
import { isRecord } from "@grasp-os/shared/json";
import type {
  TriggerKind,
  TriggerSummary,
  WorkflowTrigger,
} from "@grasp-os/shared/workflow-triggers";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// What starts a trigger's runs, in words: one wording for the workflow's
// Triggers tab and for an admin deciding what a trigger asked for
// (activity/pending.tsx), from what the trigger is (`TriggerSummary`).

/** Every event type a connection reports. */
export const eventTypes = Object.keys(connectorEventActions).filter(
  (type): type is ConnectorEventType =>
    Object.hasOwn(connectorEventActions, type)
);

/** `value` as a connector event type, if it is one. */
export const eventTypeOf = (value: unknown): ConnectorEventType | undefined =>
  eventTypes.find((type) => type === value);

/** Each event type, in words. */
export const eventLabels = {
  "m365.mail.received": msg`New mail in Microsoft 365`,
  "m365.file.created": msg`A new file in Microsoft 365`,
  "google.mail.received": msg`New mail in Google`,
  "google.file.created": msg`A new file in Google Drive`,
} as const satisfies Record<ConnectorEventType, MessageDescriptor>;

/** Each kind of trigger, in words. */
export const kindLabels = {
  schedule: msg`Schedule trigger`,
  connector: msg`Connection trigger`,
  email: msg`Email trigger`,
  webhook: msg`Webhook trigger`,
} as const satisfies Record<TriggerKind, MessageDescriptor>;

/** A field of `config` at `path`, if it is text. */
const textAt = (config: unknown, ...path: string[]): string | undefined => {
  let node: unknown = config;
  for (const key of path) {
    node = isRecord(node) ? node[key] : undefined;
  }
  return typeof node === "string" ? node : undefined;
};

/** What `trigger` is, from its configuration as its listing has it. */
export const summaryOf = ({
  kind,
  config,
}: WorkflowTrigger): TriggerSummary => {
  const cron = textAt(config, "schedule", "cron");
  const timeZone = textAt(config, "schedule", "timeZone");
  const connectionId = textAt(config, "connection", "connectionId");
  return {
    kind,
    schedule:
      cron === undefined || timeZone === undefined ? null : { cron, timeZone },
    event: textAt(config, "event") ?? null,
    connection:
      connectionId === undefined
        ? null
        : {
            connectionId,
            resource: textAt(config, "connection", "resource") ?? null,
          },
  };
};

/**
 * What starts a run of the trigger `summary` says, in words: `accountName`
 * names its connection (its ID otherwise), and `address` an email
 * trigger's address, for whoever may see it.
 */
export const triggerDescription = (
  summary: TriggerSummary,
  {
    accountName,
    address,
  }: { accountName?: string; address?: string | null } = {}
): string => {
  const { kind, schedule, connection } = summary;
  if (kind === "schedule") {
    const cron = schedule?.cron ?? "";
    const zone = schedule?.timeZone ?? "";
    return i18n._(msg`On the schedule ${cron}, in ${zone}`);
  }
  if (kind === "connector") {
    const type = eventTypeOf(summary.event);
    const account = accountName ?? connection?.connectionId ?? "";
    if (type === undefined) {
      return i18n._(msg`When ${account} reports an event`);
    }
    const event = i18n._(eventLabels[type]);
    return i18n._(msg`${event}, at ${account}`);
  }
  if (kind === "email") {
    if (address === undefined || address === null) {
      return i18n._(msg`When an email arrives at its own address`);
    }
    const localPart = address;
    return i18n._(msg`When an email arrives for ${localPart}`);
  }
  return i18n._(msg`When its webhook is called`);
};
