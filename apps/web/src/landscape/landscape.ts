import type { CatalogSource } from "@grasp-os/shared/connect";
import type { LandscapeSignal } from "@grasp-os/shared/landscape";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg, t } from "@lingui/core/macro";

import { formatList } from "../format.ts";

// The Landscape, as the prototype models it (`lib/landscape.ts`): every app
// the company uses, how Grasp knows about it, what it touches and who owns
// it; with the filters, sorting, columns, export and mosaic of its page.
// The prototype's records are its V1 demo data; here an app is what Grasp
// knows from its integrations (landscape-data.ts), and every fact nothing
// in Grasp records yet is unknown (null, or "Unknown"), never made up.

/** Whether AI is what the app does, a feature in it, absent, or not known. */
export type AiType = "Core" | "Embed" | "None" | "Unknown";

/** The kinds of data an app can touch. */
export type DataExposureType =
  | "customer"
  | "employee"
  | "code"
  | "financial"
  | "health"
  | "credentials"
  | "legal";

/** Where a vendor stores and processes the data put into its tool. */
export type HostingRegion = "eu" | "uk" | "us" | "china";

/** An engine (an App) that uses an app through one of its connections. */
export interface AppEngine {
  id: string;
  name: string;
}

/** How Grasp knows an app is used, and where it comes up. */
export interface AppUse {
  /** Who connected it: Grasp's own connector, or Composio. */
  sources: CatalogSource[];
  /**
   * The engines holding a permission on one of its connections; null when
   * they couldn't be read (only admins list permissions), which isn't the
   * same as none.
   */
  engines: AppEngine[] | null;
}

/**
 * What the identity provider's grants say of an app, as core's landscape
 * keeps them: the connection they were read through, the app's client ID,
 * and what may need a look at it.
 */
export interface DiscoveredApp {
  connectionId: string;
  appId: string;
  adminConsented: boolean;
  scopes: string[];
  signals: LandscapeSignal[];
}

/** The address of an app found in the identity provider's grants. */
export const discoveredAppId = (connectionId: string, appId: string): string =>
  `entra:${connectionId}:${appId}`;

/** The connection and client ID an address names, if it is a found app's. */
export const discoveredAppOfId = (
  id: string
): { connectionId: string; appId: string } | undefined => {
  const [kind, connectionId, appId, ...rest] = id.split(":");
  return kind === "entra" &&
    connectionId !== undefined &&
    connectionId !== "" &&
    appId !== undefined &&
    appId !== "" &&
    rest.length === 0
    ? { connectionId, appId }
    : undefined;
};

/** What each signal on a found app means, as a short label. */
export const signalLabel: Record<LandscapeSignal, MessageDescriptor> = {
  unverified_publisher: msg`Unverified publisher`,
  person_high_privilege: msg`Broad access granted by a person`,
  new_app: msg({ message: "New", context: "an app first seen this week" }),
  no_admin_consent: msg`No admin consent`,
};

/** Why each signal on a found app is raised, for its row. */
export const signalDescription: Record<LandscapeSignal, MessageDescriptor> = {
  unverified_publisher: msg`Microsoft hasn't verified who publishes this app.`,
  person_high_privilege: msg`Someone gave it access to their mail, files, chats or the directory on their own.`,
  new_app: msg`First seen in the last 7 days.`,
  no_admin_consent: msg`People use it, and no admin approved it for everyone.`,
};

/** One app in the landscape. */
export interface LandscapeApp {
  /** Its integration's key (`native:microsoft`), as the address names it. */
  id: string;
  name: string;
  /** Who makes it; null while nothing says. */
  vendor: string | null;
  category: string | null;
  /** What it is for; null while nothing says. */
  description: string | null;
  aiType: AiType;
  /** The data it touches; null while Grasp does not know. */
  dataExposure: DataExposureType[] | null;
  dataExposureReason: string;
  /** Where its data is hosted, as the vendor states it; empty when nothing says. */
  hosting: HostingRegion[];
  /** People Grasp saw use it; null while nothing measures its usage. */
  users: number | null;
  owner: string | null;
  /** When Grasp first knew of it: its first connection (ISO 8601). */
  firstSeen: string;
  /** Its connections this person can see. */
  connectionIds: string[];
  use: AppUse;
  /** Marked by a policy rule (policies/policy.ts `applyPolicy`). */
  blocked: boolean;
  flagged: boolean;
  /** The rule that marked it. */
  policySource: string | null;
  /** Found in the identity provider's grants; null for an integration. */
  discovered: DiscoveredApp | null;
}

