import type { AuditEvent } from "@grasp-os/shared/audit";
import type {
  AuditFilter,
  AuditPage,
  AuditRecord,
} from "@grasp-os/shared/audit-log";
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
// connections and on the permissions on them, read by admins (the only
// ones who may read the log), a stretch of the log at a time.

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
 * The connection an event is about: its target, or, for a permission
 * asked for, granted or revoked on one, the connection the permission
 * names (core records those on the permission, with the connection in its
 * detail).
 */
const connectionOf = (event: AuditEvent): string | undefined => {
  if (event.target?.type === "connection") {
    return event.target.id;
  }
  const named = event.detail.connectionId;
  return event.target?.type === "permission" && typeof named === "string"
    ? named
    : undefined;
};

/**
 * One of core's audit records about an app's connection, or a permission
 * on one, as its trail shows it: what was done in words, by whom, on which
 * account. A record whose stored event can't be read is left out.
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
  const connection = connectionOf(event) ?? event.target?.id ?? "";
  const account = accounts.get(connection) ?? connection;
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

/** One page of core's audit log, as `session.audit.search` reads it. */
export type SearchLog = (
  filter: AuditFilter,
  before: number | undefined
) => Promise<AuditPage>;

/**
 * One search of the log an app's trail reads, and where its next, older
 * page starts: `undefined` before its first page, `null` once it has read
 * back to the start of the log.
 */
export interface TrailSearch {
  filter: AuditFilter;
  next: number | null | undefined;
}

/**
 * How far an app's trail is read: the records found on its connections so
 * far, newest first, and the searches it reads. Each connection has its
 * own search for the events on it. Core can't search on the connection a
 * permission names, so one more search reads every permission event and
 * the trail keeps those on the app's connections.
 */
export interface TrailRead {
  connectionIds: string[];
  /**
   * The one app of the connections the trail is of, for an app found in
   * the identity provider's grants: a record naming another app (who
   * looked at who granted that one access) is left out.
   */
  appId?: string | undefined;
  records: AuditRecord[];
  searches: TrailSearch[];
}

/** An app's trail before anything is read. */
export const startTrail = (
  connectionIds: readonly string[],
  appId?: string
): TrailRead => ({
  connectionIds: [...connectionIds],
  appId,
  records: [],
  searches: [
    ...connectionIds.map((id) => ({
      filter: { targetType: "connection", targetId: id },
      next: undefined,
    })),
    { filter: { targetType: "permission" }, next: undefined },
  ],
});

/** Most pages read of each search at a time: each page reads a bounded stretch of the log. */
export const pagesPerRead = 10;

/**
 * Whether a record is about one of `connectionIds`, and, given `appId`,
 * names no other app.
 */
const onConnections = (
  { event }: AuditRecord,
  connectionIds: readonly string[],
  appId?: string
): boolean => {
  const connection = event === null ? undefined : connectionOf(event);
  const app = event?.detail.app;
  return (
    connection !== undefined &&
    connectionIds.includes(connection) &&
    (appId === undefined || typeof app !== "string" || app === appId)
  );
};

/** Up to `pages` more pages of one search, from where it stopped. */
const readSearch = async (
  search: SearchLog,
  from: TrailSearch,
  pages: number
): Promise<{ search: TrailSearch; records: AuditRecord[] }> => {
  const records: AuditRecord[] = [];
  let before = from.next ?? undefined;
  for (let page = 0; page < pages; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each page starts where the last ended
    const { records: found, next } = await search(from.filter, before);
    records.push(...found);
    if (next === null) {
      return { search: { ...from, next: null }, records };
    }
    before = next;
  }
  return { search: { ...from, next: before }, records };
};

/**
 * Reads on: up to `pages` more pages of each search that has more, keeping
 * what they find on the app's connections.
 */
export const readTrail = async (
  search: SearchLog,
  read: TrailRead,
  pages = pagesPerRead
): Promise<TrailRead> => {
  const done = await Promise.all(
    read.searches.map(async (each) =>
      each.next === null
        ? { search: each, records: [] }
        : await readSearch(search, each, pages)
    )
  );
  const records = new Map(read.records.map((record) => [record.seq, record]));
  for (const record of done.flatMap((each) => each.records)) {
    if (onConnections(record, read.connectionIds, read.appId)) {
      records.set(record.seq, record);
    }
  }
  return {
    connectionIds: read.connectionIds,
    appId: read.appId,
    records: [...records.values()].toSorted(
      (one, other) => other.seq - one.seq
    ),
    searches: done.map((each) => each.search),
  };
};

/** Whether older events may be left to read. */
export const hasOlder = (read: TrailRead): boolean =>
  read.searches.some(({ next }) => next !== null);

/**
 * The records the trail shows: those down to where every search has read,
 * so an older event never shows while a newer one waits in a search that
 * hasn't reached it yet. The rest show after the next read.
 */
export const trailRecords = (read: TrailRead): AuditRecord[] => {
  const open = read.searches.flatMap(({ next }) =>
    typeof next === "number" ? [next] : []
  );
  if (open.length === 0) {
    return read.records;
  }
  const whole = Math.max(...open);
  return read.records.filter(({ seq }) => seq >= whole);
};

/** An app's connection, as its trail names it. */
export type TrailConnection = Pick<ListedConnection, "id" | "accountName">;

/** An app's audit trail as read so far, with who's who to show it. */
export interface AppAuditTrail {
  read: TrailRead;
  directory: Directory;
  /** The account each connection is on, by connection ID. */
  accounts: ReadonlyMap<string, string>;
}

/** The events the trail shows, newest first. */
export const trailEvents = (trail: AppAuditTrail): AppAuditEvent[] =>
  trailRecords(trail.read).flatMap(
    (record) => appAuditEventOf(record, trail.directory, trail.accounts) ?? []
  );

const searchOn =
  (session: Session): SearchLog =>
  async (filter, before) =>
    await session.audit.search(filter, before);

/**
 * The audit trail of an app, its latest stretch: the events on each of its
 * connections and on the permissions on them, newest first. Admins only;
 * core refuses anyone else.
 */
export const readAppAudit = async (
  session: Session,
  connections: readonly TrailConnection[],
  /** The one app of them, for an app found in the identity provider's grants. */
  appId?: string
): Promise<AppAuditTrail> => {
  const [directory, read] = await Promise.all([
    readDirectory(session),
    readTrail(
      searchOn(session),
      startTrail(
        connections.map(({ id }) => id),
        appId
      )
    ),
  ]);
  return {
    read,
    directory,
    accounts: new Map(
      connections.map(({ id, accountName }) => [id, accountName ?? id])
    ),
  };
};

/** The trail with its next, older stretch read. */
export const readOlderAppAudit = async (
  session: Session,
  trail: AppAuditTrail
): Promise<AppAuditTrail> => ({
  ...trail,
  read: await readTrail(searchOn(session), trail.read),
});

/** The whole trail, read on from where it stopped to the start of the log. */
export const readWholeAppAudit = async (
  session: Session,
  trail: AppAuditTrail
): Promise<AppAuditTrail> => {
  let { read } = trail;
  while (hasOlder(read)) {
    // oxlint-disable-next-line no-await-in-loop -- each read starts where the last ended
    read = await readTrail(searchOn(session), read);
  }
  return { ...trail, read };
};
