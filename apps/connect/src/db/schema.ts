import { auditRejectReasons } from "@grasp-os/shared/audit";
/**
 * Connect D1 schema: the connection registry, OAuth and Composio flows under
 * way, the connections' sealed tokens, the stored answers of side effects, the side
 * effects held for their person, the audit outbox, the old and new values
 * of what side effects changed, and where connect
 * listens for events and the events it read.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

/**
 * A read of an account's groups under way (reader-groups.ts): when it
 * started, the account and the address it reads for, the groups found so
 * far, the members still to ask, and the next page of the first of them.
 */
export interface ReaderGroupsReading {
  startedAt: number;
  account: string;
  address: string | null;
  found: string[];
  pending: string[];
  page: string | null;
}

/**
 * One connection to an outside system, and the MCP server that carries out
 * its actions: a native connector of ours (`server` names it), a connector
 * made from an MCP server's URL (`server` and `provider` are its ID in
 * `connectors`), or a Composio server scoped to one toolkit (`server` is
 * its HTTPS URL).
 *
 * A personal connection is one person's own account: only calls acting for
 * `owner_user_id` may use it. A shared one (a service account or an
 * admin-consented app) has no owner; permissions decide who uses it.
 */
export const connections = sqliteTable(
  "connections",
  {
    id: text().primaryKey(),
    /** The outside system, such as `microsoft` or `hubspot`. */
    provider: text().notNull(),
    scope: text({ enum: ["personal", "shared"] }).notNull(),
    ownerUserId: text("owner_user_id"),
    /** Only an active connection takes calls. */
    status: text({
      enum: ["active", "needs_reauth", "disconnected"],
    }).notNull(),
    /**
     * `http` for an HTTP connection (GRA-1478): connect sends its requests
     * itself, to `server`, its origin (`http_connections`).
     */
    serverKind: text("server_kind", {
      enum: ["native", "composio", "http", "connector"],
    }).notNull(),
    server: text().notNull(),
    /**
     * For a shared connection reached through the company network, the
     * one address its requests go to, as an origin (company-network.ts).
     * The address its key is sealed with is what routes them; this is
     * what is shown of it.
     */
    companyNetwork: text("company_network"),
    /**
     * For an OAuth connection: the organization's tenant at the provider,
     * the account in it (its stable subject, such as an Entra object ID)
     * and its name for people (an email address), and who connected it.
     */
    tenant: text(),
    accountId: text("account_id"),
    accountName: text("account_name"),
    /**
     * The account's own email address, as the provider's ID token said
     * (`email`): for Microsoft 365 the primary address it sends from,
     * which may differ from its sign-in name. Core records it with the
     * mail a workflow run sends through the connection.
     */
    accountEmail: text("account_email"),
    /**
     * The account's address as its provider confirmed it, when connected
     * and again at each renewal (providers.ts `confirmAddress`), for the
     * providers whose reader lists name accounts by address (Google's);
     * null when the last renewal confirmed none, and for every other
     * provider. What core counts a person in a copied reader list by
     * (`personalAccounts`).
     */
    verifiedEmail: text("verified_email"),
    /**
     * When the provider last confirmed `verified_email`: when connected,
     * or at the last renewal that confirmed it. Core counts the address
     * only while this is recent (`readerProofMaxAgeMs`), so an address an
     * idle connection or one needing reconnecting holds stops counting.
     */
    verifiedEmailAt: timestamp("verified_email_at"),
    /**
     * The addresses `verified_email` held before a renewal or reconnect
     * replaced or cleared it (`pastAddressesAfter`), kept until its
     * person's erasure, which forgets the reader tokens of each (core's
     * person-erasure.ts `identity`). Nothing reads them for access: a past
     * address proves nothing.
     */
    pastVerifiedEmails: text("past_verified_emails", { mode: "json" }).$type<
      string[]
    >(),
    /**
     * The groups the account is in at the provider, nested ones included,
     * as the last whole read with its own token said (reader-groups.ts),
     * for the providers whose reader lists name groups: null until one
     * was. What core counts a person in a list's group by
     * (`personalAccounts`), only while `reader_groups_at` is recent.
     */
    readerGroups: text("reader_groups", { mode: "json" }).$type<string[]>(),
    /** When a whole read last said `reader_groups`. */
    readerGroupsAt: timestamp("reader_groups_at"),
    /**
     * When a turn of a read of the account's groups was last taken, whole
     * or not: one is due again only once the connection's access token was
     * minted after it, or while a read is under way (reader-groups.ts).
     */
    readerGroupsTriedAt: timestamp("reader_groups_tried_at"),
    /**
     * A read of the account's groups under way, as its last turn left it:
     * the groups found so far, which count for nothing until it is whole,
     * and the members still to ask. Null when none is.
     */
    readerGroupsReading: text("reader_groups_reading", {
      mode: "json",
    }).$type<ReaderGroupsReading>(),
    /**
     * The other addresses the account's mailbox receives mail at (its
     * primary address and SMTP aliases), as its provider said when it was
     * connected (account-addresses.ts); null when never read.
     */
    accountAddresses: text("account_addresses", { mode: "json" }).$type<
      string[]
    >(),
    /**
     * The addresses the account may send as, besides those it receives
     * at (Google's verified send-as addresses), as its provider said when
     * it was connected (account-addresses.ts); null when never read.
     */
    accountSenders: text("account_senders", { mode: "json" }).$type<string[]>(),
    /**
     * For a shared connection whose places an admin picks: one up with
     * each save that changed them (sync.ts `pickSyncPlaces`), so core
     * hides what a save un-picked only for a save newer than the last it
     * hid for (brain-sync.ts `hideUnpickedPlaces`). Null before the first.
     */
    syncPicksVersion: integer("sync_picks_version"),
    connectedBy: text("connected_by"),
    /**
     * For a Composio connection: the MCP server and the auth config
     * Composio made for it, which disconnecting deletes with its account,
     * and the tools the admin allowed, as a JSON array of names, or of
     * rules saying which tools only read and which input property names a
     * tool's resource (`ComposioToolRule`). A call of any other tool is
     * refused, and a Composio connection without them takes no calls.
     */
    composioServerId: text("composio_server_id"),
    composioAuthConfigId: text("composio_auth_config_id"),
    /**
     * How a Composio connection was made, and so which consent the admin
     * gave: signing in with Composio's app (`managed`), or with a key they
     * typed in (`key`). Null where it wasn't recorded.
     */
    composioAuth: text("composio_auth", { enum: ["managed", "key"] }),
    tools: text(),
    /**
     * Sends of a tool list to Composio, counted: the count goes up before
     * each send (src/composio-connections.ts `sendTools`), so a send a
     * crash cuts short is still counted.
     */
    toolsSentSeq: integer("tools_sent_seq").notNull().default(0),
    /**
     * The send after which Composio was seen to match `tools`. Out of sync
     * while below `tools_sent_seq`: connect's clock reconciles it.
     */
    toolsSettledSeq: integer("tools_settled_seq").notNull().default(0),
    /** Reconciles that failed in a row since Composio last matched. */
    toolsSyncFailures: integer("tools_sync_failures").notNull().default(0),
    /**
     * Not before when connect's clock reconciles it again: after a failure,
     * backing off as failures add up, or while a send Composio didn't
     * answer may still land there; null for one not yet tried.
     */
    toolsSyncRetryAt: timestamp("tools_sync_retry_at"),
    /**
     * For a connection to a connector made from a URL: when its server's
     * tool list was last read (`connection_tools`), and until when that
     * read is fresh, as the server's `ttlMs` said, a minute at least and
     * an hour at most. Null until the first read.
     */
    toolListReadAt: timestamp("tool_list_read_at"),
    toolListFreshUntil: timestamp("tool_list_fresh_until"),
    /**
     * When connect last started reading that list after an answer, as it
     * does for a stale one, whether the read worked or not: the next such
     * read waits a while (mcp-connectors.ts `refreshLater`). Null until
     * the first.
     */
    toolListTriedAt: timestamp("tool_list_tried_at"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    check(
      "connections_owner_check",
      sql`(${table.scope} = 'personal') = (${table.ownerUserId} IS NOT NULL)`
    ),
    // One live connection per account at a provider: two would share one
    // grant, and disconnecting either (which revokes it) would end both.
    uniqueIndex("connections_account_idx")
      .on(table.provider, table.accountId)
      .where(
        sql`${table.accountId} IS NOT NULL AND ${table.status} <> 'disconnected'`
      ),
    // One live key connection per toolkit (composio-connections.ts
    // `serveAndStore`): of two connects at once, the second fails whole.
    uniqueIndex("connections_key_toolkit_idx")
      .on(table.provider)
      .where(
        sql`${table.composioAuth} = 'key' AND ${table.status} <> 'disconnected'`
      ),
    // Offboarding disconnects a removed person's personal connections.
    index("connections_owner_user_id_idx").on(table.ownerUserId),
  ]
);

/**
 * A connector made from an MCP server's URL (GRA-1375): the one-line
 * `defineConnector({ name, mcp: { url } })`, kept as its parts until the
 * SDK's connector entry holds it (GRA-1374), with how connect signs in to
 * its server. Never edited: another URL, or a server that moved its sign-in
 * elsewhere, is another connector (src/mcp-connectors.ts).
 *
 * `url` is the server's own URL, exactly as its protected-resource
 * metadata names it: the only address a request with a token goes to, and
 * the `resource` every token is asked for. A server that signs in with
 * OAuth (`auth = 'oauth'`) has the authorization server its metadata
 * named (`issuer`), that server's endpoints as its own metadata gave them,
 * and the client connect registered there or the admin entered, bound to
 * that issuer: `client_secret` sealed for this connector and issuer, and
 * null for a public client. One that takes a fixed key (`auth = 'header'`)
 * has the header it goes in; each connection keeps its own key.
 *
 * A built-in of the release that serves its vendor's MCP server (its
 * manifest's `mcp`) has a row too, keyed by its name and made on the
 * first connection to it in the deployment: its state. Its `url` is the
 * manifest's URL it was made for; once a release moves the server, the
 * next connection learns the sign-in there again and moves the row
 * (connect's src/connector-providers.ts `prepareBuiltIn`).
 */
export const connectors = sqliteTable(
  "connectors",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    /** The server's URL, as the URL parser writes it. */
    url: text().notNull(),
    /**
     * The `resource` its metadata names (RFC 9728), the same URL as the
     * server's spelled as the server spells it: what its sign-in asks
     * tokens for (RFC 8707). None for a key.
     */
    resource: text(),
    auth: text({ enum: ["oauth", "header"] }).notNull(),
    /** The header a key goes in, in lower case. */
    header: text(),
    /**
     * Whether its server sits inside the company's own network, reached
     * through the company network at its URL's origin alone
     * (company-network.ts).
     */
    companyNetwork: integer("company_network", { mode: "boolean" }),
    issuer: text(),
    authorizationEndpoint: text("authorization_endpoint"),
    tokenEndpoint: text("token_endpoint"),
    revocationEndpoint: text("revocation_endpoint"),
    /** The scopes asked for, space-separated, as the server named them. */
    scopes: text(),
    /** Whether the issuer said its answers carry `iss` (RFC 9207). */
    issParameter: integer("iss_parameter", { mode: "boolean" }),
    registration: text({
      enum: ["dynamic", "metadata_document", "preregistered"],
    }),
    clientId: text("client_id"),
    clientSecret: text("client_secret"),
    clientAuthentication: text("client_authentication", {
      enum: ["none", "client_secret_post", "client_secret_basic"],
    }),
    /** The admin who added it from a URL; `release` for a built-in. */
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [uniqueIndex("connectors_url_idx").on(table.url)]
);

/**
 * The tools an admin blocked on a connector made from a URL, by the name
 * its server lists them under: offered to nobody, and refused at the call
 * before anything goes out (src/mcp-connectors.ts). A name may be blocked
 * before any list holds it.
 */
export const connectorBlockedTools = sqliteTable(
  "connector_blocked_tools",
  {
    connectorId: text("connector_id")
      .notNull()
      .references(() => connectors.id),
    name: text().notNull(),
    blockedBy: text("blocked_by").notNull(),
    blockedAt: timestamp("blocked_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.connectorId, table.name] })]
);

/**
 * The tools a connector's server listed for a connection at its last read
 * (`connections.tool_list_read_at`), each replaced whole by the next read:
 * what a call of it is checked against, what its class is computed from
 * (src/tool-rules.ts), and its description, kept for tool search. Only
 * tools whose schemas passed the checks are kept; a tool the server listed
 * twice isn't. `input_schema` and `output_schema` are JSON text, and
 * `annotations` the hints the rules read.
 */
export const connectionTools = sqliteTable(
  "connection_tools",
  {
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id),
    name: text().notNull(),
    description: text(),
    inputSchema: text("input_schema").notNull(),
    outputSchema: text("output_schema"),
    annotations: text({ mode: "json" })
      .$type<{ readOnlyHint?: boolean; destructiveHint?: boolean }>()
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.connectionId, table.name] })]
);

