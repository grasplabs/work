import {
  composioConsentText,
  composioToolName,
  composioToolsSchema,
  connectionCallbackPath,
  connectionErrors,
  changeToolkitToolsSchema,
  connectErrors,
  finishConnectionSchema,
  oauthFlowLifetimeMs,
  startToolkitConnectionSchema,
} from "@grasp-os/shared/connect";
import type {
  ComposioAccountState,
  ComposioToolRule,
  ConnectionPerson,
} from "@grasp-os/shared/connect";
import { randomToken, sha256Hex } from "@grasp-os/shared/encoding";
import { identifierSchema } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import {
  and,
  asc,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { recordEvents, recordEventsIf } from "./audit.ts";
import { composioEntry, composioTools } from "./catalog.ts";
import { ComposioError, composioKey, composioRequest } from "./composio.ts";
import {
  auditRefusal,
  connectionEvent,
  namesEventsMax,
  packedNames,
} from "./connection-audit.ts";
import { isComposioServerUrl } from "./connections.ts";
import type { Connection } from "./connections.ts";
import {
  composioCleanups,
  composioFlows,
  composioToolSends,
  connections,
  pendingActions,
} from "./db/schema.ts";
import { dropPendingActions } from "./pending.ts";

// Connecting a Composio toolkit: one shared connection per toolkit, scoped
// to the tools the admin allows. Composio holds its tokens, in its cloud,
// so an admin connects it only after consenting to exactly that
// (`composioConsentText`), and their consent goes into the audit log with
// who gave it (threat model CN19).
//
// Starting makes, at Composio, an auth config for the toolkit (Composio's
// own app for it) and a connected account for this deployment's Composio
// user, and sends the admin's browser to Composio's auth link. Composio
// sends it back to core's callback, with the flow's `state`, as a
// provider's OAuth flow does; the flow finishes only for the admin who
// started it, as an OAuth flow does (CN4). Finishing checks the account is
// the one this flow made, active, for this toolkit, then makes an MCP
// server at Composio with only that toolkit's auth config and the allowed
// tools, and stores the connection with that server's URL for that one
// connected account: never Composio's single Tool Router URL.
//
// Whatever goes wrong after something was made at Composio, it is deleted
// there again. What Composio doesn't take, or what can't be deleted while
// connect has no key, is recorded and tried again by the clock,
// waiting longer each time, until it is gone: a flow that didn't finish, or
// a disconnected connection, leaves no account behind for long.

type ToolkitFlow = typeof composioFlows.$inferSelect;

/**
 * This deployment's one Composio user, whose connected accounts all its
 * Composio connections are: its origin's host. A Composio project may
 * serve more than one deployment, and the host tells their users apart.
 */
const composioUserOf = (origin: string): string => new URL(origin).host;

const idSchema = identifierSchema;

const authConfigSchema = z.object({
  auth_config: z.object({ id: idSchema }),
});

const linkSchema = z.object({
  redirect_url: z.url({ protocol: /^https$/u }),
  connected_account_id: idSchema,
});

const connectedAccountSchema = z.object({
  id: idSchema,
  status: z.string(),
  toolkit: z.object({ slug: z.string() }),
  auth_config: z.object({ id: idSchema }),
});

const mcpServerSchema = z.object({ id: idSchema });

const mcpUrlsSchema = z.object({
  connected_account_urls: z.array(z.string()),
});

/** What Composio answers to a deletion: whatever it is, it's not read. */
const anyAnswer = z.unknown();

/** What connect made at Composio for one connection or flow. */
interface AtComposio {
  serverId?: string | null;
  connectedAccountId?: string | null;
  authConfigId?: string | null;
}

/** What connect made at Composio, by the area of Composio's API it's in. */
const areas = [
  ["serverId", "mcp"],
  ["connectedAccountId", "connected_accounts"],
  ["authConfigId", "auth_configs"],
] as const;

type Area = (typeof areas)[number][1];

/** One thing at Composio to delete: its area and its ID. */
type Target = readonly [Area, string];

const targetsOf = (made: AtComposio): Target[] =>
  areas.flatMap(([field, area]) => {
    const id = made[field];
    return id === undefined || id === null ? [] : [[area, id] as const];
  });

/**
 * The marker everything a flow makes at Composio carries in its name,
 * found by it even when no ID of it was recorded: `grasp-` and the first
 * 24 hex digits of the flow ID, 30 characters, as Composio allows for an
 * MCP server's name. `handOverFlows` computes the same in SQL.
 */
export const markerOf = (flowId: string): string =>
  `grasp-${flowId.replaceAll("-", "").slice(0, 24)}`;

const listSchema = z.object({ items: z.array(z.unknown()) });
const namedSchema = z.object({ id: idSchema, name: z.string().nullish() });

/** Most things of one kind a marker is looked up for: it names one flow's. */
const markedMax = 50;

/** The IDs of the items of the list at `path`, those `keep` keeps. */
const listedIds = async (
  key: string,
  path: string,
  keep: (item: z.infer<typeof namedSchema>) => boolean = () => true
): Promise<string[]> => {
  const { items } = await composioRequest(key, { path, schema: listSchema });
  return items.flatMap((item) => {
    const parsed = namedSchema.safeParse(item);
    return parsed.success && keep(parsed.data) ? [parsed.data.id] : [];
  });
};

/**
 * Everything at Composio that carries `marker`: auth configs and MCP
 * servers by their name, which Composio can filter by, and the connected
 * accounts of those auth configs, which it can filter by too. `undefined`
 * when Composio doesn't answer: then not everything may be found.
 */
const findMarked = async (
  key: string,
  marker: string
): Promise<Target[] | undefined> => {
  const query = (params: Record<string, string>) =>
    new URLSearchParams({ ...params, limit: String(markedMax) }).toString();
  const named = ({ name }: z.infer<typeof namedSchema>) => name === marker;
  try {
    const authConfigs = await listedIds(
      key,
      `/auth_configs?${query({ search: marker })}`,
      named
    );
    const servers = await listedIds(
      key,
      `/mcp/servers?${query({ name: marker })}`,
      named
    );
    const accounts: string[] = [];
    for (const authConfig of authConfigs) {
      accounts.push(
        // oxlint-disable-next-line no-await-in-loop -- one flow has one auth config
        ...(await listedIds(
          key,
          `/connected_accounts?${query({ auth_config_ids: authConfig })}`
        ))
      );
    }
    return [
      ...servers.map((id) => ["mcp", id] as const),
      ...accounts.map((id) => ["connected_accounts", id] as const),
      ...authConfigs.map((id) => ["auth_configs", id] as const),
    ];
  } catch (error) {
    if (!(error instanceof ComposioError)) {
      throw error;
    }
    log.warn("composio.find_marked_failed", errorFields(error));
    return undefined;
  }
};

/**
 * Deletes `targets` at Composio, servers first, then accounts (which
 * deletes their tokens), then auth configs. What Composio no longer has
 * (404) is gone. Each failure is logged and never thrown: what is left.
 */
const deleteAtComposio = async (
  key: string,
  targets: readonly Target[]
): Promise<Target[]> => {
  const order = (area: Area) => areas.findIndex(([, each]) => each === area);
  const unique = [
    ...new Map(targets.map((each) => [each.join(":"), each])).values(),
  ];
  unique.sort(([a], [b]) => order(a) - order(b));
  const left: Target[] = [];
  for (const target of unique) {
    const [area, id] = target;
    try {
      // oxlint-disable-next-line no-await-in-loop -- the server before the account it serves
      await composioRequest(key, {
        method: "DELETE",
        path: `/${area}/${encodeURIComponent(id)}`,
        schema: anyAnswer,
      });
    } catch (error) {
      if (!(error instanceof ComposioError && error.status === 404)) {
        log.warn("composio.delete_failed", { area, ...errorFields(error) });
        left.push(target);
      }
    }
  }
  return left;
};

/**
 * Deletes at Composio what `made` names and, with a `marker`, everything
 * that carries it (found first, so an auth config's accounts are found
 * before it goes). `complete` only when everything was found and deleted.
 */
const settleAtComposio = async (
  key: string,
  made: AtComposio,
  marker: string | null
): Promise<{ left: Target[]; complete: boolean }> => {
  const marked = marker === null ? [] : await findMarked(key, marker);
  const left = await deleteAtComposio(key, [
    ...targetsOf(made),
    ...(marked ?? []),
  ]);
  return { left, complete: marked !== undefined && left.length === 0 };
};

/** What is left, as a cleanup row's ID columns hold it (the marker finds the rest). */
const idsOf = (left: readonly Target[]) => {
  const first = (area: Area) =>
    left.find(([each]) => each === area)?.[1] ?? null;
  return {
    serverId: first("mcp"),
    connectedAccountId: first("connected_accounts"),
    authConfigId: first("auth_configs"),
  };
};

/** The first wait before trying a failed cleanup again. */
const firstRetryMs = 60 * 1000;

/**
 * When the clock may start on a cleanup recorded while a start or a
 * finish is still under way (a few Composio requests of at most ten
 * seconds each): long after either is done, so it never deletes what one
 * of them is about to keep.
 */
const underWayMs = 5 * 60 * 1000;

/** The longest wait between two tries of a cleanup. */
const maxRetryMs = 24 * 60 * 60 * 1000;

/** How long to wait after `attempts` failed tries: doubling, up to a day. */
const retryDelayMs = (attempts: number): number =>
  Math.min(firstRetryMs * 2 ** attempts, maxRetryMs);

// Cleanups follow the outbox's pattern: record, then act, then clear. What
// connect gives up at Composio is recorded as a `composio_cleanups` row in
// the same transaction as the change that gives it up (a flow taken, a
// connection disconnected), so neither is ever kept without the other.
// Only then is Composio asked to delete it, and only once it has is the
// row cleared. Whatever happens in between (no key, Composio failing, a
// crash), the row is there for the clock (`retryComposioCleanups`).

// A flow's cleanup row is written before anything is made at Composio
// (intent first), and everything made there carries the flow's marker
// (`markerOf`) in its name. Each ID is written to the row as soon as it is
// known, the fast path; should that write fail, the marker still finds it.

/**
 * Carries out the recorded cleanup `id` of `made` (and, with a `marker`,
 * of everything carrying it): deletes it at Composio, then clears the row,
 * or keeps in it what is left for the clock. Never throws: it runs
 * where another error may be on its way, and a row it fails to clear is
 * only tried again. Whether the account `made` names, if any, is deleted.
 */
const carryOutCleanup = async (
  env: Env,
  id: string,
  made: AtComposio,
  marker: string | null
): Promise<boolean> => {
  const key = composioKey(env);
  if (key === undefined) {
    return false;
  }
  const { left, complete } = await settleAtComposio(key, made, marker);
  const db = drizzle(env.DB);
  const row = eq(composioCleanups.id, id);
  try {
    await (complete
      ? db.delete(composioCleanups).where(row)
      : db.update(composioCleanups).set(idsOf(left)).where(row));
  } catch (error) {
    log.error("composio.cleanup_not_cleared", errorFields(error));
  }
  const account = made.connectedAccountId;
  return (
    typeof account === "string" &&
    !left.some(
      ([area, each]) => area === "connected_accounts" && each === account
    )
  );
};

/**
 * Failed tries after which a cleanup is logged as stuck, at every further
 * try: about a day and a half in, with the waits doubling from a minute.
 */
const stuckAttempts = 10;

/** Most cleanups one clock run tries: a few requests each. */
const cleanupBatchSize = 10;

/**
 * Tries again the cleanups at Composio that are due, waiting longer after
 * each failed try, and forgets each once everything of it is gone. Nothing
 * is tried while connect has no Composio key. The clock calls it.
 */
export const retryComposioCleanups = async (env: Env): Promise<void> => {
  const key = composioKey(env);
  if (key === undefined) {
    return;
  }
  const db = drizzle(env.DB);
  const now = new Date(Date.now());
  const due = await db
    .select()
    .from(composioCleanups)
    .where(lte(composioCleanups.retryAt, now))
    .limit(cleanupBatchSize);
  for (const cleanup of due) {
    // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
    const { left, complete } = await settleAtComposio(
      key,
      cleanup,
      cleanup.marker
    );
    const row = eq(composioCleanups.id, cleanup.id);
    const attempts = cleanup.attempts + 1;
    if (!complete && attempts >= stuckAttempts) {
      // Someone should look: logged by area, never by ID.
      log.error("composio.cleanup_stuck", {
        attempts,
        left: [...new Set(left.map(([area]) => area))].join(","),
      });
    }
    // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
    await (complete
      ? db.delete(composioCleanups).where(row)
      : db
          .update(composioCleanups)
          .set({
            ...idsOf(left),
            attempts,
            retryAt: new Date(now.getTime() + retryDelayMs(attempts)),
          })
          .where(row));
  }
};

const detailOf = (toolkit: string) => ({ provider: toolkit, scope: "shared" });

/**
 * Only admins connect Composio toolkits, and never Grasp staff: each is a
 * shared connection, whose tokens a third party holds. Recorded when
 * refused.
 */
const refuseUnlessAdmin = async (
  env: Env,
  person: ConnectionPerson,
  toolkit: string,
  /** What was refused: connecting, or changing a connection's tools. */
  action: "connection.connect" | "connection.tools" = "connection.connect",
  connectionId?: string
): Promise<void> => {
  let reason: "connection.staff_not_allowed" | "role.forbidden" | undefined;
  if (person.staff) {
    reason = "connection.staff_not_allowed";
  } else if (!isAdmin(person.role)) {
    reason = "role.forbidden";
  }
  if (reason === undefined) {
    return;
  }
  await auditRefusal(
    env,
    person,
    action,
    { ...detailOf(toolkit), outcome: "refused", reason },
    connectionId
  );
  throw reason === "role.forbidden"
    ? roleErrors.create("role.forbidden")
    : connectionErrors.create("connection.staff_not_allowed");
};

/**
 * The tools of an allowlist the admin marked as reads, by name: they run
 * unheld and without a key. The consent and connect events record how many
 * beside the `toolsHash`, and the consent names them in a few events of
 * their own (`connection.consent.read_tools`; `packedNames`), those
 * Composio didn't tag read-only first (`hinted: false`): one marked without
 * the hint is the admin's word alone.
 */
const readToolsOf = (tools: readonly (string | ComposioToolRule)[]): string[] =>
  tools.flatMap((tool) =>
    typeof tool !== "string" && tool.read === true ? [tool.name] : []
  );

/**
 * Whether every one of `tools` is one of `toolkit`'s, each held to a
 * resource only by one of its own input properties: a name that matches
 * nothing would be an entry that silently allows nothing, or holds
 * nothing. With the names Composio says only read (`hinted`).
 */
const checkedTools = async (
  key: string,
  toolkit: string,
  tools: readonly (string | ComposioToolRule)[]
): Promise<{ fits: boolean; hinted: ReadonlySet<string> }> => {
  const toolkitTools = await composioTools(key, toolkit);
  const inputsOf = new Map(
    toolkitTools.map(({ name, inputs }) => [name, inputs])
  );
  const hinted = new Set(
    toolkitTools.flatMap(({ name, readOnly }) => (readOnly ? [name] : []))
  );
  const fits = tools.every((tool) => {
    const inputs = inputsOf.get(composioToolName(tool));
    const resource = typeof tool === "string" ? undefined : tool.resource;
    return (
      inputs !== undefined &&
      (resource === undefined || inputs.includes(resource))
    );
  });
  return { fits, hinted };
};

/**
 * Starts connecting a toolkit for an admin who consented: records their
 * consent with the flow, and returns Composio's auth link.
 */
export const startToolkitConnection = async (
  env: Env,
  request: unknown
): Promise<{ url: string }> => {
  const { person, toolkit, tools, origin, returnTo } = connectionErrors.parse(
    "connection.invalid",
    startToolkitConnectionSchema,
    request
  );
  await refuseUnlessAdmin(env, person, toolkit);
  const key = composioKey(env);
  if (key === undefined || new URL(origin).origin !== origin) {
    throw connectionErrors.create("connection.provider_unavailable");
  }
  // Composio holds no app for it: starting would make an auth config it
  // refuses, so nothing is made, and the attempt is recorded.
  const { auth } = await composioEntry(key, toolkit);
  if (auth === "own") {
    await auditRefusal(env, person, "connection.connect", {
      ...detailOf(toolkit),
      outcome: "refused",
      reason: "connection.own_auth_required",
    });
    throw connectionErrors.create("connection.own_auth_required");
  }
  // Only tools the toolkit has, each held to a resource only by one of its
  // own input properties (`checkedTools`).
  const { fits, hinted } = await checkedTools(key, toolkit, tools);
  const readTools = readToolsOf(tools);
  if (!fits) {
    throw connectionErrors.create("connection.invalid");
  }

  const state = randomToken();
  const stateHash = await sha256Hex(state);
  const flowId = crypto.randomUUID();
  const unhinted = readTools.filter((tool) => !hinted.has(tool));
  // The unhinted first, so they are the ones named if names are cut off.
  const named = packedNames(unhinted);
  const namedHinted = packedNames(
    readTools.filter((tool) => hinted.has(tool)),
    namesEventsMax - named.details.length
  );
  const unnamed = [...named.rest, ...namedHinted.rest];
  const namesOf = (details: Record<string, string>[], wasHinted: boolean) =>
    details.map((names, index) =>
      connectionEvent(person, "connection.consent.read_tools", undefined, {
        ...detailOf(toolkit),
        flowId,
        hinted: wasHinted,
        part: index + 1,
        ...names,
      })
    );
  const storedTools = JSON.stringify(tools);
  const callback = new URL(connectionCallbackPath, origin);
  callback.searchParams.set("state", state);
  const marker = markerOf(flowId);
  const db = drizzle(env.DB);
  const thisCleanup = eq(composioCleanups.id, flowId);
  // Intent first: should anything after this fail, or the isolate go, the
  // clock finds what was made by its marker (`underWayMs` from now,
  // long after this start is done). If this fails, nothing is made.
  await db.insert(composioCleanups).values({
    id: flowId,
    marker,
    retryAt: new Date(Date.now() + underWayMs),
    createdAt: new Date(Date.now()),
  });
  const made: AtComposio = {};
  try {
    const { auth_config: authConfig } = await composioRequest(key, {
      method: "POST",
      path: "/auth_configs",
      body: {
        toolkit: { slug: toolkit },
        auth_config: { type: "use_composio_managed_auth", name: marker },
      },
      schema: authConfigSchema,
    });
    made.authConfigId = authConfig.id;
    await db
      .update(composioCleanups)
      .set({ authConfigId: authConfig.id })
      .where(thisCleanup);
    const link = await composioRequest(key, {
      method: "POST",
      path: "/connected_accounts/link",
      body: {
        auth_config_id: authConfig.id,
        user_id: composioUserOf(origin),
        callback_url: callback.href,
      },
      schema: linkSchema,
    });
    made.connectedAccountId = link.connected_account_id;
    await db
      .update(composioCleanups)
      .set({ connectedAccountId: link.connected_account_id })
      .where(thisCleanup);
    // The flow takes over what the cleanup row held, in one transaction.
    await recordEvents(
      env,
      [
        connectionEvent(person, "connection.consent", undefined, {
          ...detailOf(toolkit),
          outcome: "ok",
          tokenHolder: "composio",
          consentHash: await sha256Hex(composioConsentText),
          flowId,
          toolsHash: await sha256Hex(storedTools),
          toolCount: tools.length,
          readCount: readTools.length,
          unhintedReadCount: unhinted.length,
          // Only when names were cut off: how many, and their hash.
          ...(unnamed.length === 0
            ? {}
            : {
                unnamedReadCount: unnamed.length,
                unnamedReadHash: await sha256Hex(unnamed.join(",")),
              }),
        }),
        ...namesOf(named.details, false),
        ...namesOf(namedHinted.details, true),
      ],
      [
        db.delete(composioCleanups).where(thisCleanup),
        db.insert(composioFlows).values({
          stateHash,
          flowId,
          userId: person.userId,
          toolkit,
          authConfigId: authConfig.id,
          connectedAccountId: link.connected_account_id,
          tools: storedTools,
          returnTo,
          expiresAt: new Date(Date.now() + oauthFlowLifetimeMs),
        }),
      ]
    );
    return { url: link.redirect_url };
  } catch (error) {
    await carryOutCleanup(env, flowId, made, marker);
    if (!(error instanceof ComposioError)) {
      throw error;
    }
    await auditRefusal(env, person, "connection.connect", {
      ...detailOf(toolkit),
      outcome: "failed",
      reason: "connection.provider_refused",
    });
    throw connectionErrors.create("connection.provider_refused");
  }
};

interface FlowRow {
  state_hash: string;
  flow_id: string;
  user_id: string;
  toolkit: string;
  auth_config_id: string;
  connected_account_id: string;
  tools: string;
  return_to: string;
  expires_at: number;
}

/**
 * Takes the Composio flows `where` (SQL over `composio_flows`, with
 * `binds`) matches, and hands what each made at Composio over to a cleanup
 * row due at `retryAt`, keyed by its flow ID, in one transaction: a flow
 * is never gone without its cleanup recorded. Two takes of one flow never
 * both get it. The flows taken.
 */
const handOverFlows = async (
  env: Env,
  where: string,
  binds: readonly unknown[],
  retryAt: number
): Promise<ToolkitFlow[]> => {
  const [, taken] = await env.DB.batch<FlowRow>([
    env.DB.prepare(
      // The marker as `markerOf` makes it.
      `INSERT INTO composio_cleanups (id, server_id, connected_account_id, auth_config_id, marker, attempts, retry_at, created_at) SELECT flow_id, NULL, connected_account_id, auth_config_id, 'grasp-' || substr(replace(flow_id, '-', ''), 1, 24), 0, ?, ? FROM composio_flows WHERE ${where}`
    ).bind(retryAt, Date.now(), ...binds),
    env.DB.prepare(
      `DELETE FROM composio_flows WHERE ${where} RETURNING *`
    ).bind(...binds),
  ]);
  return (taken?.results ?? []).map((row) => ({
    stateHash: row.state_hash,
    flowId: row.flow_id,
    userId: row.user_id,
    toolkit: row.toolkit,
    authConfigId: row.auth_config_id,
    connectedAccountId: row.connected_account_id,
    tools: row.tools,
    returnTo: row.return_to,
    expiresAt: new Date(row.expires_at),
  }));
};

/**
 * Takes the Composio flow `stateHash` names, its cleanup recorded (due
 * `underWayMs` from now, once whoever took it is done): spent whatever
 * happens next.
 */
export const takeToolkitFlow = async (
  env: Env,
  stateHash: string
): Promise<ToolkitFlow | undefined> => {
  const [flow] = await handOverFlows(
    env,
    "state_hash = ?",
    [stateHash],
    Date.now() + underWayMs
  );
  return flow;
};

/**
 * Deletes at Composio what a flow taken for good made there (one that
 * came back but can't finish); its cleanup row keeps what can't be.
 */
export const abandonToolkitFlow = async (
  env: Env,
  flow: ToolkitFlow
): Promise<void> => {
  await carryOutCleanup(env, flow.flowId, flow, markerOf(flow.flowId));
};

/**
 * Hands every Composio flow of the people `userIds` over to cleanup rows
 * due now, in one transaction, however many there are: someone removed
 * can finish none. The clock deletes them at Composio, a bounded
 * number a run.
 */
export const dropToolkitFlowsOf = async (
  env: Env,
  userIds: readonly string[]
): Promise<void> => {
  await handOverFlows(
    env,
    "user_id IN (SELECT value FROM json_each(?))",
    [JSON.stringify(userIds)],
    Date.now()
  );
};

/**
 * Hands the Composio flows nobody finished in time over to cleanup rows
 * due now, for the clock to delete at Composio. It calls this.
 */
export const purgeExpiredToolkitFlows = async (env: Env): Promise<void> => {
  const now = Date.now();
  await handOverFlows(env, "expires_at <= ?", [now], now);
};

/**
 * Whether `url`, as Composio generated it, is the server connect calls for
 * this server and this one connected account, and nothing wider: Composio's
 * MCP host, the server's own path, and exactly this account (never a
 * user-wide URL).
 */
const isServerFor = (
  url: string,
  serverId: string,
  connectedAccountId: string
): boolean => {
  if (!isComposioServerUrl(url)) {
    return false;
  }
  const { pathname, searchParams } = new URL(url);
  const path = `/v3/mcp/${encodeURIComponent(serverId)}`;
  const accounts = searchParams.getAll("connected_account_id");
  return (
    (pathname === path || pathname === `${path}/mcp`) &&
    accounts.length === 1 &&
    accounts[0] === connectedAccountId &&
    !searchParams.has("user_id")
  );
};

/**
 * Finishes a Composio flow for the admin who started it, once Composio
 * sent their browser back: the new connection.
 */
const finishToolkitConnection = async (
  env: Env,
  person: ConnectionPerson,
  flow: ToolkitFlow
): Promise<{ connectionId: string; returnTo: string }> => {
  const detail = detailOf(flow.toolkit);
  const refuse = async (
    reason: string,
    outcome: "refused" | "failed" = "refused"
  ): Promise<void> => {
    await auditRefusal(env, person, "connection.connect", {
      ...detail,
      outcome,
      reason,
    });
  };
  const key = composioKey(env);
  const made: AtComposio = {
    connectedAccountId: flow.connectedAccountId,
    authConfigId: flow.authConfigId,
  };
  try {
    const live =
      flow.expiresAt.getTime() > Date.now() && flow.userId === person.userId;
    if (!live) {
      await refuse("connection.flow_invalid");
      throw connectionErrors.create("connection.flow_invalid");
    }
    // The role is read again: it may have changed since the flow started.
    await refuseUnlessAdmin(env, person, flow.toolkit);
    if (key === undefined) {
      await refuse("connection.provider_unavailable");
      throw connectionErrors.create("connection.provider_unavailable");
    }
    const account = await composioRequest(key, {
      path: `/connected_accounts/${encodeURIComponent(flow.connectedAccountId)}`,
      schema: connectedAccountSchema,
    });
    const isThisFlows =
      account.id === flow.connectedAccountId &&
      account.status === "ACTIVE" &&
      account.toolkit.slug === flow.toolkit &&
      account.auth_config.id === flow.authConfigId;
    if (!isThisFlows) {
      await refuse("connection.provider_refused", "failed");
      throw connectionErrors.create("connection.provider_refused");
    }
    const tools = composioToolsSchema.parse(JSON.parse(flow.tools));
    const server = await composioRequest(key, {
      method: "POST",
      path: "/mcp/servers",
      body: {
        // Its flow's marker: 4 to 30 letters, digits and hyphens.
        name: markerOf(flow.flowId),
        auth_config_ids: [flow.authConfigId],
        allowed_tools: tools.map(composioToolName),
      },
      schema: mcpServerSchema,
    });
    made.serverId = server.id;
    await drizzle(env.DB)
      .update(composioCleanups)
      .set({ serverId: server.id })
      .where(eq(composioCleanups.id, flow.flowId));
    const { connected_account_urls: urls } = await composioRequest(key, {
      method: "POST",
      path: "/mcp/servers/generate",
      body: {
        mcp_server_id: server.id,
        connected_account_ids: [flow.connectedAccountId],
      },
      schema: mcpUrlsSchema,
    });
    const [url] = urls;
    if (
      urls.length !== 1 ||
      url === undefined ||
      !isServerFor(url, server.id, flow.connectedAccountId)
    ) {
      throw new ComposioError("Composio's server URL isn't one connect calls");
    }
    const connectionId = crypto.randomUUID();
    const now = new Date();
    await recordEvents(
      env,
      [
        connectionEvent(person, "connection.connect", connectionId, {
          ...detail,
          outcome: "ok",
          tokenHolder: "composio",
          flowId: flow.flowId,
          toolsHash: await sha256Hex(flow.tools),
          toolCount: tools.length,
          readCount: readToolsOf(tools).length,
        }),
      ],
      [
        // The connection takes over what the flow's cleanup row held.
        drizzle(env.DB)
          .delete(composioCleanups)
          .where(eq(composioCleanups.id, flow.flowId)),
        drizzle(env.DB).insert(connections).values({
          id: connectionId,
          provider: flow.toolkit,
          scope: "shared",
          ownerUserId: null,
          status: "active",
          serverKind: "composio",
          server: url,
          accountId: flow.connectedAccountId,
          connectedBy: person.userId,
          composioServerId: server.id,
          composioAuthConfigId: flow.authConfigId,
          tools: flow.tools,
          createdAt: now,
          updatedAt: now,
        }),
      ]
    );
    return { connectionId, returnTo: flow.returnTo };
  } catch (error) {
    await carryOutCleanup(env, flow.flowId, made, markerOf(flow.flowId));
    if (!(error instanceof ComposioError)) {
      throw error;
    }
    await refuse("connection.provider_refused", "failed");
    throw connectionErrors.create("connection.provider_refused");
  }
};

/**
 * Finishes the Composio flow `request` names, as `finishConnection` does an
 * OAuth flow: a Composio flow comes back to the same callback, without a
 * code. `undefined` when the request names no Composio flow, for
 * `finishConnection` to take it from there.
 */
export const finishToolkitFlow = async (
  env: Env,
  request: unknown
): Promise<{ connectionId: string; returnTo: string } | undefined> => {
  const parsed = finishConnectionSchema.safeParse(request);
  if (!parsed.success) {
    return undefined;
  }
  const { person, state } = parsed.data;
  const flow = await takeToolkitFlow(env, await sha256Hex(state));
  if (flow === undefined) {
    return undefined;
  }
  return await finishToolkitConnection(env, person, flow);
};

/** What connect reads of a connected account to say whether it works. */
const accountStatusSchema = z.object({ status: z.string() });

/** Most Composio accounts one read asks Composio about: one per toolkit. */
const askedAccountsMax = 50;

/**
 * Whether Composio says each Composio connection's account still works,
 * by connection ID, for Grasp's staff (`organizationConnections`): its
 * tokens are Composio's, so an account that expired or failed there, or
 * that Composio no longer has, still reads `active` in connect's own
 * table. Only the status is read, never kept, and nothing of the account
 * goes further: not its ID, which with connect's key opens it. `unread`
 * for each one Composio wasn't asked about or didn't answer for, and for
 * all while connect has no key.
 */
export const composioAccountStates = async (
  env: Env,
  held: readonly { id: string; accountId: string | null }[]
): Promise<Map<string, ComposioAccountState>> => {
  const key = composioKey(env);
  const asked = key === undefined ? [] : held.slice(0, askedAccountsMax);
  const states = new Map<string, ComposioAccountState>(
    held.map(({ id }) => [id, "unread"])
  );
  await Promise.all(
    asked.map(async ({ id, accountId }) => {
      if (key === undefined || accountId === null) {
        return;
      }
      try {
        const { status } = await composioRequest(key, {
          path: `/connected_accounts/${encodeURIComponent(accountId)}`,
          schema: accountStatusSchema,
        });
        states.set(id, status === "ACTIVE" ? "active" : "stopped");
      } catch (error) {
        if (error instanceof ComposioError && error.status === 404) {
          // Composio no longer has it: it takes no call there.
          states.set(id, "stopped");
          return;
        }
        log.warn("composio.account_unread", errorFields(error));
      }
    })
  );
  return states;
};

/**
 * The cleanup of a Composio connection being disconnected: an insert of
 * its server, account and auth config into `composio_cleanups` as `id`,
 * only while `stillConnected` matches it, for the same transaction that
 * marks it disconnected (src/oauth.ts). Calls stop with that transaction,
 * whatever becomes of the deletion at Composio after it.
 */
export const disconnectCleanup = (
  db: DrizzleD1Database,
  id: string,
  stillConnected: SQL
) =>
  db.insert(composioCleanups).select(
    db
      .select({
        id: sql<string>`${id}`.as("id"),
        serverId: connections.composioServerId,
        connectedAccountId: connections.accountId,
        authConfigId: connections.composioAuthConfigId,
        marker: sql<string | null>`NULL`.as("marker"),
        attempts: sql<number>`0`.as("attempts"),
        retryAt: sql<Date>`${Date.now() + firstRetryMs}`.as("retry_at"),
        createdAt: sql<Date>`${Date.now()}`.as("created_at"),
      })
      .from(connections)
      .where(stillConnected)
  );

/**
 * Deletes a disconnected Composio connection's server, account and auth
 * config at Composio, which deletes its tokens there, as the cleanup row
 * `id` its disconnect recorded says; the row keeps what can't be deleted
 * now. Whether the account is deleted now.
 */
export const revokeAtComposio = async (
  env: Env,
  id: string,
  connection: Connection
): Promise<boolean> =>
  await carryOutCleanup(
    env,
    id,
    {
      serverId: connection.composioServerId,
      connectedAccountId: connection.accountId,
      authConfigId: connection.composioAuthConfigId,
    },
    null
  );

/** Sets the allowlist of Composio's MCP server `serverId` to `tools`. */
const setServerTools = async (
  key: string,
  serverId: string,
  tools: readonly (string | ComposioToolRule)[]
): Promise<void> => {
  await composioRequest(key, {
    method: "PATCH",
    path: `/mcp/${encodeURIComponent(serverId)}`,
    body: { allowed_tools: tools.map(composioToolName) },
    schema: z.unknown(),
  });
};

/**
 * How long after it was sent a send Composio didn't answer may still land
 * there: well past connect's own wait for an answer (composio.ts).
 */
const unansweredLandsWithinMs = 120_000;

/**
 * Sends Composio's server `serverId` the tool list `tools` of connection
 * `connectionId`, counted first (`tools_sent_seq`), so the connection is
 * out of sync from before the send until a reconcile settles it
 * (`settle`), whatever happens to this one. The send is kept as unanswered
 * (`composio_tool_sends`) until Composio answers it: one it never answers
 * may land there later still. Its count.
 */
const sendTools = async (
  db: ReturnType<typeof drizzle>,
  key: string,
  serverId: string,
  connectionId: string,
  tools: readonly (string | ComposioToolRule)[]
): Promise<number> => {
  const counted = await db
    .update(connections)
    .set({ toolsSentSeq: sql`${connections.toolsSentSeq} + 1` })
    .where(eq(connections.id, connectionId))
    .returning({ seq: connections.toolsSentSeq })
    .get();
  if (counted === undefined) {
    throw new Error("The connection is gone.");
  }
  const { seq } = counted;
  await db
    .insert(composioToolSends)
    .values({ connectionId, seq, sentAt: new Date() });
  const answered = async () => {
    await db
      .delete(composioToolSends)
      .where(
        and(
          eq(composioToolSends.connectionId, connectionId),
          eq(composioToolSends.seq, seq)
        )
      );
  };
  try {
    await setServerTools(key, serverId, tools);
  } catch (error) {
    // Composio answered, refusing: this send lands nowhere later. One it
    // never answered stays kept.
    if (error instanceof ComposioError && error.status !== undefined) {
      await answered();
    }
    throw error;
  }
  await answered();
  return seq;
};

/** Rounds of bringing Composio to connect's list before giving up. */
const reconcileRounds = 3;

/**
 * Makes Composio's server `serverId` allow what connect holds for
 * connection `connectionId` now: reads connect's list, sends it, then
 * reads it again, and sends again while what it reads after a send isn't
 * what it sent. A send overtaken by a newer change, which may have landed
 * at Composio before it, is so followed by that change's list: the last
 * send of every change is of connect's latest list, whatever the order.
 * The count of the send that told Composio the latest one, if one did.
 */
const reconciled = async (
  db: ReturnType<typeof drizzle>,
  key: string,
  serverId: string,
  connectionId: string
): Promise<number | undefined> => {
  const listNow = async (): Promise<string | undefined> => {
    const now = await db
      .select({ tools: connections.tools })
      .from(connections)
      .where(eq(connections.id, connectionId))
      .get();
    return now?.tools ?? undefined;
  };
  let sent = await listNow();
  for (let round = 0; round < reconcileRounds; round += 1) {
    const parsed = composioToolsSchema.safeParse(JSON.parse(sent ?? "null"));
    if (!parsed.success) {
      return undefined;
    }
    let seq: number;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one send, then a read
      seq = await sendTools(db, key, serverId, connectionId, parsed.data);
    } catch (error) {
      log.warn("composio.tools_reconcile_failed", errorFields(error));
      return undefined;
    }
    // oxlint-disable-next-line no-await-in-loop -- read after each send
    const after = await listNow();
    if (after === sent) {
      return seq;
    }
    sent = after;
  }
  return undefined;
};

