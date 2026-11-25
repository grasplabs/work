import {
  catalogGroupOf,
  catalogLogoUrl,
  catalogToolsRequestSchema,
  composioToolkitSchema,
  connectErrors,
  connectionErrors,
  firstSentence,
  oauthProviderSchema,
} from "@grasp-os/shared/connect";
import type {
  Catalog,
  CatalogAuth,
  CatalogEntry,
  CatalogTool,
  OAuthProvider,
  ToolkitKeyField,
} from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { errorFields, log } from "@grasp-os/shared/log";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { nativeConnector } from "./bundled-connectors.ts";
import { ComposioError, composioKey, composioRequest } from "./composio.ts";
import { connectorRow } from "./connector-providers.ts";
import { connectors } from "./db/schema.ts";
import { providers } from "./providers.ts";

// The catalog: what an admin can connect. The native providers come from
// this release (src/providers.ts and their connectors' manifests); Composio's
// toolkits from Composio's API, with connect's key. Each entry is marked with
// who carries out its actions, and so who holds its tokens: connect
// (`native`) or Composio's cloud (`composio`). What Composio lists is kept
// for ten minutes (`cachedIn`), and only asked for while connect has its
// key.

/**
 * How native providers are shown in the catalog. Both suites are first
 * mail and calendar to the people connecting them, so that is their group,
 * whatever their categories would say. They carry no description: the web
 * words them in each of its languages, by their ids.
 */
const nativeShown: Record<
  OAuthProvider,
  Pick<CatalogEntry, "name" | "categories" | "products" | "group">
> = {
  microsoft: {
    name: "Microsoft 365",
    categories: ["Productivity"],
    products: ["Outlook", "OneDrive", "SharePoint"],
    group: "Email and calendar",
  },
  google: {
    name: "Google Workspace",
    categories: ["Productivity"],
    products: ["Gmail", "Google Calendar", "Google Drive"],
    group: "Email and calendar",
  },
};

/**
 * What a connection reaches, as people know it: a native connection's
 * provider by the name the catalog shows, a Composio connection's toolkit
 * by its slug (its name is Composio's to list, and not asked for here). By
 * the connection's kind, never the provider alone: a toolkit slugged
 * `google` isn't shown as our Google Workspace connector.
 */
export const providerName = ({
  serverKind,
  provider,
}: {
  serverKind: "native" | "composio" | "http" | "connector";
  provider: string;
}): string => {
  const native = oauthProviderSchema.safeParse(provider);
  return serverKind === "native" && native.success
    ? nativeShown[native.data].name
    : provider;
};

/** The native providers whose connector is in this release. */
const nativeEntries = (): CatalogEntry[] =>
  oauthProviderSchema.options.flatMap((id) => {
    const connector = nativeConnector(providers[id].server);
    if (connector === undefined) {
      return [];
    }
    return [
      {
        source: "native",
        id,
        ...nativeShown[id],
        toolCount: Object.keys(connector.manifest.actions).length,
        logo: null,
        description: null,
        // Connect holds the deployment's own app for each provider.
        auth: "managed",
      },
    ];
  });

/**
 * How much of one of Composio's lists is read for one answer: pages of
 * `pageSize` items, at most `maxPages` of them. Toolkits come in Composio's
 * largest pages; tools, which carry their input schemas, in smaller ones.
 */
interface Paging {
  pageSize: number;
  maxPages: number;
}

const toolkitPaging: Paging = { pageSize: 1000, maxPages: 5 };
const toolPaging: Paging = { pageSize: 200, maxPages: 25 };

/**
 * How long what Composio listed is kept: its catalog changes rarely, and
 * the Integrations page shouldn't ask Composio every time it opens.
 */
const cacheTtlMs = 10 * 60 * 1000;

/** Most answers kept in each cache: about one per toolkit people look at. */
const maxCached = 100;

interface Cached<Value> {
  expiresAt: number;
  value: Value;
}