/**
 * One side effect per subject, person, connection, action and idempotency
 * key: its claim while it runs, then its result, returned to a repeat
 * instead of calling out again. Never keyed by the key alone: App and agent
 * code chooses keys, so one subject's key must never reach another
 * subject's result, another person's, or another action's.
 *
 * `input_hash` is the SHA-256 of the call's resource and input, so a key
 * can't be reused for a different call. `state` is `running` while the call
 * is out, `done` once its result is stored, `failed` once the tool's error
 * is stored (a tool may have acted before it failed, so that is final too),
 * `unknown` when the call failed after it may have reached the server,
 * `declined` when a workflow run's held side effect was declined or
 * dropped (`output` says why): its step's retry fails, never asks again;
 * and, for a call of unknown outcome its person resolved, `resolved` when
 * they said it happened (never sent again) and `freed` when they said it
 * didn't (one more send of the same input takes the key, `running` again).
 * Rows are never deleted, so no key is ever used twice: past retention, or
 * when too large, an answer's output is dropped and a repeat is refused.
 */
export const idempotentCalls = sqliteTable(
  "idempotent_calls",
  {
    subjectType: text("subject_type", {
      enum: ["app", "agent", "workflow"],
    }).notNull(),
    subjectId: text("subject_id").notNull(),
    onBehalfOf: text("on_behalf_of").notNull(),
    connectionId: text("connection_id").notNull(),
    action: text().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    inputHash: text("input_hash").notNull(),
    state: text({
      enum: [
        "running",
        "done",
        "failed",
        "unknown",
        "declined",
        "resolved",
        "freed",
      ],
    }).notNull(),
    /**
     * Once done or failed: the result as returned to the first call, while
     * it is kept.
     */
    output: text(),
    provenance: text(),
    /** When the key was first claimed: a recovery's horizon counts from it. */
    createdAt: timestamp("created_at").notNull(),
    /**
     * When the call now under way, or last under way, claimed the key: the
     * first claim, or a recovery's retake. A claim older than the claim
     * timeout no longer runs, so its call may be recovered. A row from
     * before this column counts as claimed long ago, which it was.
     */
    claimedAt: timestamp("claimed_at")
      .notNull()
      .default(sql`0`),
    /**
     * The native connector build (`name@version+<code hash>`) that first
     * claimed the key; null for a remote server's call. A call is recovered
     * only by the build that made it: another may tag, find or repeat
     * differently, whether or not its version was bumped.
     */
    connectorVersion: text("connector_version"),
    /**
     * The one resource the call's capability named, or null for the whole
     * connection: what reading the answer later is authorised against
     * again (`heldOutcome`).
     */
    resource: text(),
    /**
     * The exact input, as JSON, while the call may be of unknown outcome:
     * kept from its claim until it is answered or freed, and while it is
     * unknown, so its person sees what was sent before they resolve it.
     */
    input: text(),
    /**
     * Where the call came from, as its capability said (mode, App version,
     * permission, context and the App's resource binding, if any), as
     * JSON, kept as long as `input`: what core checks again before it signs
     * a resolution of it, and connect compares the resolution with. Its
     * `restricted` says a recovery of the call needs its person: its
     * context had read restricted data, or a recovery was refused since for
     * needing their confirmation (`requireConfirmation`).
     */
    origin: text(),
    /**
     * A random ID, set at the first claim: where a list of calls of unknown
     * outcome goes on after this one, with `created_at` (its cursor). Never
     * a row number, which would tell how many calls anyone made in between,
     * and which the database may renumber. Empty only on a declined row,
     * which no list shows. Not backfilled: nothing with this table is
     * released (a hard cut), so no deployment holds rows from before it
     * that a list would show.
     */
    listId: text("list_id").notNull().default(""),
  },
  (table) => [
    primaryKey({
      columns: [
        table.subjectType,
        table.subjectId,
        table.onBehalfOf,
        table.connectionId,
        table.action,
        table.idempotencyKey,
      ],
    }),
    index("idempotent_calls_created_idx").on(table.createdAt),
    // How a held action ended, found by the key connect made for it.
    index("idempotent_calls_key_idx").on(table.idempotencyKey),
    // A person's calls of unknown outcome, listed and waited on.
    index("idempotent_calls_person_state_idx").on(
      table.onBehalfOf,
      table.state
    ),
    // A person's list, page by page, in the order it goes.
    index("idempotent_calls_person_list_idx").on(
      table.onBehalfOf,
      table.createdAt,
      table.listId
    ),
    // The inputs past retention, swept on every claim: only the rows that
    // still keep one, never every old row.
    index("idempotent_calls_kept_input_idx")
      .on(table.createdAt)
      .where(sql`${table.input} IS NOT NULL`),
  ]
);

