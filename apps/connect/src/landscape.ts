import { connectErrors, connectionErrors } from "@grasp-os/shared/connect";
import {
  landscapeErrors,
  landscapeLimits,
  landscapeProviderSchema,
  landscapeReadRequestSchema,
  landscapeScopePattern,
} from "@grasp-os/shared/landscape";
import type {
  LandscapeConnection,
  LandscapeGrant,
  LandscapeRead,
} from "@grasp-os/shared/landscape";
import { and, eq, inArray, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { connections } from "./db/schema.ts";
import { SourceError, readFromProvider, requestBudget } from "./event-kinds.ts";
import type { ProviderAccess } from "./event-kinds.ts";
import { accessTokenFor } from "./tokens.ts";

// The application landscape's reads (GRA-539): what a tenant's people
// granted which apps, from Microsoft Graph, with the landscape
// connection's token, which stays here. Core's sync asks for one read at
// a time and keeps what it answers. Threat model, before code:
//
// - A token reaching more than the landscape reads: its connection has an
//   Entra app of its own and is kept only with exactly its read scopes
//   (oauth.ts, `grantedAsAsked`); it takes no connector calls (call.ts);
//   and nothing but graph.microsoft.com is sent it: a cursor that isn't a
//   Graph link is refused before anything is sent.
// - Planted text: anyone in a tenant can register an app with any name
//   or publisher. Names are cut to `nameLength` and are only data: an app
//   is known by its client ID. Scopes that aren't plain permission names
//   are dropped. IDs that aren't GUIDs never reach a query.
// - Another tenant's data: only a landscape connection is read, and each
//   read says its tenant, which core checks against its own.
// - Personal data: a grant is read as its app, its consent, the person's
//   ID and name, and its scopes; nothing of sign-ins (where, which
//   device) is read at all.
// - A flood: one read asks for `grantsPerRead` grants and sends at most
//   `requestsPerRead` requests; core bounds the reads of a sync.

const graphHost = "graph.microsoft.com";
const hosts = [graphHost];
const v1 = `https://${graphHost}/v1.0`;

/** Graph, sent the token: only on its own host, over HTTPS. */
const graph = readFromProvider({ name: "Microsoft Graph", hosts });

/** IDs as Entra issues them: the only ones put in a query. */
const guidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Most IDs one `in` filter takes at Graph. */
const idsPerFilter = 15;

const grantSchema = z.object({
  clientId: z.string(),
  consentType: z.string(),
  principalId: z.string().nullish(),
  scope: z.string().nullish(),
});

const grantsPageSchema = z.object({
  value: z.array(grantSchema),
  "@odata.nextLink": z.string().optional(),
});

const servicePrincipalSchema = z.object({
  id: z.string(),
  appId: z.string(),
  displayName: z.string().nullish(),
  publisherName: z.string().nullish(),
  verifiedPublisher: z
    .object({
      displayName: z.string().nullish(),
      verifiedPublisherId: z.string().nullish(),
    })
    .nullish(),
});

const userSchema = z.object({
  id: z.string(),
  displayName: z.string().nullish(),
});

const listOf = <Item extends z.ZodType>(item: Item) =>
  z.object({ value: z.array(item) });

/** A name as kept: trimmed, at most `nameLength`, null when empty. */
const nameOf = (name: string | null | undefined): string | null => {
  const trimmed = (name ?? "").trim().slice(0, landscapeLimits.nameLength);
  return trimmed === "" ? null : trimmed;
};

/** A grant's scopes as kept: plain permission names, each once, bounded. */
const scopesOf = (scope: string | null | undefined): string[] =>
  [
    ...new Set(
      (scope ?? "")
        .split(" ")
        .filter(
          (each) =>
            each !== "" &&
            each.length <= landscapeLimits.scopeLength &&
            landscapeScopePattern.test(each)
        )
    ),
  ].slice(0, landscapeLimits.scopesPerGrant);

/** Whether `url` is a Graph link: the only cursor read on from. */
const isGraphLink = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === graphHost &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/v1.0/oauth2PermissionGrants"
    );
  } catch {
    return false;
  }
};

/** `ids` in pages Graph's `in` filter takes. */
const pagesOf = (ids: readonly string[]): string[][] => {
  const pages: string[][] = [];
  for (let start = 0; start < ids.length; start += idsPerFilter) {
    pages.push(ids.slice(start, start + idsPerFilter));
  }
  return pages;
};

/** Each item of `path` whose ID is among `ids`, read `select`ed, by ID. */
const byIds = async <Item extends z.ZodType<{ id: string }>>(
  access: ProviderAccess,
  path: string,
  select: string,
  item: Item,
  ids: readonly string[]
): Promise<Map<string, z.output<Item>>> => {
  const found = new Map<string, z.output<Item>>();
  for (const page of pagesOf(ids)) {
    const filter = `id in (${page.map((id) => `'${id}'`).join(",")})`;
    const url = `${v1}/${path}?$filter=${encodeURIComponent(filter)}&$select=${select}`;
    // oxlint-disable-next-line no-await-in-loop -- one request after another, within the read's budget
    const { value } = listOf(item).parse(await graph(access, url));
    for (const each of value) {
      if (ids.includes(each.id)) {
        found.set(each.id, each);
      }
    }
  }
  return found;
};