// Per isolate, keyed by the SHA-256 of connect's Composio key (a rotated
// key starts afresh) and what was listed. Only answers are kept: a failure
// is asked again next time. A load under way is never kept for another
// request to await: its promise settles only in the request that began it,
// so once that request ends early (its caller gave up) every later one
// would wait on a promise that never settles. People looking at once each
// ask Composio.
type Cache<Value> = Map<string, Cached<Value>>;

/**
 * A toolkit in the catalog, and where Composio serves its logo, which only
 * connect fetches (src/logos.ts): the entry names core's address for it.
 */
export interface ListedToolkit {
  entry: CatalogEntry;
  logoSource: URL | undefined;
}

const toolkitCache: Cache<ListedToolkit[]> = new Map();
const toolCache: Cache<CatalogTool[]> = new Map();

/** Forgets everything cached, so the next answer comes from Composio. */
export const forgetComposioCatalog = (): void => {
  toolkitCache.clear();
  toolCache.clear();
};

/** Stores `value` under `id`, dropping expired entries, then the oldest. */
const store = <Value>(cache: Cache<Value>, id: string, value: Value): void => {
  const now = Date.now();
  for (const [each, { expiresAt }] of cache) {
    if (expiresAt <= now) {
      cache.delete(each);
    }
  }
  cache.delete(id);
  const [oldest] = cache.keys();
  if (cache.size >= maxCached && oldest !== undefined) {
    cache.delete(oldest);
  }
  cache.set(id, { expiresAt: now + cacheTtlMs, value });
};

/**
 * The value `load` gives for `name` under `key`, from `cache` while it is
 * fresh, or however old with `lastKept`. A failed load is never kept.
 */
const cachedIn = async <Value>(
  cache: Cache<Value>,
  key: string,
  name: string,
  load: () => Promise<Value>,
  { lastKept = false }: { lastKept?: boolean } = {}
): Promise<Value> => {
  const id = `${await sha256Hex(key)}:${name}`;
  const hit = cache.get(id);
  if (hit !== undefined && (lastKept || hit.expiresAt > Date.now())) {
    return hit.value;
  }
  const value = await load();
  store(cache, id, value);
  return value;
};

/**
 * A page of one of Composio's lists. Items are checked one at a time, so
 * one Composio can't read leaves the others listed.
 */
const pageSchema = z.object({
  items: z.array(z.unknown()),
  next_cursor: z.string().min(1).nullish(),
});

const toolkitSchema = z.object({
  slug: composioToolkitSchema,
  name: z.string().min(1).max(256),
  /** Every auth scheme it takes ({@link keySchemes} among them, say). */
  auth_schemes: z.array(z.string()).default([]),
  /** The auth schemes Composio holds an app for: connectable without one of ours. */
  composio_managed_auth_schemes: z.array(z.string()).default([]),
  /** Whether it takes no account at all: then there is nothing to connect. */
  no_auth: z.boolean().nullish(),
  meta: z
    .object({
      categories: z.array(z.unknown()).default([]),
      tools_count: z.number().int().nonnegative().default(0),
      /** Read on its own (`descriptionOf`): a bad one leaves the toolkit listed. */
      description: z.unknown().optional(),
      /** Read on its own (`logoSourceOf`): a bad one leaves the toolkit listed. */
      logo: z.unknown().optional(),
    })
    .default({ categories: [], tools_count: 0 }),
});

/** The only host connect fetches Composio's logos from. */
export const composioLogoHost = "logos.composio.dev";

/**
 * Where Composio says a toolkit's logo is, if that is on its logo host
 * over https: any other address is none, so connect never fetches from a
 * host Composio's answer chose.
 */
const logoSourceOf = (logo: unknown): URL | undefined => {
  if (typeof logo !== "string" || !URL.canParse(logo)) {
    return undefined;
  }
  const url = new URL(logo);
  const onLogoHost =
    url.protocol === "https:" &&
    url.host === composioLogoHost &&
    url.username === "" &&
    url.password === "";
  return onLogoHost ? url : undefined;
};

const categorySchema = z.object({ name: z.string().min(1).max(128) });

/**
 * Longest description of Composio's that is read: an entry carries only
 * its first sentence, and anything longer than this is no description.
 */
