import type { AuditRecord } from "@grasp-os/shared/audit-log";
import type { ListedConnection } from "@grasp-os/shared/connect";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg, t } from "@lingui/core/macro";

import { actorOf } from "../activity/audit-log.tsx";
import { actionWords } from "../activity/audit-words.ts";
import type { Session } from "../core.ts";
import { readDirectory } from "../directory.ts";
import type { Directory } from "../directory.ts";
import { formatMonth } from "../format.ts";
import { fileDate, fileSlug } from "./download.ts";
import { toCsv } from "./landscape.ts";

// An app's audit trail, as the prototype keeps it (`lib/landscape-audit.ts`):
// every recorded access and permission event, newest first, grouped by
// month, to search, filter, open and export. The prototype's events are
// demo records; here they are core's audit log, the events on the app's
// connections, read by admins (the only ones who may read the log).

/**
 * What the platform does with an app: Grasp finds it, follows who reaches
 * it and with what permissions, applies the company's policy to it, has it
 * owned by someone, and follows the vendor behind it.
 */
export type AuditCategory =
  | "detection"
  | "access"
  | "policy"
  | "ownership"
  | "vendor";

/** Who recorded an event: a person, or Grasp on its own. */
export type AuditActorType = "human" | "pipeline";

/** One event on an app's audit trail. */
export interface AppAuditEvent {
  id: string;
  /** When it was recorded (ISO 8601). */
  timestamp: string;
  actor: string;
  actorType: AuditActorType;
  category: AuditCategory;
  title: string;
  description: string;
  oldValue?: string;
  newValue?: string;
  /** The event this one follows from. */
  parentEventId?: string;
  payload?: Record<string, string | number | boolean | null>;
  /** The event's fingerprint in the chain. */
  hash?: string;
}

/** Categories in the order the filter lists them. */
export const auditCategoryLabel: Record<AuditCategory, MessageDescriptor> = {
  detection: msg({
    message: "Discovery",
    context: "category of an audit event",
  }),
  access: msg({ message: "Access", context: "category of an audit event" }),
  policy: msg({ message: "Policy", context: "category of an audit event" }),
  ownership: msg({
    message: "Ownership",
    context: "category of an audit event",
  }),
  vendor: msg({ message: "Vendor", context: "category of an audit event" }),
};

export const auditCategories: readonly AuditCategory[] = [
  "detection",
  "access",
  "policy",
  "ownership",
  "vendor",
];

export const auditActorTypes: readonly AuditActorType[] = ["human", "pipeline"];

export const auditActorLabel: Record<AuditActorType, MessageDescriptor> = {
  human: msg({ message: "Person", context: "who recorded an audit event" }),
  pipeline: msg({
    message: "Automated",
    context: "who recorded an audit event",
  }),
};

/* ── Filtering ───────────────────────────────────────────────────────── */

/** Chosen values per facet; an empty facet lets everything through. */
export interface AuditFilters {
  actor: AuditActorType[];
  category: AuditCategory[];
}

export const noAuditFilters: AuditFilters = { actor: [], category: [] };

export const hasAuditFilters = (
  filters: AuditFilters,
  query: string
): boolean =>
  filters.actor.length > 0 ||
  filters.category.length > 0 ||
  query.trim() !== "";

/** Any choice within a facet, every facet, and the search in title, actor, description or category as shown. */
export const matchesAudit = (
  event: AppAuditEvent,
  filters: AuditFilters,
  query: string
): boolean => {
  if (filters.actor.length > 0 && !filters.actor.includes(event.actorType)) {
    return false;
  }
  if (
    filters.category.length > 0 &&
    !filters.category.includes(event.category)
  ) {
    return false;
  }
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") {
    return true;
  }
  return [
    event.title,
    event.actor,
    event.description,
    i18n._(auditCategoryLabel[event.category]),
  ].some((text) => text.toLocaleLowerCase().includes(needle));
};

/* ── Paging ──────────────────────────────────────────────────────────── */

/** Events are shown a page at a time. */
export const auditPageSize = 25;

/** How many events to show so the one at `index` is in view, in whole pages. */
export const visibleCountFor = (
  index: number,
  current: number,
  pageSize = auditPageSize
): number => Math.max(current, Math.ceil((index + 1) / pageSize) * pageSize);

/* ── Timeline ────────────────────────────────────────────────────────── */

export interface AuditMonth {
  /** "2026-04", for keys. */
  month: string;
  /** "Apr 2026", for the heading. */
  label: string;
  events: AppAuditEvent[];
}

/** Consecutive events grouped by the month they happened in, keeping their order. */
export const groupByMonth = (
  events: readonly AppAuditEvent[]
): AuditMonth[] => {
  const groups: AuditMonth[] = [];
  for (const event of events) {
    const month = event.timestamp.slice(0, 7);
    const last = groups.at(-1);
    if (last?.month === month) {
      last.events.push(event);
    } else {
      groups.push({ month, label: formatMonth(month), events: [event] });
    }
  }
  return groups;
};

/** "2026-04-20T08:00:00Z" as the reader's language writes the day, in UTC as recorded. */
export const eventDate = (timestamp: string): string =>
  new Intl.DateTimeFormat(i18n.locale, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(`${timestamp.slice(0, 10)}T00:00:00Z`));

const timePattern = /T\d{2}:\d{2}/u;

/** "2026-04-20T08:00:00Z" as "08:00", in UTC as recorded; empty when only a date was recorded. */
export const eventTime = (timestamp: string): string =>
  timePattern.test(timestamp) ? timestamp.slice(11, 16) : "";