/** How long the clock waits after a reconcile's first failure. */
const unsyncedRetryBaseMs = 60_000;
/** Most doublings of that wait: about an hour at most. */
const unsyncedRetryDoublings = 6;

/**
 * Settles connection `connectionId` at send `seq`, which told Composio
 * connect's latest list: only if no send came after it (that one's
 * reconcile, or the clock, settles), and none sent shortly before it is
 * unanswered (it may land after this one: the clock settles once it no
 * longer can). Whether it settled.
 */
const settle = async (
  db: ReturnType<typeof drizzle>,
  connectionId: string,
  seq: number
): Promise<boolean> => {
  const now = Date.now();
  const mayLandLater = db
    .select({ seq: composioToolSends.seq })
    .from(composioToolSends)
    .where(
      and(
        eq(composioToolSends.connectionId, connectionId),
        lt(composioToolSends.seq, seq),
        gt(composioToolSends.sentAt, new Date(now - unansweredLandsWithinMs))
      )
    );
  const settled = await db
    .update(connections)
    .set({ toolsSettledSeq: seq, toolsSyncFailures: 0, toolsSyncRetryAt: null })
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.toolsSentSeq, seq),
        notExists(mayLandLater)
      )
    )
    .returning({ id: connections.id })
    .get();
  if (settled !== undefined) {
    await db
      .delete(composioToolSends)
      .where(
        and(
          eq(composioToolSends.connectionId, connectionId),
          lte(composioToolSends.seq, seq)
        )
      );
    return true;
  }
  // Still the latest send: one before it may land yet, so the clock comes
  // back once it no longer can. A later send's is its own to settle.
  await db
    .update(connections)
    .set({ toolsSyncRetryAt: new Date(now + unansweredLandsWithinMs) })
    .where(
      and(eq(connections.id, connectionId), eq(connections.toolsSentSeq, seq))
    );
  return false;
};