/** The two ways to look at the landscape: a table, or a mosaic of apps by category. */
export type LandscapeView = "table" | "mosaic";

export const parseLandscapeView = (value: unknown): LandscapeView =>
  value === "mosaic" ? "mosaic" : "table";

export const aiTypeLabel: Record<AiType, MessageDescriptor> = {
  Core: msg`Core AI`,
  Embed: msg`Embedded AI`,
  None: msg`No AI`,
  Unknown: msg({ message: "Unknown", context: "AI type of an app" }),
};

export const aiTypeDescription: Record<AiType, MessageDescriptor> = {
  Core: msg`AI is a primary function of this app. It generates, decides or acts on data.`,
  Embed: msg`AI is a feature inside a larger app, such as suggestions, copilots or summaries.`,
  None: msg`No AI capabilities found in this app.`,
  Unknown: msg`Not classified yet.`,
};

/** An app's category; "Uncategorized" without one. */
export const appCategoryLabel = (app: Pick<LandscapeApp, "category">): string =>
  app.category ?? t`Uncategorized`;

/** How Grasp knows about an app, as a short label. */
export const appSourceLabel: Record<CatalogSource, MessageDescriptor> = {
  native: msg`Native`,
  composio: msg`Via Composio`,
};

/** What each way of knowing about an app means, for a hover. */
export const appSourceDescription: Record<CatalogSource, MessageDescriptor> = {
  native: msg`Connected in Integrations, through Grasp's own connector.`,
  composio: msg`Connected in Integrations, through Composio, which keeps the access in its own cloud.`,
};

interface ExposureMeta {
  label: MessageDescriptor;
  /** Lower comes first: the most sensitive category leads. */
  rank: number;
  /** Sensitive categories carry the attention dot. */
  sensitive: boolean;
  definition: MessageDescriptor;
}

export const exposureMeta: Record<DataExposureType, ExposureMeta> = {
  customer: {
    label: msg`Customer data`,
    rank: 0,
    sensitive: true,
    definition: msg`Customer records, messages, tickets, CRM fields or files that identify customers.`,
  },
  employee: {
    label: msg`Internal data`,
    rank: 1,
    sensitive: false,
    definition: msg`Documents written by employees, workspace files, user profiles and internal collaboration.`,
  },
  code: {
    label: msg({ message: "Code", context: "kind of data an app touches" }),
    rank: 2,
    sensitive: false,
    definition: msg`Repository content, snippets, editor context, build logs or engineering documentation.`,
  },
  financial: {
    label: msg`Financial data`,
    rank: 3,
    sensitive: false,
    definition: msg`Finance documents, invoices, billing exports, procurement records or forecasts.`,
  },
  health: {
    label: msg`Health data`,
    rank: 4,
    sensitive: true,
    definition: msg`Health-related employee or customer information that needs a closer review.`,
  },
  credentials: {
    label: msg`Credentials`,
    rank: 5,
    sensitive: true,
    definition: msg`Keys, tokens, secrets, credentials or runbooks that could grant access.`,
  },
  legal: {
    label: msg`Legal data`,
    rank: 6,
    sensitive: false,
    definition: msg`Contracts, DPAs, legal terms, procurement clauses or compliance records.`,
  },
};

/** Every kind of data, in the order the filter lists them. */
export const dataExposureTypes: readonly DataExposureType[] = [
  "customer",
  "employee",
  "code",
  "financial",
  "health",
  "credentials",
  "legal",
];

/** Every AI type, in the order the filter lists them. */
export const aiTypes: readonly AiType[] = ["Core", "Embed", "None", "Unknown"];

/** Data exposure categories, most sensitive first. */
export const sortedExposure = (
  types: readonly DataExposureType[]
): DataExposureType[] =>
  types.toSorted((a, b) => exposureMeta[a].rank - exposureMeta[b].rank);

/* ── Filters ─────────────────────────────────────────────────────────── */

export type QuickFilter = "unused" | "core" | "unowned";

export const quickFilterLabel: Record<QuickFilter, MessageDescriptor> = {
  unused: msg`Not in a domain yet`,
  core: msg`AI tools`,
  unowned: msg`No owner`,
};

export const quickFilters: readonly QuickFilter[] = [
  "unused",
  "core",
  "unowned",
];

export type UsersBucket = "lt10" | "10to50" | "50to100" | "gte100";

export const usersBucketLabel: Record<UsersBucket, MessageDescriptor> = {
  lt10: msg`Fewer than 10 users`,
  "10to50": msg`10 to 49 users`,
  "50to100": msg`50 to 99 users`,
  gte100: msg`100 users or more`,
};