const descriptionSchema = z.string().max(4096);

/** A toolkit's description as its entry carries it, if it has one. */
const descriptionOf = (description: unknown): string | null => {
  const parsed = descriptionSchema.safeParse(description);
  return parsed.success ? firstSentence(parsed.data) : null;
};

const toolSchema = z.object({
  slug: z.string().min(1).max(256),
  description: z.string().max(4096).nullish(),
  /** Its input's JSON Schema, of which only the property names are read. */
  input_parameters: z
    .object({ properties: z.record(z.string(), z.unknown()).optional() })
    .nullish(),
  /** Its behaviour tags, read on their own ({@link tagsSchema}). */
  tags: z.unknown().optional(),
  /** Whether Composio is retiring it, read on its own (`isDeprecated`). */
  is_deprecated: z.unknown().optional(),
});

/**
 * A tool's behaviour tags, of which only {@link readOnlyTag} is read. Tags
 * connect can't read (not strings, too long, too many) count as none: the
 * tool is still listed, as one that changes things.
 */
const tagsSchema = z.array(z.string().max(128)).max(64);

/** Composio's tag for a tool that reads, searches or lists and changes nothing. */
const readOnlyTag = "readOnlyHint";

/**
 * Every item of one of Composio's lists at `path`, page after page, as
 * far as `paging` goes, each item as `schema` reads it; items it can't read
 * are left out. A list longer than `paging` allows is a failure: half a
 * catalog would look like all of it.
 */
const composioList = async <Item>(
  key: string,
  path: string,
  schema: z.ZodType<Item>,
  { pageSize, maxPages }: Paging
): Promise<Item[]> => {
  const items: Item[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({ limit: String(pageSize) });
    if (cursor !== undefined) {
      query.set("cursor", cursor);
    }
    const separator = path.includes("?") ? "&" : "?";
    // oxlint-disable-next-line no-await-in-loop -- pages come one after another
    const { items: listed, next_cursor: next } = await composioRequest(key, {
      path: `${path}${separator}${query.toString()}`,
      schema: pageSchema,
    });
    for (const item of listed) {
      const parsed = schema.safeParse(item);
      if (parsed.success) {
        items.push(parsed.data);
      }
    }
    cursor = next ?? undefined;
    if (cursor === undefined) {
      return items;
    }
  }
  throw new ComposioError(`${path} is longer than connect reads`);
};

/**
 * Whether a toolkit is in the catalog: it has tools, so connecting it
 * could do something, and it takes an account, so there is something to
 * connect. Whether Composio holds an app for it is said by its entry's
 * `auth` (`authOf`), not by leaving it out: people see every app Grasp
 * could reach, and which need their own sign-in app.
 */
const isListed = ({
  no_auth: noAuth,
  meta,
}: z.infer<typeof toolkitSchema>): boolean =>
  noAuth !== true && meta.tools_count > 0;

/**
 * The schemes in which a toolkit takes a key, a token or a username and
 * password that an admin types in, and no app at all: the ones Composio
 * supports besides OAuth, in the order connect prefers them.
 */
export const keySchemes = ["API_KEY", "BEARER_TOKEN", "BASIC"] as const;

export type KeyScheme = (typeof keySchemes)[number];

/**
 * Which of {@link keySchemes} Composio's `scheme` names, if any, whatever
 * its case: its toolkit list names schemes in lower case (`api_key`), its
 * toolkit descriptions in upper case (`API_KEY`).
 */
const keySchemeOf = (scheme: string): KeyScheme | undefined =>
  keySchemes.find((each) => each === scheme.toUpperCase());

/**
 * What connecting a toolkit takes: signing in with Composio's app, where
 * it holds one (managed auth), so an admin needs nothing but their
 * consent; else a key the admin types in, where it takes one; else an
 * OAuth app of the organization's own, which Grasp can't take.
 */
const authOf = ({
  composio_managed_auth_schemes: managed,
  auth_schemes: schemes,
}: z.infer<typeof toolkitSchema>): CatalogAuth => {
  if (managed.length > 0) {
    return "managed";
  }
  return schemes.some((scheme) => keySchemeOf(scheme) !== undefined)
    ? "key"
    : "own";
};