/**
 * Reconciles connection `connectionId` (`reconciled`) and settles it at
 * the send that did (`settle`); out of sync until then, for connect's
 * clock to try again (`reconcileUnsyncedTools`). A failure puts the next
 * try off, twice as long each time, so ones that keep failing leave the
 * clock to others. Whether Composio was told connect's latest list.
 */
const reconcileAndSettle = async (
  db: ReturnType<typeof drizzle>,
  key: string,
  serverId: string,
  connectionId: string
): Promise<boolean> => {
  const startedAt = Date.now();
  const seq = await reconciled(db, key, serverId, connectionId);
  if (seq === undefined) {
    await db
      .update(connections)
      .set({
        toolsSyncFailures: sql`${connections.toolsSyncFailures} + 1`,
        // SQLite reads the failures before this update's.
        toolsSyncRetryAt: sql`${startedAt} + (${unsyncedRetryBaseMs} << min(${connections.toolsSyncFailures}, ${unsyncedRetryDoublings}))`,
      })
      .where(eq(connections.id, connectionId));
    return false;
  }
  await settle(db, connectionId, seq);
  return true;
};

/** Most connections out of sync one clock run reconciles. */
const unsyncedPerRun = 20;

/**
 * Reconciles Composio for the connections out of sync, a few each run:
 * what a change's reconcile left unfinished (Composio away, or refusing
 * for a while), or a send a crash cut short. Ones never tried first, then
 * the longest due, and none before its retry time, so ones that keep
 * failing never hold back the rest. Connect's clock runs it.
 */