/**
 * Side effects held until the person they act for confirms them (threat
 * model R7, R12, CN7, CN15): those from chat or from a person using an
 * App, and every one of a context that read restricted data. The exact
 * call, and everything its confirmation is checked against. One per
 * subject, person, connection, action and idempotency key, like the
 * answers above, so a repeat of the call finds the same one. A row exists
 * only while it waits: confirming, declining or dropping it deletes it, in
 * one batch with its audit event.
 *
 * `account_id` is the connection's account when it was held: confirmed on
 * a connection that reaches another account, it is refused. `input` is the
 * call's input as JSON, and `input_hash` the SHA-256 of its resource and
 * input, which the confirmation names. `permission_id` and `context` (JSON)
 * are what core checks again when the person confirms it.
 */
export const pendingActions = sqliteTable(
  "pending_actions",
  {
    id: text().primaryKey(),
    subjectType: text("subject_type", {
      enum: ["app", "agent", "workflow"],
    }).notNull(),
    subjectId: text("subject_id").notNull(),
    onBehalfOf: text("on_behalf_of").notNull(),
    /** Asked for with the person there (`interactive`), or by a run. */
    mode: text({ enum: ["interactive", "workflow"] }).notNull(),
    appVersion: integer("app_version"),
    connectionId: text("connection_id").notNull(),
    accountId: text("account_id"),
    resource: text(),
    action: text().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    input: text().notNull(),
    inputHash: text("input_hash").notNull(),
    /** Null for a read that needs no grant (core's ungranted-reads.ts). */
    permissionId: text("permission_id"),
    context: text().notNull(),
    /** Asked for by a chat, App or run that had read restricted data. */
    restricted: integer({ mode: "boolean" }).notNull().default(false),
    createdAt: timestamp("created_at").notNull(),
    /**
     * The App's approved resource binding the call came through, as JSON
     * (`HeldBinding`): core checks it again before confirming. Null for
     * any other call.
     */
    binding: text(),
    /**
     * The stamp core recorded for a workflow run's mail (`ConnectCall`'s
     * `stamp`), sent with the call once its person confirms it. Null for
     * any other call.
     */
    stamp: text(),
    /**
     * When it ends unconfirmed: a write held in a chat on a chat platform
     * (a Teams card scrolls away, and its values may have moved on) ends
     * at midnight of the company's day it was held on, as core signed it
     * (`CapabilityClaims.heldUntil`). Null for one that waits until it is
     * decided, as every other does.
     */
    endsAt: timestamp("ends_at"),
    /**
     * Asked for by a turn nobody was there for
     * (`CapabilityClaims.unattended`): its person is told so when shown it.
     */
    unattended: integer({ mode: "boolean" }).notNull().default(false),
    /**
     * Held in a chat app's conversation (`CapabilityClaims.chatApp`), which
     * Grasp never shows as a chat: decided on its card there, and left out
     * of Grasp's own list (`listPendingActions`).
     */
    chatApp: integer("chat_app", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    uniqueIndex("pending_actions_call_idx").on(
      table.subjectType,
      table.subjectId,
      table.onBehalfOf,
      table.connectionId,
      table.action,
      table.idempotencyKey
    ),
    // A person's list, and dropping theirs when they are removed.
    index("pending_actions_person_idx").on(table.onBehalfOf),
    // Dropping a disconnected connection's.
    index("pending_actions_connection_idx").on(table.connectionId),
    // Dropping an ended run's, by the range of its steps' keys.
    index("pending_actions_key_idx").on(table.idempotencyKey),
    // Ending those whose day is over.
    index("pending_actions_ends_idx")
      .on(table.endsAt)
      .where(sql`${table.endsAt} IS NOT NULL`),
  ]
);

/**
 * OAuth flows under way: one row from the moment a person starts
 * connecting until the provider sends them back, at most ten minutes.
 * Keyed by the SHA-256 of the flow's `state`, so the state itself, which
 * travels through the browser, is stored nowhere. A flow is taken the
 * first time its state comes back, whatever happens next, so it is used at
 * most once: marked finishing (`finishing_until`) while its code is
 * exchanged and what it got is kept, so an owed revoke waits for it
 * (revocations.ts), and deleted once it is done. `verifier` is the PKCE
 * code verifier, sealed like a token (src/vault.ts).
 */
export const oauthFlows = sqliteTable(
  "oauth_flows",
  {
    stateHash: text("state_hash").primaryKey(),
    /** The person who started it: only they can finish it. */
    userId: text("user_id").notNull(),
    provider: text().notNull(),
    scope: text({ enum: ["personal", "shared"] }).notNull(),
    tenant: text().notNull(),
    redirectUri: text("redirect_uri").notNull(),
    returnTo: text("return_to").notNull(),
    verifier: text().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    /** Until when a taken flow holds its row, at most; null until taken. */
    finishingUntil: timestamp("finishing_until"),
  },
  (table) => [
    index("oauth_flows_expires_idx").on(table.expiresAt),
    // Offboarding spends a removed person's open flows.
    index("oauth_flows_user_id_idx").on(table.userId),
  ]
);

/**
 * Composio flows under way: one row from the moment an admin consents to
 * connecting a Composio toolkit until Composio sends them back, at most ten
 * minutes. Keyed by the SHA-256 of the flow's `state`, like an OAuth flow,
 * and taken (deleted) the first time its state comes back. The auth config
 * and the connected account are the ones connect made at Composio for this
 * flow: finishing checks the account is that one, active, for that
 * toolkit. `tools` are the tools the admin allowed, as `connections.tools`
 * holds them. `flow_id` ties the admin's consent to the connection it led
 * to, in the audit log.
 */
export const composioFlows = sqliteTable(
  "composio_flows",
  {
    stateHash: text("state_hash").primaryKey(),
    flowId: text("flow_id").notNull(),
    /** The admin who consented: only they can finish it. */
    userId: text("user_id").notNull(),
    toolkit: text().notNull(),
    authConfigId: text("auth_config_id").notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    tools: text().notNull(),
    returnTo: text("return_to").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    index("composio_flows_expires_idx").on(table.expiresAt),
    index("composio_flows_user_id_idx").on(table.userId),
  ]
);

/**
 * What connect made at Composio and still has to delete there: a flow
 * that didn't finish, or a connection that was disconnected, while
 * Composio didn't take the deletion or connect had no Composio key. The
 * clock tries again at `retry_at`, waiting longer after each failed
 * `attempts`, until everything is gone. An account left there may hold
 * tokens, so nothing is forgotten.
 */
export const composioCleanups = sqliteTable(
  "composio_cleanups",
  {
    id: text().primaryKey(),
    serverId: text("server_id"),
    connectedAccountId: text("connected_account_id"),
    authConfigId: text("auth_config_id"),
    /**
     * For a flow's cleanup: the marker everything the flow made at Composio
     * carries in its name, which finds what no ID column names (an ID whose
     * write failed after Composio made it).
     */
    marker: text(),
    attempts: integer().notNull().default(0),
    retryAt: timestamp("retry_at").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [index("composio_cleanups_retry_idx").on(table.retryAt)]
);

/**
 * Sends of a tool list to Composio not yet answered, by connection and
 * count (`connections.tools_sent_seq`): one may still land at Composio
 * after a later send, so a send counted while one sent shortly before it
 * is here settles nothing (src/composio-connections.ts). Removed once
 * answered, or once a later send settles.
 */
export const composioToolSends = sqliteTable(
  "composio_tool_sends",
  {
    connectionId: text("connection_id").notNull(),
    seq: integer().notNull(),
    sentAt: timestamp("sent_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.connectionId, table.seq] })]
);

/**
 * A connection's OAuth tokens, sealed with AES-GCM (src/vault.ts): nothing
 * here is readable without the key, which only connect holds. The sealed
 * value names the key that sealed it, so a rotated key can still open it.
 * `access_expires_at` is kept in the clear, so a read knows when to
 * refresh without opening anything.
 *
 * `generation` goes up with every write; a write names the generation it
 * read, so a refresh that finishes after a disconnect or another refresh
 * changes nothing (it would store stale tokens, or bring deleted ones
 * back). `refresh_until` is a short lease: while it runs, one refresh is
 * under way and others wait for its result, across isolates.
 *
 * `granted_scopes` is what the provider last said these tokens were
 * granted (its token answer's `scope`), as it said it; null when it said
 * nothing, or for tokens stored before connect kept it. It tells a
 * connection made before its connector asked for a right from one the
 * provider refuses for another reason (tokens.ts `markIfGrantLacks`).
 */
export const connectionTokens = sqliteTable("connection_tokens", {
  connectionId: text("connection_id")
    .primaryKey()
    .references(() => connections.id),
  sealed: text().notNull(),
  accessExpiresAt: timestamp("access_expires_at").notNull(),
  generation: integer().notNull(),
  refreshUntil: timestamp("refresh_until"),
  grantedScopes: text("granted_scopes"),
  updatedAt: timestamp("updated_at").notNull(),
  /**
   * Until when the connection's vendor asked for no more calls: every call
   * that reads the connection's credential before then is refused, as
   * `connect.rate_limited`, and never reaches the vendor (tokens.ts
   * `pauseFor`). Null until it first asks.
   */
  pausedUntil: timestamp("paused_until"),
});

/**
 * No longer read or written (GRA-2207): a shared connection's places are
 * read by its Brain audience, not by the readers SharePoint names, so no
 * token for a company's SharePoint host is asked for. The table stays
 * until a later release drops it (expand, then contract), so a release
 * before this one, after a rollback, finds it as it left it. A row still
 * in it goes with its grant's `connection_tokens` row (ON DELETE CASCADE).
 */
export const connectionTenantTokens = sqliteTable("connection_tenant_tokens", {
  connectionId: text("connection_id")
    .primaryKey()
    .references(() => connectionTokens.connectionId, { onDelete: "cascade" }),
  host: text().notNull(),
  sealed: text().notNull(),
  accessExpiresAt: timestamp("access_expires_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

/**
 * A place of a shared connection an admin picked for one of its
 * connector's syncs (`places: "picked"`: a shared drive, a document
 * library): the only places that sync reads of it (sync.ts). Who picked
 * is in the audit log, not here.
 */
export const syncPicks = sqliteTable(
  "sync_picks",
  {
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id),
    /** The connector's sync, such as `shared-drives`. */
    feed: text().notNull(),
    /** The place's ID at the provider, as the sync listed it. */
    place: text().notNull(),
    pickedAt: timestamp("picked_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.connectionId, table.feed, table.place] }),
  ]
);

/**
 * A revoke at its provider still owed for a connection's grant (GRA-1191,
 * GRA-1196): the provider was down, or refused, when the connection was
 * disconnected (`disconnected`), or its tokens went while the grant was
 * still valid because it was asked to connect again (`needs_reauth`). The
 * row holds its own sealed copy of the tokens to revoke with (sealed for
 * the connection, as `connection_tokens` are), so the connection's tokens
 * go as ever and nothing calls with these: only the cron trigger opens
 * them, to revoke (`retryRevocations`, src/revocations.ts). A connection
 * can owe more than one: the grant asked again for, then the one that
 * replaced it. `attempts` counts the failed tries, each waiting longer,
 * until `retry_at`.
 */
export const tokenRevocations = sqliteTable(
  "token_revocations",
  {
    id: text().primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id),
    sealed: text().notNull(),
    reason: text({ enum: ["disconnected", "needs_reauth"] }).notNull(),
    attempts: integer().notNull().default(0),
    retryAt: timestamp("retry_at").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    index("token_revocations_retry_idx").on(table.retryAt),
    index("token_revocations_connection_idx").on(table.connectionId),
  ]
);

/**
 * Revokes connect gave up on (src/revocations.ts): its retries ran a year,
 * or the tokens it held stopped opening. The grant may still be live at
 * the provider, so the company's admins see it to revoke it there by hand
 * (src/revocations-by-hand.ts), for `givenUpShownMs` after. Nothing to
 * revoke with is kept: the row names the connection and how it ended.
 */
export const givenUpRevocations = sqliteTable(
  "given_up_revocations",
  {
    id: text().primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id),
    owedFor: text("owed_for", {
      enum: ["disconnected", "needs_reauth"],
    }).notNull(),
    reason: text({ enum: ["expired", "unreadable", "moved"] }).notNull(),
    attempts: integer().notNull(),
    owedAt: timestamp("owed_at").notNull(),
    givenUpAt: timestamp("given_up_at").notNull(),
  },
  (table) => [index("given_up_revocations_at_idx").on(table.givenUpAt)]
);

/**
 * Audit events core hasn't appended to the audit log yet. Each call's
 * events are stored here, with the call's own result where it has one;
 * core's clock takes them and acknowledges those it appended
 * (src/audit.ts). `event` is the event as JSON.
 */
export const auditOutbox = sqliteTable("audit_outbox", {
  id: text().primaryKey(),
  event: text().notNull(),
  createdAt: timestamp("created_at").notNull(),
});

/**
 * Outbox rows a drain moved out because the audit log can't take them:
 * `refused` (not an event to the release that drained it, or over the size
 * cap) or `conflict` (the log holds its ID with other content, a bug or a
 * forgery). Kept as they were, for someone to look at; the chain records
 * each with an `audit.gap` naming its ID and reason (src/audit-outbox.ts in
 * core). Nothing reads them.
 */
export const auditOutboxRejected = sqliteTable(
  "audit_outbox_rejected",
  {
    // Its own key, so a second row with the same event ID is kept too.
    seq: integer().primaryKey(),
    id: text().notNull(),
    event: text().notNull(),
    reason: text({ enum: auditRejectReasons }).notNull(),
    /** When the row was stored in the outbox. */
    createdAt: timestamp("created_at").notNull(),
    rejectedAt: timestamp("rejected_at").notNull(),
  },
  (table) => [index("audit_outbox_rejected_id").on(table.id)]
);

/**
 * What a native connector's side effect changed, its old and new values
 * (an Excel row's cells before and after), kept for whoever audits it: the
 * audit log holds no input or output, only `hash` in the call's
 * `connection.call` event (`changeHash`), the SHA-256 of `change` as
 * stored here, so the log vouches for these values and anyone can check
 * them against it. `change` is `{ before, after }` as JSON. Stored in one
 * batch with the call's answer and events: never one without the other.
 * `request_id` is the call's capability ID, as its events name it.
 */
export const callChanges = sqliteTable(
  "call_changes",
  {
    id: text().primaryKey(),
    requestId: text("request_id").notNull(),
    connectionId: text("connection_id").notNull(),
    action: text().notNull(),
    resource: text(),
    onBehalfOf: text("on_behalf_of").notNull(),
    change: text().notNull(),
    hash: text().notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    // Found by the hash its audit event carries.
    index("call_changes_hash_idx").on(table.hash),
  ]
);

/**
 * Where connect listens for events a workflow's trigger waits for
 * (src/events.ts): one row per connection, event type and resource,
 * while some App listens there. `resource` is the mailbox or drive a
 * permission names, or `''` for the account's own, which a permission on
 * the whole connection covers. `cursor` is where reading what changed
 * goes on from: the provider's delta or next-page link, null until the
 * first read sets it. Reading is due at `poll_at`; `failures` counts reads
 * that failed in a row, each waiting longer. `read_at` is when the last
 * read that reached the end of what the provider had began (one that
 * stopped with more to come leaves it), and `lost_at` when the source
 * last lost its cursor, until it has one again. Events are only of what
 * the source got after `created_at`.
 */
export const eventSources = sqliteTable(
  "event_sources",
  {
    id: text().primaryKey(),
    connectionId: text("connection_id").notNull(),
    type: text().notNull(),
    resource: text().notNull(),
    cursor: text(),
    pollAt: timestamp("poll_at").notNull(),
    failures: integer().notNull().default(0),
    readAt: timestamp("read_at"),
    lostAt: timestamp("lost_at"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("event_sources_key_idx").on(
      table.connectionId,
      table.type,
      table.resource
    ),
    index("event_sources_poll_idx").on(table.pollAt),
  ]
);

/**
 * Events sources reported that core hasn't delivered yet: core takes those
 * due (`retry_at`), delivers them to workflows, and settles them. One per
 * source and the provider's ID of the item (`key`), so an item read twice
 * waits once. A failed delivery is tried again later, `attempts` making
 * each wait longer. `event` is the event as JSON, read from connection
 * `connection_id`: only an active connection's are delivered, and a
 * disconnected one's are dropped.
 */
export const connectorEvents = sqliteTable(
  "connector_events",
  {
    id: text().primaryKey(),
    key: text().notNull(),
    connectionId: text("connection_id").notNull(),
    event: text().notNull(),
    attempts: integer().notNull().default(0),
    retryAt: timestamp("retry_at").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("connector_events_key_idx").on(table.key),
    index("connector_events_retry_idx").on(table.retryAt),
    index("connector_events_connection_idx").on(table.connectionId),
  ]
);

/**
 * People whose erasure has begun (person-erasure.ts), by their user ID:
 * connect makes nothing new of theirs once it has, so nothing a flow or a
 * call still under way finishes after the erasure emptied what was theirs
 * comes back. Never removed: an erasure is final.
 */
export const erasedPeople = sqliteTable("erased_people", {
  userId: text("user_id").primaryKey(),
  beganAt: timestamp("began_at").notNull(),
});

/**
 * The organization's own key for each AI provider (ai-providers.ts),
 * sealed with the vault, bound to its provider and, for an
 * OpenAI-compatible endpoint, the base URL it goes to: a key moved to
 * another row, or a base URL changed in the database, doesn't open. Never
 * read back to core: only its mask, its first and last characters.
 */
export const aiProviderKeys = sqliteTable("ai_provider_keys", {
  provider: text().primaryKey(),
  sealed: text().notNull(),
  mask: text().notNull(),
  /** Only for an OpenAI-compatible endpoint: the base URL its key goes to. */
  baseUrl: text("base_url"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

/**
 * An HTTP connection (GRA-1478, src/http-connections.ts): what an admin
 * approved, never edited, and its credential, sealed with the vault for
 * this connection, origin and header (`credentialContext`), so a value
 * moved to another row, or an origin or header changed in the database,
 * doesn't open. The credential goes once the connection is disconnected
 * (`sealed` null). Never read back to core but its header's name.
 */
export const httpConnections = sqliteTable("http_connections", {
  connectionId: text("connection_id")
    .primaryKey()
    .references(() => connections.id),
  name: text().notNull(),
  /** Exactly `https://host[:port]`, as approved. */
  origin: text().notNull(),
  /** The paths it allows, as a JSON array. */
  pathPrefixes: text("path_prefixes", { mode: "json" })
    .$type<string[]>()
    .notNull(),
  /** The methods it allows, as a JSON array. */
  methods: text({ mode: "json" }).$type<string[]>().notNull(),
  /** The header its credential goes in, in lower case. */
  credentialHeader: text("credential_header").notNull(),
  /** `bearer`: the credential is sent as `Bearer <token>`. */
  credentialKind: text("credential_kind", {
    enum: ["bearer", "header"],
  }).notNull(),
  sealed: text(),
  createdAt: timestamp("created_at").notNull(),
});