export const usersBuckets: readonly UsersBucket[] = [
  "lt10",
  "10to50",
  "50to100",
  "gte100",
];

/** Every facet is a set of choices; an empty set means that facet does not filter. */
export interface LandscapeFilters {
  show: QuickFilter[];
  aiType: AiType[];
  dataExposure: DataExposureType[];
  users: UsersBucket[];
  /** Owner names, or "unowned". */
  owner: string[];
  /** App IDs. */
  app: string[];
}

export const noFilters: LandscapeFilters = {
  show: [],
  aiType: [],
  dataExposure: [],
  users: [],
  owner: [],
  app: [],
};

export const activeFilterCount = ({
  show,
  aiType,
  dataExposure,
  users,
  owner,
  app,
}: LandscapeFilters): number =>
  show.length +
  aiType.length +
  dataExposure.length +
  users.length +
  owner.length +
  app.length;

/** Whether a count is in the bucket; a count nothing measured is in none. */
const inBucket = (users: number | null, bucket: UsersBucket): boolean => {
  if (users === null) {
    return false;
  }
  switch (bucket) {
    case "lt10": {
      return users < 10;
    }
    case "10to50": {
      return users >= 10 && users < 50;
    }
    case "50to100": {
      return users >= 50 && users < 100;
    }
    case "gte100": {
      return users >= 100;
    }
    default: {
      return bucket satisfies never;
    }
  }
};

const matchesQuickFilter = (
  app: LandscapeApp,
  filter: QuickFilter
): boolean => {
  switch (filter) {
    case "unused": {
      // Engines that couldn't be read aren't known to be none.
      return app.use.engines?.length === 0;
    }
    case "core": {
      return app.aiType === "Core";
    }
    case "unowned": {
      return app.owner === null;
    }
    default: {
      return filter satisfies never;
    }
  }
};

/**
 * Quick filters all have to hold; within the other facets any choice
 * matches. A search matches the name, vendor, category or AI type, the
 * last as the reader sees it.
 */
export const matchesLandscape = (
  app: LandscapeApp,
  filters: LandscapeFilters,
  query: string
): boolean => {
  if (!filters.show.every((filter) => matchesQuickFilter(app, filter))) {
    return false;
  }
  if (filters.aiType.length > 0 && !filters.aiType.includes(app.aiType)) {
    return false;
  }
  if (
    filters.dataExposure.length > 0 &&
    !filters.dataExposure.some(
      (type) => app.dataExposure?.includes(type) === true
    )
  ) {
    return false;
  }
  if (
    filters.users.length > 0 &&
    !filters.users.some((bucket) => inBucket(app.users, bucket))
  ) {
    return false;
  }
  if (
    filters.owner.length > 0 &&
    !filters.owner.includes(app.owner ?? "unowned")
  ) {
    return false;
  }
  if (filters.app.length > 0 && !filters.app.includes(app.id)) {
    return false;
  }
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") {
    return true;
  }
  return [app.name, app.vendor, app.category, i18n._(aiTypeLabel[app.aiType])]
    .filter((field): field is string => field !== null)
    .some((field) => field.toLocaleLowerCase().includes(needle));
};

/* ── Sorting ─────────────────────────────────────────────────────────── */

export type SortKey = "name" | "users" | "owner";

export interface LandscapeSort {
  key: SortKey;
  dir: "asc" | "desc";
}

/** Ascending, then descending, then back to the original order. */
export const nextSort = (
  current: LandscapeSort | null,
  key: SortKey
): LandscapeSort | null => {
  if (current?.key !== key) {
    return { key, dir: "asc" };
  }
  return current.dir === "asc" ? { key, dir: "desc" } : null;
};

const compareBy = (
  key: SortKey,
  one: LandscapeApp,
  other: LandscapeApp
): number => {
  switch (key) {
    case "name": {
      return one.name.localeCompare(other.name);
    }
    case "users": {
      // Unknown counts are put last before the direction applies (sortApps).
      return (one.users ?? 0) - (other.users ?? 0);
    }
    case "owner": {
      // Apps without an owner go last when ascending.
      if (one.owner === null || other.owner === null) {
        return (one.owner === null ? 1 : 0) - (other.owner === null ? 1 : 0);
      }
      return one.owner.localeCompare(other.owner);
    }
    default: {
      return key satisfies never;
    }
  }
};

