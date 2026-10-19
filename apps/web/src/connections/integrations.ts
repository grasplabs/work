import { catalogGroups } from "@grasp-os/shared/connect";
import type {
  CatalogAuth,
  CatalogGroup,
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
  /** Which of Grasp's kinds of app it is; `Other` where the catalog doesn't list it. */
  group: CatalogGroup;
  /** What it is for, in a sentence, where the catalog says. */
  description: string | null;
  /** Whose sign-in app connecting it takes; unknown where the catalog doesn't list it. */
  auth: CatalogAuth | undefined;
  /** Where core serves its logo, or `null`: its first letter stands in. */
  logo: string | null;
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
    group: entry.group,
    description: entry.description,
    auth: entry.auth,
    logo: entry.logo,
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
        group: "Other",
        description: null,
        auth: undefined,
        logo: null,
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

/** What the list shows, as in the prototype: everything, what is connected, or one kind of app. */
export type IntegrationFilter =
  | { show: "all" }
  | { show: "connected" }
  | { show: "group"; group: CatalogGroup };

/** Whether `integration` is one `filter` keeps. */
export const keeps = (
  filter: IntegrationFilter,
  integration: Integration
): boolean => {
  if (filter.show === "group") {
    return integration.group === filter.group;
  }
  return filter.show === "all" || stateOf(integration) !== "not_connected";
};

/** What kind of app it is, in the catalog's own words: its first category. */
export const kindOf = (integration: Integration): string | undefined =>
  integration.categories[0];

/**
 * The apps most companies look for first, in the order they are shown
 * before the rest of the alphabet, as the prototype has them
 * (`lib/integration-catalog.ts`): a list of 1,500 that opens on "0CodeKit"
 * says little about what is in it. Composio's slugs.
 */
const knownFirst = [
  "github",
  "googledocs",
  "outlook",
  "linear",
  "figma",
  "shopify",
  "calendly",
  "typeform",
  "canva",
  "pipedrive",
  "clickup",
  "discord",
  "linkedin",
  "youtube",
  "instagram",
  "facebook",
  "telegram",
  "twitter",
  "zoho",
  "box",
  "miro",
  "gitlab",
  "bitbucket",
  "supabase",
  "snowflake",
  "posthog",
  "mixpanel",
  "amplitude",
  "segment",
  "sendgrid",
  "klaviyo",
  "webflow",
  "freshdesk",
  "servicenow",
  "workday",
  "bamboohr",
  "personio",
  "gusto",
  "greenhouse",
  "lever",
  "ashby",
  "gong",
  "apollo",
  "attio",
  "close",
  "copper",
  "pandadoc",
  "dropbox_sign",
  "netsuite",
  "paypal",
  "square",
  "ramp",
  "brex",
  "wise",
  "tableau",
  "google_analytics",
  "googleads",
  "metaads",
  "tiktok",
  "reddit",
  "spotify",
  "todoist",
  "coda",
  "basecamp",
  "wrike",
  "harvest",
  "toggl",
  "sentry",
  "datadog",
  "pagerduty",
  "vercel",
  "cloudflare",
  "digital_ocean",
  "openai",
  "perplexityai",
  "elevenlabs",
  "brevo",
  "lemlist",
  "instantly",
] as const;
const knownAt = new Map<string, number>(knownFirst.map((id, at) => [id, at]));
const rankOf = ({ id }: Integration): number =>
  knownAt.get(id) ?? knownFirst.length;

/**
 * The integrations a search finds, as the prototype's `findApps`: by name
 * first, one that starts with what was typed before one that only holds it,
 * then by what they are for. Nothing typed: the well-known apps first, then
 * the rest in the catalog's order.
 */
export const find = (
  integrations: readonly Integration[],
  search?: string
): Integration[] => {
  const needle = (search ?? "").trim().toLocaleLowerCase();
  if (needle === "") {
    return integrations.toSorted((one, other) => rankOf(one) - rankOf(other));
  }
  const byName = integrations.filter(
    ({ name, id }) =>
      name.toLocaleLowerCase().includes(needle) ||
      id.toLocaleLowerCase().includes(needle)
  );
  const named = new Set(byName);
  const byUse = integrations.filter(
    (integration) =>
      !named.has(integration) &&
      [...integration.categories, integration.description ?? ""].some((text) =>
        text.toLocaleLowerCase().includes(needle)
      )
  );
  const starts = (integration: Integration): number =>
    Number(integration.name.toLocaleLowerCase().startsWith(needle));
  return [
    ...byName.toSorted((one, other) => starts(other) - starts(one)),
    ...byUse,
  ];
};

/**
 * One kind of app on the page: the company's own (connected) apps of it,
 * then the catalog's others.
 */
export interface IntegrationSection {
  group: CatalogGroup;
  own: Integration[];
  others: Integration[];
}

/**
 * The page's sections, as the prototype's: one per kind of app, in Grasp's
 * order, the connected apps first in each and the catalog's others after
 * them. Connected shows only what is connected; a kind shows only itself.
 */
export const sectionsOf = (
  integrations: readonly Integration[],
  filter: IntegrationFilter,
  search?: string
): IntegrationSection[] => {
  const found = find(
    integrations.filter((integration) => keeps(filter, integration)),
    search
  );
  return catalogGroups
    .map((group) => {
      const ofGroup = found.filter(
        (integration) => integration.group === group
      );
      return {
        group,
        own: ofGroup.filter(
          (integration) => stateOf(integration) !== "not_connected"
        ),
        others: ofGroup.filter(
          (integration) => stateOf(integration) === "not_connected"
        ),
      };
    })
    .filter(({ own, others }) => own.length + others.length > 0);
};

/** How many integrations each kind of app holds. */
export const countByGroup = (
  integrations: readonly Integration[]
): ReadonlyMap<CatalogGroup, number> => {
  const counts = new Map<CatalogGroup, number>();
  for (const { group } of integrations) {
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return counts;
};

/** A count rounded down to a round number, to say "more than" it: 1,487 is more than 1,400. */
export const roundedDown = (count: number): number => {
  let step = 10;
  if (count >= 1000) {
    step = 100;
  } else if (count >= 100) {
    step = 50;
  }
  return Math.floor(count / step) * step;
};