/** Composio's toolkits in the catalog (`isListed`). */
const composioEntries = async (key: string): Promise<ListedToolkit[]> => {
  const toolkits = await composioList(
    key,
    "/toolkits?sort_by=alphabetically",
    toolkitSchema,
    toolkitPaging
  );
  return toolkits.filter(isListed).map((toolkit) => {
    const { slug, name, meta } = toolkit;
    const logoSource = logoSourceOf(meta.logo);
    const categories = meta.categories.flatMap((category) => {
      const parsed = categorySchema.safeParse(category);
      return parsed.success ? [parsed.data.name] : [];
    });
    return {
      entry: {
        source: "composio",
        id: slug,
        name,
        categories,
        toolCount: meta.tools_count,
        logo:
          logoSource === undefined ? null : catalogLogoUrl("composio", slug),
        description: descriptionOf(meta.description),
        group: catalogGroupOf(categories),
        auth: authOf(toolkit),
      },
      logoSource,
    };
  });
};

/**
 * Composio's toolkits in the catalog, as cached. Throws
 * {@link ComposioError} when Composio doesn't list them completely.
 */
export const listedToolkits = async (key: string): Promise<ListedToolkit[]> =>
  await cachedIn(
    toolkitCache,
    key,
    "toolkits",
    async () => await composioEntries(key)
  );

/**
 * Composio's toolkits as last listed, however long ago, listed now only
 * when none are kept: for a logo's address, which changes rarely. A page
 * asks for every logo it shows at once, each in a request of its own; were
 * each to list the toolkits afresh once the list had gone stale, a
 * screenful of logos would read Composio's whole list that many times.
 * The catalog's own read, which the page makes first, keeps it current in
 * the isolate that read lands on; in another, the list is as old as that
 * isolate's last listing, and a toolkit added since has no logo there.
 */
export const lastListedToolkits = async (
  key: string
): Promise<ListedToolkit[]> =>
  await cachedIn(
    toolkitCache,
    key,
    "toolkits",
    async () => await composioEntries(key),
    { lastKept: true }
  );

/**
 * The connectors admins made from an MCP server's URL
 * (mcp-connectors.ts), by name: what connecting one takes is signing in at
 * its server, or a key its server takes in a header. Its tools are listed
 * only to a connection, so none are counted here.
 */
const connectorEntries = async (env: Env): Promise<CatalogEntry[]> => {
  const rows = await drizzle(env.DB)
    .select({ id: connectors.id, name: connectors.name, auth: connectors.auth })
    .from(connectors)
    .orderBy(connectors.name, connectors.id);
  return rows.map(({ id, name, auth }) => ({
    source: "connector",
    id,
    name,
    categories: [],
    toolCount: null,
    logo: null,
    description: null,
    group: catalogGroupOf([]),
    auth: auth === "header" ? "key" : "managed",
  }));
};

/** The catalog, as `ConnectApi.catalog` describes it. */
export const catalog = async (env: Env): Promise<Catalog> => {
  const own = [...nativeEntries(), ...(await connectorEntries(env))];
  const key = composioKey(env);
  if (key === undefined) {
    return { entries: own, composio: "off" };
  }
  try {
    const toolkits = await listedToolkits(key);
    return {
      entries: [...own, ...toolkits.map(({ entry }) => entry)],
      composio: "listed",
    };
  } catch (error) {
    if (!(error instanceof ComposioError)) {
      throw error;
    }
    log.warn("catalog.composio_unavailable", errorFields(error));
    return { entries: own, composio: "unavailable" };
  }
};

/**
 * Whether Composio marks a tool deprecated, on its way out: such a tool is
 * neither listed nor allowed. A mark connect can't read counts as none,
 * so the tool stays listed.
 */
const isDeprecated = ({
  is_deprecated: deprecated,
}: z.infer<typeof toolSchema>): boolean => deprecated === true;