export const reconcileUnsyncedTools = async (env: Env): Promise<void> => {
  const key = composioKey(env);
  if (key === undefined) {
    return;
  }
  const db = drizzle(env.DB);
  const marked = await db
    .select({ id: connections.id, serverId: connections.composioServerId })
    .from(connections)
    .where(
      and(
        gt(connections.toolsSentSeq, connections.toolsSettledSeq),
        eq(connections.status, "active"),
        eq(connections.serverKind, "composio"),
        isNotNull(connections.composioServerId),
        or(
          isNull(connections.toolsSyncRetryAt),
          lte(connections.toolsSyncRetryAt, new Date())
        )
      )
    )
    // SQLite sorts nulls first: never tried before tried.
    .orderBy(asc(connections.toolsSyncRetryAt), asc(connections.id))
    .limit(unsyncedPerRun);
  for (const { id, serverId } of marked) {
    if (serverId === null) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one connection at a time
    if (!(await reconcileAndSettle(db, key, serverId, id))) {
      log.warn("composio.tools_still_unsynced", { connectionId: id });
    }
  }
};

/**
 * Changes which tools a shared Composio connection allows, and which of
 * them only read, for an admin (GRA-993; the threat model is on the
 * issue). Only tools its toolkit has, as connecting checks them.
 * Composio's server first, then connect's own list, which every call goes
 * by, only if it is still the list read: should another change have won
 * in between, Composio is set back to what connect holds and the change
 * is refused (`connection.tools_changed`). So connect never allows a tool
 * Composio wasn't told of, and a lost race leaves no wider list. Audited
 * with the lists' hashes and counts, the tools newly marked as reads that
 * Composio doesn't call read-only named, as consenting names them; a
 * held action of a tool taken away is dropped. The tools it allows now.
 */