/** The landscape's connections still connected, for core's sync. */
export const landscapeConnections = async (
  env: Env
): Promise<LandscapeConnection[]> => {
  const rows = await drizzle(env.DB)
    .select({
      id: connections.id,
      provider: connections.provider,
      tenant: connections.tenant,
      status: connections.status,
    })
    .from(connections)
    .where(
      and(
        inArray(connections.provider, landscapeProviderSchema.options),
        ne(connections.status, "disconnected")
      )
    );
  return rows.flatMap(({ id, provider, tenant, status }) => {
    const known = landscapeProviderSchema.safeParse(provider);
    return known.success && tenant !== null && status !== "disconnected"
      ? [{ id, provider: known.data, tenant, status }]
      : [];
  });
};

/** The grants of one page, with their apps and people, merged by both. */
const grantsOf = (
  page: z.output<typeof grantsPageSchema>["value"],
  apps: ReadonlyMap<string, z.output<typeof servicePrincipalSchema>>,
  people: ReadonlyMap<string, z.output<typeof userSchema>>
): LandscapeGrant[] => {
  const merged = new Map<string, LandscapeGrant>();
  for (const { clientId, consentType, principalId, scope } of page) {
    const app = apps.get(clientId);
    const admin = consentType === "AllPrincipals";
    const personId = admin ? null : (principalId ?? null);
    if (app === undefined || (!admin && personId === null)) {
      continue;
    }
    const key = `${app.appId} ${personId ?? ""}`;
    const scopes = scopesOf(scope);
    const earlier = merged.get(key);
    if (earlier === undefined) {
      merged.set(key, {
        app: {
          id: app.appId,
          name: nameOf(app.displayName) ?? app.appId,
          publisher: nameOf(
            app.verifiedPublisher?.displayName ?? app.publisherName
          ),
          verified: (app.verifiedPublisher?.verifiedPublisherId ?? "") !== "",
        },
        consent: admin ? "admin" : "person",
        person:
          personId === null
            ? null
            : {
                id: personId,
                name: nameOf(people.get(personId)?.displayName),
              },
        scopes,
      });
    } else {
      earlier.scopes = [...new Set([...earlier.scopes, ...scopes])].slice(
        0,
        landscapeLimits.scopesPerGrant
      );
    }
  }
  return [...merged.values()];
};

/**
 * The connection's access token, renewed if it must be: a grant that ran
 * out is `landscape.inactive`, for an admin to reconnect; a renewal the
 * provider didn't answer is `landscape.provider_failed`, tried again later.
 */
const landscapeToken = async (
  env: Env,
  connectionId: string
): Promise<string> => {
  try {
    return await accessTokenFor(env, connectionId);
  } catch (error) {
    if (connectErrors.codeOf(error) === "connect.connection_inactive") {
      throw landscapeErrors.create("landscape.inactive");
    }
    if (connectionErrors.codeOf(error) !== undefined) {
      throw landscapeErrors.create("landscape.provider_failed");
    }
    throw error;
  }
};

/** Reads one page of a landscape connection's grants, from `cursor` on. */
export const readLandscape = async (
  env: Env,
  request: unknown
): Promise<LandscapeRead> => {
  const { connectionId, cursor } = landscapeErrors.parse(
    "landscape.not_found",
    landscapeReadRequestSchema,
    request
  );
  const connection = await drizzle(env.DB)
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  if (
    connection === undefined ||
    !landscapeProviderSchema.safeParse(connection.provider).success ||
    connection.tenant === null
  ) {
    throw landscapeErrors.create("landscape.not_found");
  }
  if (connection.status !== "active") {
    throw landscapeErrors.create("landscape.inactive");
  }
  if (cursor !== null && !isGraphLink(cursor)) {
    throw landscapeErrors.create("landscape.cursor_invalid");
  }
  const access: ProviderAccess = {
    token: await landscapeToken(env, connection.id),
    budget: requestBudget(landscapeLimits.requestsPerRead),
  };
  try {
    const page = grantsPageSchema.parse(
      await graph(
        access,
        cursor ??
          `${v1}/oauth2PermissionGrants?$top=${landscapeLimits.grantsPerRead}`
      )
    );
    // A page Graph sends past `$top` is held by the read's request budget.
    const grants = page.value;
    const clientIds = [
      ...new Set(grants.map(({ clientId }) => clientId)),
    ].filter((id) => guidPattern.test(id));
    const personIds = [
      ...new Set(grants.flatMap(({ principalId }) => principalId ?? [])),
    ].filter((id) => guidPattern.test(id));
    const apps = await byIds(
      access,
      "servicePrincipals",
      "id,appId,displayName,publisherName,verifiedPublisher",
      servicePrincipalSchema,
      clientIds
    );
    const people = await byIds(
      access,
      "users",
      "id,displayName",
      userSchema,
      personIds
    );
    const next = page["@odata.nextLink"] ?? null;
    // A link elsewhere is never kept, nor taken for the end.
    if (
      next !== null &&
      (!isGraphLink(next) || next.length > landscapeLimits.cursorLength)
    ) {
      throw landscapeErrors.create("landscape.provider_failed");
    }
    return {
      tenant: connection.tenant,
      grants: grantsOf(grants, apps, people),
      next,
    };
  } catch (error) {
    if (
      error instanceof SourceError &&
      (error.status === 429 || error.status === 503)
    ) {
      throw landscapeErrors.create(
        "landscape.throttled",
        error.retryAfterMs === undefined
          ? undefined
          : { retryAfterMs: error.retryAfterMs }
      );
    }
    if (error instanceof SourceError || error instanceof z.ZodError) {
      throw landscapeErrors.create("landscape.provider_failed");
    }
    throw error;
  }
};