/** Whether connect can read the tool's mark: a boolean, as Composio documents it. */
const deprecationUnread = ({
  is_deprecated: deprecated,
}: z.infer<typeof toolSchema>): boolean => typeof deprecated !== "boolean";

/**
 * A listed Composio toolkit's tools, by the names its MCP server gives
 * them, as Composio lists them now, but for those it marks deprecated.
 */
const toolsOf = async (
  key: string,
  toolkit: string
): Promise<CatalogTool[]> => {
  const tools = await composioList(
    key,
    `/tools?${new URLSearchParams({ toolkit_slug: toolkit }).toString()}`,
    toolSchema,
    toolPaging
  );
  // Logged once per list, not per tool: a toolkit can hold a thousand.
  const unread = tools.filter(deprecationUnread);
  if (unread.length > 0) {
    log.warn("catalog.tool_deprecation_unreadable", {
      toolkit,
      tools: unread.length,
      first: unread[0]?.slug,
    });
  }
  return tools
    .filter((tool) => !isDeprecated(tool))
    .map(({ slug, description, input_parameters: input, tags }) => ({
      name: slug,
      description: description ?? null,
      inputs: Object.keys(input?.properties ?? {}),
      // Strictly the tag: a tool that says nothing isn't taken for a read.
      readOnly: tagsSchema.safeParse(tags).data?.includes(readOnlyTag) === true,
    }));
};

/**
 * What Composio says, as `load` reads it: `connect.catalog_unavailable`
 * when Composio doesn't list it completely (any failure, a 400 or 404 for
 * a toolkit it listed too).
 */
const fromComposio = async <Value>(
  load: () => Promise<Value>
): Promise<Value> => {
  try {
    return await load();
  } catch (error) {
    if (!(error instanceof ComposioError)) {
      throw error;
    }
    log.warn("catalog.composio_unavailable", errorFields(error));
    throw connectErrors.create("connect.catalog_unavailable");
  }
};

/**
 * The catalog's entry for the Composio toolkit `toolkit`, as cached:
 * `connect.catalog_entry_not_found` when the catalog doesn't list it, and
 * `connect.catalog_unavailable` when Composio doesn't list the catalog.
 */
export const composioEntry = async (
  key: string,
  toolkit: string
): Promise<CatalogEntry> =>
  await fromComposio(async () => {
    const listed = await listedToolkits(key);
    const found = listed.find(({ entry }) => entry.id === toolkit);
    if (found === undefined) {
      throw connectErrors.create("connect.catalog_entry_not_found");
    }
    return found.entry;
  });

/**
 * A Composio toolkit's tools, only for one the catalog lists, so the two
 * never disagree on what is in it: `connect.catalog_entry_not_found` for
 * any other, and `connect.catalog_unavailable` when Composio doesn't list
 * the catalog or the tools.
 */
export const composioTools = async (
  key: string,
  toolkit: string
): Promise<CatalogTool[]> => {
  await composioEntry(key, toolkit);
  return await fromComposio(
    async () =>
      await cachedIn(
        toolCache,
        key,
        `tools:${toolkit}`,
        async () => await toolsOf(key, toolkit)
      )
  );
};

/** One entry's tools, as `ConnectApi.catalogTools` describes them. */
export const catalogTools = async (
  env: Env,
  request: unknown
): Promise<CatalogTool[]> => {
  const parsed = catalogToolsRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const { source, id } = parsed.data;
  // A connector's server lists its tools only to a connection
  // (mcp-connectors.ts `currentTools`): its entry has none to show.
  if (source === "connector") {
    if ((await connectorRow(env.DB, id)) === undefined) {
      throw connectErrors.create("connect.catalog_entry_not_found");
    }
    return [];
  }
  if (source === "native") {
    const provider = Object.values(providers).find((each) => each.id === id);
    const connector =
      provider === undefined ? undefined : nativeConnector(provider.server);
    if (connector === undefined) {
      throw connectErrors.create("connect.catalog_entry_not_found");
    }
    return Object.entries(connector.manifest.actions).map(
      ([name, { description, input, readOnly }]) => ({
        name,
        description,
        inputs: input,
        readOnly,
      })
    );
  }
  const key = composioKey(env);
  const toolkit = composioToolkitSchema.safeParse(id);
  // Without a key, Composio's toolkits aren't in the catalog at all.
  if (key === undefined || !toolkit.success) {
    throw connectErrors.create("connect.catalog_entry_not_found");
  }
  return await composioTools(key, toolkit.data);
};