export const changeToolkitTools = async (
  env: Env,
  request: unknown
): Promise<{ tools: string[] }> => {
  const { person, connectionId, tools } = connectionErrors.parse(
    "connection.invalid",
    changeToolkitToolsSchema,
    request
  );
  const db = drizzle(env.DB);
  const row = await db
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  const changeable =
    row !== undefined &&
    row.serverKind === "composio" &&
    row.scope === "shared" &&
    row.status === "active" &&
    row.composioServerId !== null &&
    row.tools !== null;
  if (!changeable) {
    throw connectErrors.create("connect.connection_not_found");
  }
  const { provider: toolkit } = row;
  const serverId = row.composioServerId ?? "";
  const before = row.tools ?? "[]";
  await refuseUnlessAdmin(env, person, toolkit, "connection.tools", row.id);
  const detail = detailOf(toolkit);
  const failed = async (reason: string, outcome: "refused" | "failed") => {
    await auditRefusal(
      env,
      person,
      "connection.tools",
      { ...detail, outcome, reason },
      row.id
    );
  };
  const key = composioKey(env);
  if (key === undefined) {
    await failed("connection.provider_unavailable", "failed");
    throw connectionErrors.create("connection.provider_unavailable");
  }
  const { fits, hinted } = await checkedTools(key, toolkit, tools);
  if (!fits) {
    await failed("connection.invalid", "refused");
    throw connectionErrors.create("connection.invalid");
  }
  const stored = JSON.stringify(tools);
  const names = tools.map(composioToolName);
  // A held action of a tool not allowed would be refused when confirmed:
  // dropped, so nobody is asked to confirm it. Idempotent, so the same
  // choice sent again finishes it should an earlier try stop short.
  // By the list connect holds as each is dropped, never this change's:
  // a newer change may have allowed its tool again meanwhile.
  const dropUnallowed = async () => {
    await dropPendingActions(
      env,
      sql`${pendingActions.connectionId} = ${row.id} AND ${pendingActions.action} NOT IN (
        SELECT CASE WHEN allowed.type = 'object'
          THEN json_extract(allowed.value, '$.name') ELSE allowed.value END
        FROM json_each((SELECT ${connections.tools} FROM ${connections}
          WHERE ${connections.id} = ${row.id})) AS allowed)`,
      "connection.tools_changed",
      person
    );
  };
  // Composio told what connect holds, recorded for whoever reconciles
  // should it not finish: connect, which every call goes by, stays as it is.
  const reconcile = async () => {
    if (!(await reconcileAndSettle(db, key, serverId, row.id))) {
      await failed("connection.tools_restore_failed", "failed");
    }
  };
  if (stored === before) {
    // Already connect's list: Composio, and held actions, brought in line
    // with it, so sending the same choice again repairs a change that
    // stopped after Composio was told.
    await reconcile();
    await dropUnallowed();
    return { tools: names };
  }
  const previous = composioToolsSchema.parse(JSON.parse(before));
  // Narrowed first, widened after: before connect's write, Composio is told
  // only the tools both lists allow; the ones this adds reach it only once
  // connect holds them (the reconcile below). Composio may lag connect,
  // never lead it.
  const kept = new Set(previous.map(composioToolName));
  const narrowed = tools.filter((tool) => kept.has(composioToolName(tool)));
  try {
    await sendTools(db, key, serverId, row.id, narrowed);
  } catch (error) {
    // Composio may have taken the narrowing all the same (an answer lost
    // or unreadable): brought back to connect's list, which is unchanged,
    // or left out of sync for the clock (`reconcileAndSettle`).
    await reconcile();
    // Recorded whatever went wrong: Composio refusing, or anything else
    // on the way, which goes on as it was.
    if (!(error instanceof ComposioError)) {
      await failed("connection.change_failed", "failed");
      throw error;
    }
    await failed("connection.provider_refused", "failed");
    throw connectionErrors.create("connection.provider_refused");
  }
  const previousNames = new Set(previous.map(composioToolName));
  const previousReads = new Set(readToolsOf(previous));
  const readTools = readToolsOf(tools);
  // Newly marked as reads without Composio's hint: the admin's word alone,
  // named, as consenting names them.
  const named = packedNames(
    readTools.filter((tool) => !previousReads.has(tool) && !hinted.has(tool))
  );
  const addedNames = names.filter((name) => !previousNames.has(name));
  const removedNames = [...previousNames].filter(
    (name) => !names.includes(name)
  );
  // Which tools came and went, by name, so the log answers who allowed
  // each: as many as fit, the rest counted.
  const addedPacked = packedNames(addedNames);
  const removedPacked = packedNames(removedNames);
  const partsOf = (
    action:
      | "connection.tools.added"
      | "connection.tools.removed"
      | "connection.tools.read_tools",
    details: readonly Record<string, string>[],
    extra: Record<string, boolean> = {}
  ) =>
    details.map((part, index) =>
      connectionEvent(person, action, row.id, {
        ...detail,
        ...extra,
        part: index + 1,
        ...part,
      })
    );
  const namedEntries = [
    ...partsOf("connection.tools.added", addedPacked.details),
    ...partsOf("connection.tools.removed", removedPacked.details),
    ...partsOf("connection.tools.read_tools", named.details, { hinted: false }),
  ];
  const updatedAt = new Date();
  // Only while the list is still the one read.
  const stillRead = sql`${connections.id} = ${row.id} AND ${connections.tools} = ${before}`;
  // Made by this change: its list, at its time, read after its update.
  const madeHere = sql`${connections.id} = ${row.id} AND ${connections.tools} = ${stored} AND ${connections.updatedAt} = ${updatedAt.getTime()}`;
  let changed: boolean;
  try {
    // The change, its event and the tools it named, in one transaction:
    // each named event only once the change itself was made.
    [changed = false] = await recordEventsIf(env, [
      {
        entry: connectionEvent(person, "connection.tools", row.id, {
          ...detail,
          outcome: "ok",
          beforeHash: await sha256Hex(before),
          toolsHash: await sha256Hex(stored),
          toolCount: tools.length,
          readCount: readTools.length,
          added: addedNames.length,
          removed: removedNames.length,
          unnamedAdded: addedPacked.rest.length,
          unnamedRemoved: removedPacked.rest.length,
          unnamedReads: named.rest.length,
        }),
        from: connections,
        where: stillRead,
        writes: [
          db
            .update(connections)
            .set({ tools: stored, updatedAt })
            .where(stillRead),
        ],
      },
      ...namedEntries.map((entry) => ({
        entry,
        from: connections,
        where: madeHere,
        writes: [],
      })),
    ]);
  } catch (error) {
    // The write may have landed and only its answer failed: read back,
    // it is this change's, made with its events in one transaction.
    let landed: { id: string } | undefined;
    try {
      landed = await db
        .select({ id: connections.id })
        .from(connections)
        .where(madeHere)
        .get();
    } catch {
      // Not read: taken as not made, the safe side for Composio.
      landed = undefined;
    }
    if (landed === undefined) {
      // Composio was told part of this change, connect kept the list it
      // had: Composio goes back to connect's.
      await reconcile();
      await failed("connection.change_failed", "failed");
      throw error;
    }
    changed = true;
  }
  if (!changed) {
    // Another change won: Composio goes to what connect holds now.
    await reconcile();
    await failed("connection.tools_changed", "refused");
    throw connectionErrors.create("connection.tools_changed");
  }
  // A change that lost meanwhile may have sent Composio an older list
  // after this one's: Composio brought to connect's latest.
  await reconcile();
  await dropUnallowed();
  return { tools: names };
};
