import type {
  CatalogSource,
  ListedConnection,
  OfferedCatalog,
} from "@grasp-os/shared/connect";

// Integrations, as the prototype lists them (`routes/integrations`): every
// app Grasp can work in, one per catalog entry, each with the connections
// made to it. A connection whose entry the catalog no longer lists to this
// person (no longer offered, or Composio not answering) is still one, under
// its provider's ID, so nothing connected goes missing from the page.

type Entry = OfferedCatalog["entries"][number];

/** One app Grasp can work in, and what is connected to it. */
export interface Integration {
  /** `source:id`, as the address names it. */
  key: string;
  source: CatalogSource;
  /** A native provider (`microsoft`), or a Composio toolkit's slug. */
  id: string;
  name: string;
  categories: string[];
  /** How many tools it has; unknown where the catalog doesn't list it. */
  toolCount: number | undefined;
  /** Whether people are offered it; an entry the catalog doesn't list counts as not. */
  offered: boolean;
  /** Whether the catalog lists it to this person. */
  listed: boolean;
  /** Its connections this person can see, newest first. */
  connections: ListedConnection[];
}

/** Where an integration stands, for the person looking at it. */
export type IntegrationState =
  | "needs_reauth"
  | "shared"
  | "personal"
  | "not_connected";

/** An integration's key in the address: `native:microsoft`. */
export const integrationKey = (source: CatalogSource, id: string): string =>
  `${source}:${id}`;

/** The integration a key in the address names, or none for one that names nothing. */
export const parseIntegrationKey = (
  key: string
): { source: CatalogSource; id: string } | undefined => {
  const [source, id, ...rest] = key.split(":");
  if (
    (source !== "native" && source !== "composio") ||
    id === undefined ||
    id === "" ||
    rest.length > 0
  ) {
    return undefined;
  }
  return { source, id };
};

const byNewest = (one: ListedConnection, other: ListedConnection): number =>
  other.createdAt.localeCompare(one.createdAt);

/**
 * Every integration: the catalog's entries in its order (native first),
 * then any connection's provider it doesn't list. Disconnected connections
 * are left out: they reach nothing.
 */
export const integrationsOf = (
  entries: readonly Entry[],
  connections: readonly ListedConnection[]
): Integration[] => {
  const live = connections.filter(({ status }) => status !== "disconnected");
  const of = (source: CatalogSource, id: string): ListedConnection[] =>
    live
      .filter(
        (connection) =>
          connection.source === source && connection.provider === id
      )
      .toSorted(byNewest);
  const listed: Integration[] = entries.map((entry) => ({
    key: integrationKey(entry.source, entry.id),
    source: entry.source,
    id: entry.id,
    name: entry.name,
    categories: entry.categories,
    toolCount: entry.toolCount,
    offered: entry.offered,
    listed: true,
    connections: of(entry.source, entry.id),
  }));
  const keys = new Set(listed.map(({ key }) => key));
  const unlisted = new Map<string, Integration>();
  for (const connection of live) {
    const key = integrationKey(connection.source, connection.provider);
    if (!keys.has(key) && !unlisted.has(key)) {
      unlisted.set(key, {
        key,
        source: connection.source,
        id: connection.provider,
        // The catalog alone has its name: its ID stands in.
        name: connection.provider,
        categories: [],
        toolCount: undefined,
        offered: false,
        listed: false,
        connections: of(connection.source, connection.provider),
      });
    }
  }
  return [...listed, ...unlisted.values()];
};

/**
 * Where `integration` stands: needing someone to sign in again wins, then
 * connected for everyone, then for this person alone.
 */
export const stateOf = ({ connections }: Integration): IntegrationState => {
  if (connections.some(({ status }) => status === "needs_reauth")) {
    return "needs_reauth";
  }
  if (connections.some(({ scope }) => scope === "shared")) {
    return "shared";
  }
  return connections.length > 0 ? "personal" : "not_connected";
};

/** What the list shows: everything, what is connected, what needs attention, or one category. */
export type IntegrationFilter =
  | { show: "all" }
  | { show: "connected" }
  | { show: "attention" }
  | { show: "category"; category: string };

/** Whether `integration` is one `filter` keeps. */
export const keeps = (
  filter: IntegrationFilter,
  integration: Integration
): boolean => {
  if (filter.show === "category") {
    return integration.categories.includes(filter.category);
  }
  const state = stateOf(integration);
  if (filter.show === "connected") {
    return state !== "not_connected";
  }
  return filter.show === "attention" ? state === "needs_reauth" : true;
};

/** Whether `integration` is what the search names: by name or kind (category), or its ID. */
export const matches = (integration: Integration, search: string): boolean => {
  const wanted = search.trim().toLocaleLowerCase();
  return [integration.name, integration.id, ...integration.categories].some(
    (text) => text.toLocaleLowerCase().includes(wanted)
  );
};

/** The catalog's categories, each with how many integrations it holds, by name. */
export const categoriesOf = (
  integrations: readonly Integration[],
  locale: string
): { category: string; count: number }[] => {
  const counts = new Map<string, number>();
  for (const { categories } of integrations) {
    for (const category of new Set(categories)) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([category, count]) => ({ category, count }))
    .toSorted((one, other) =>
      one.category.localeCompare(other.category, locale)
    );
};