export const sortApps = (
  apps: readonly LandscapeApp[],
  sort: LandscapeSort | null
): LandscapeApp[] => {
  if (sort === null) {
    return [...apps];
  }
  // Apps whose usage nothing measures go last either way: an unknown count
  // is neither the most nor the least.
  const unknown = (app: LandscapeApp) =>
    sort.key === "users" && app.users === null ? 1 : 0;
  return apps.toSorted(
    (one, other) =>
      unknown(one) - unknown(other) ||
      (sort.dir === "asc"
        ? compareBy(sort.key, one, other)
        : compareBy(sort.key, other, one))
  );
};

/* ── Columns ─────────────────────────────────────────────────────────── */

export type ColumnKey =
  | "aiType"
  | "source"
  | "processes"
  | "dataExposure"
  | "users"
  | "owner";

export const columnLabel: Record<ColumnKey, MessageDescriptor> = {
  aiType: msg`AI type`,
  source: msg({
    message: "Source",
    context: "column: how Grasp knows an app is used",
  }),
  processes: msg`Used in`,
  dataExposure: msg`Data exposure`,
  users: msg`Users`,
  owner: msg`Owner`,
};

export interface Column {
  key: ColumnKey;
  visible: boolean;
}

export const defaultColumns: Column[] = [
  { key: "aiType", visible: true },
  { key: "source", visible: true },
  { key: "processes", visible: true },
  { key: "dataExposure", visible: true },
  { key: "users", visible: true },
  { key: "owner", visible: true },
];

/** Moves the column at `from` to `to`, keeping the others in order. */
export const moveColumn = (
  columns: readonly Column[],
  from: number,
  to: number
): Column[] => {
  const next = [...columns];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) {
    return next;
  }
  next.splice(to, 0, moved);
  return next;
};

/* ── Export ──────────────────────────────────────────────────────────── */

const formulaStart = /^\s*[=+\-@]|^[\t\r]/u;
const csvSpecial = /[",\r\n]/u;

/** One cell, quoted where it has to be and safe to open in a spreadsheet. */
const csvCell = (value: string): string => {
  const safe = formulaStart.test(value) ? `'${value}` : value;
  return csvSpecial.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

/** Rows as CSV, each cell quoted where it has to be. */
export const toCsv = (rows: readonly (readonly string[])[]): string =>
  rows.map((row) => row.map(csvCell).join(",")).join("\n");

/** What the export says of the data an app touches. */
const exposureText = (types: DataExposureType[] | null): string => {
  if (types === null) {
    return "";
  }
  if (types.length === 0) {
    return t({ message: "None", context: "no data exposure" });
  }
  return formatList(
    sortedExposure(types).map((type) => i18n._(exposureMeta[type].label))
  );
};

/** Every app in view, one row each, in the reader's language. */
export const landscapeCsv = (apps: readonly LandscapeApp[]): string =>
  toCsv([
    [
      t`App name`,
      t`Vendor`,
      t`Category`,
      t`AI type`,
      t`Data exposure`,
      t`Users`,
      t`Owner`,
      t`Description`,
    ],
    ...apps.map((app) => [
      app.name,
      app.vendor ?? "",
      app.category ?? "",
      i18n._(aiTypeLabel[app.aiType]),
      exposureText(app.dataExposure),
      app.users === null ? "" : String(app.users),
      app.owner ?? "",
      app.description ?? "",
    ]),
  ]);

/* ── Mosaic ──────────────────────────────────────────────────────────── */

export interface MosaicGroup {
  category: string;
  /** Its apps' users together; null when nothing measures any of theirs. */
  users: number | null;
  apps: { app: LandscapeApp; weight: number }[];
}

/** A count to rank by: one nothing measured weighs as none, so it never outranks one seen. */
const seen = (users: number | null): number => users ?? 0;

/** Apps grouped by category, the most used category and app first. Every app gets some room. */
export const mosaicGroups = (apps: readonly LandscapeApp[]): MosaicGroup[] => {
  const groups = new Map<string, LandscapeApp[]>();
  for (const app of apps) {
    const named = app.category?.trim() ?? "";
    const category = named === "" ? t`Uncategorized` : named;
    groups.set(category, [...(groups.get(category) ?? []), app]);
  }
  return [...groups]
    .map(([category, members]) => {
      const counted = members.flatMap(({ users }) =>
        users === null ? [] : [users]
      );
      return {
        category,
        users:
          counted.length === 0
            ? null
            : counted.reduce((sum, users) => sum + users, 0),
        apps: members
          .toSorted(
            (one, other) =>
              seen(other.users) - seen(one.users) ||
              one.name.localeCompare(other.name)
          )
          .map((app) => ({ app, weight: Math.max(seen(app.users), 3) })),
      };
    })
    .toSorted(
      (one, other) =>
        seen(other.users) - seen(one.users) ||
        one.category.localeCompare(other.category)
    );
};