/** The event this one follows from, when it is in the trail. */
export const parentOf = (
  event: AppAuditEvent,
  events: readonly AppAuditEvent[]
): AppAuditEvent | undefined =>
  event.parentEventId === undefined
    ? undefined
    : events.find((each) => each.id === event.parentEventId);

/** The first 8 and last 4 characters of a fingerprint. */
export const shortHash = (hash: string): string =>
  hash.length <= 12 ? hash : `${hash.slice(0, 8)}…${hash.slice(-4)}`;

const separators = /[_.-]+/gu;
const camelHumps = /(?<before>[a-z0-9])(?<after>[A-Z])/gu;

/** "usersScanned" as "Users scanned". */
export const detailLabel = (key: string): string => {
  const words = key
    .replaceAll(separators, " ")
    .replaceAll(camelHumps, "$<before> $<after>")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A recorded value in words: yes or no, a dash for nothing. */
export const detailValue = (
  value: string | number | boolean | null
): string => {
  if (value === null || value === "") {
    return "—";
  }
  if (typeof value === "boolean") {
    return value ? t`Yes` : t`No`;
  }
  return String(value);
};

/** The structured details of an event as label and value rows. */
export const eventDetails = (
  event: AppAuditEvent
): { label: string; value: string }[] =>
  Object.entries(event.payload ?? {}).map(([key, value]) => ({
    label: detailLabel(key),
    value: detailValue(value),
  }));

/* ── Export ──────────────────────────────────────────────────────────── */

/** "audit-trail-chatgpt-2026-09-29.csv": the file an app's audit trail downloads as. */
export const auditFileName = (appName: string): string =>
  `audit-trail-${fileSlug(appName)}-${fileDate()}.csv`;

/**
 * Every event in view, one row each, newest first as shown, in the
 * reader's language. `all` is the whole trail, to name parents.
 */
export const auditCsv = (
  events: readonly AppAuditEvent[],
  all: readonly AppAuditEvent[] = events
): string =>
  toCsv([
    [
      t`Date`,
      t`Time (UTC)`,
      t`Category`,
      t({ message: "Event", context: "column of the audit trail export" }),
      t`Description`,
      t({
        message: "By",
        context: "column of the audit trail export: who recorded the event",
      }),
      t`Person or automated`,
      t({
        message: "Before",
        context:
          "column of the audit trail export: the value before the change",
      }),
      t({
        message: "After",
        context: "column of the audit trail export: the value after the change",
      }),
      t`Follows from`,
      t`Details`,
      t`Fingerprint`,
    ],
    ...events.map((event) => [
      eventDate(event.timestamp),
      eventTime(event.timestamp),
      i18n._(auditCategoryLabel[event.category]),
      event.title,
      event.description,
      event.actor,
      i18n._(auditActorLabel[event.actorType]),
      event.oldValue ?? "",
      event.newValue ?? "",
      parentOf(event, all)?.title ?? event.parentEventId ?? "",
      eventDetails(event)
        .map((row) => `${row.label}: ${row.value}`)
        .join("; "),
      event.hash ?? "",
    ]),
  ]);

/* ── From core's audit log ───────────────────────────────────────────── */

/** Connecting an account is how Grasp comes to know an app. */
const discoveryActions = new Set(["connection.connect"]);

/**
 * One of core's audit records about an app's connection, as its trail
 * shows it: what was done in words, by whom, on which account. A record
 * whose stored event can't be read is left out.
 */
export const appAuditEventOf = (
  record: AuditRecord,
  directory: Directory,
  accounts: ReadonlyMap<string, string>
): AppAuditEvent | undefined => {
  const { event } = record;
  if (event === null) {
    return undefined;
  }
  const words = actionWords(event.action);
  const target = event.target?.id ?? "";
  const account = accounts.get(target) ?? target;
  const person =
    event.actor.type === "person" ||
    event.actor.type === "staff" ||
    event.actor.type === "guest";
  return {
    id: String(record.seq),
    timestamp: record.receivedAt,
    actor: actorOf(event.actor, directory).label,
    actorType: person ? "human" : "pipeline",
    category: discoveryActions.has(event.action) ? "detection" : "access",
    title: words === undefined ? event.action : i18n._(words),
    description: i18n._(msg`On the connection ${account}`),
    payload: event.detail,
    hash: record.hash,
  };
};

/** Most pages of the log read for one connection: each page reads a bounded stretch. */
const pagesPerConnection = 10;

/** Every record core holds on `connectionId`, newest first, as far as `pagesPerConnection` reach. */
const recordsOn = async (
  session: Session,
  connectionId: string
): Promise<AuditRecord[]> => {
  const records: AuditRecord[] = [];
  let before: number | undefined;
  for (let page = 0; page < pagesPerConnection; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each page starts where the last ended
    const { records: found, next } = await session.audit.search(
      { targetType: "connection", targetId: connectionId },
      before
    );
    records.push(...found);
    if (next === null) {
      break;
    }
    before = next;
  }
  return records;
};

/**
 * The audit trail of an app: the events on each of its connections,
 * newest first. Admins only; core refuses anyone else.
 */
export const readAppAudit = async (
  session: Session,
  connections: readonly Pick<ListedConnection, "id" | "accountName">[]
): Promise<AppAuditEvent[]> => {
  const [directory, ...perConnection] = await Promise.all([
    readDirectory(session),
    ...connections.map(async ({ id }) => await recordsOn(session, id)),
  ]);
  const accounts = new Map(
    connections.map(({ id, accountName }) => [id, accountName ?? id])
  );
  return perConnection
    .flat()
    .toSorted((one, other) => other.seq - one.seq)
    .flatMap((record) => appAuditEventOf(record, directory, accounts) ?? []);
};