/**
 * One field of a toolkit's auth, as Composio describes it
 * (`GET /toolkits/{slug}`), with no limits of connect's own: Composio sets
 * none. One people never see (`user_visible`) takes Composio's default, so
 * it isn't asked for.
 */
const keyFieldSchema = z.object({
  name: z.string().min(1),
  displayName: z.string(),
  description: z.string().nullish(),
  is_secret: z.boolean().nullish(),
  user_visible: z.boolean().default(true),
});

/** A field Composio says people never see, whatever else it says of it. */
const hiddenFieldSchema = z.object({ user_visible: z.literal(false) });

const fieldListSchema = z.object({
  required: z.array(z.unknown()).default([]),
  optional: z.array(z.unknown()).default([]),
});

/** A toolkit, as Composio describes its auth, of which one scheme is read. */
const toolkitAuthSchema = z.object({
  auth_config_details: z
    .array(
      z.object({
        mode: z.string(),
        fields: z.object({ connected_account_initiation: fieldListSchema }),
      })
    )
    .default([]),
});

/** What an admin types to connect a toolkit, in the scheme connect takes. */
export interface KeyAuth {
  scheme: KeyScheme;
  fields: ToolkitKeyField[];
}

/**
 * The fields of `list` people see, each `required` as its list says, and
 * secret unless Composio says it isn't. A required one connect can't read
 * is `connect.catalog_unavailable`: left out, it would be missing from
 * every try. An optional one connect can't read is left out.
 */
const fieldsOf = (list: readonly unknown[], required: boolean) =>
  list.flatMap((item) => {
    const parsed = keyFieldSchema.safeParse(item);
    if (!parsed.success) {
      if (required && !hiddenFieldSchema.safeParse(item).success) {
        log.warn("catalog.key_field_unreadable", { list: "required" });
        throw connectErrors.create("connect.catalog_unavailable");
      }
      return [];
    }
    if (!parsed.data.user_visible) {
      return [];
    }
    const { name, displayName, description, is_secret: secret } = parsed.data;
    return [
      {
        name,
        label: displayName,
        description: description ?? null,
        required,
        secret: secret !== false,
      },
    ];
  });

/**
 * What an admin types to connect `toolkit` with a key, as Composio
 * describes it now: the first of {@link keySchemes} it takes, and the
 * fields its connected account takes in that scheme. Read fresh each
 * time, never cached: what connect accepts is what Composio asks for at
 * that moment. `connection.invalid` for one that signs in with Composio's
 * app; `connection.own_auth_required` for one that takes an app of its
 * own, or whose description has no such scheme;
 * `connect.catalog_unavailable` when Composio doesn't answer, or describes
 * a required field connect can't read.
 */
export const keyAuthOf = async (
  key: string,
  toolkit: string
): Promise<KeyAuth> => {
  const { auth } = await composioEntry(key, toolkit);
  if (auth !== "key") {
    throw connectionErrors.create(
      auth === "own" ? "connection.own_auth_required" : "connection.invalid"
    );
  }
  const { auth_config_details: details } = await fromComposio(
    async () =>
      await composioRequest(key, {
        path: `/toolkits/${encodeURIComponent(toolkit)}`,
        schema: toolkitAuthSchema,
      })
  );
  for (const scheme of keySchemes) {
    const detail = details.find(({ mode }) => keySchemeOf(mode) === scheme);
    if (detail !== undefined) {
      const { required, optional } = detail.fields.connected_account_initiation;
      return {
        scheme,
        fields: [...fieldsOf(required, true), ...fieldsOf(optional, false)],
      };
    }
  }
  throw connectionErrors.create("connection.own_auth_required");
};
