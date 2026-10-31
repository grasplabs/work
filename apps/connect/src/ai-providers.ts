import {
  aiCredentialPlaceholder,
  aiGrantHeader,
  aiKeyErrors,
  aiProviderHost,
  platformHostsOf,
  aiProviderIdSchema,
  aiProviderIds,
  aiProviderKeySaveSchema,
  aiProviders,
  aiRefusedHeader,
} from "@grasp-os/shared/ai-providers";
import type {
  AiProviderId,
  AiProviderKey,
  AiProviderRoutes,
  AiRefusal,
} from "@grasp-os/shared/ai-providers";
import { auditActorSchema, createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { verifyModelGrant } from "@grasp-os/shared/capability";
import type { ModelGrantClaims } from "@grasp-os/shared/capability";
import { sha256HexOfBytes } from "@grasp-os/shared/encoding";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, eq, like, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { checkEndpoint } from "./ai-endpoint-guard.ts";
import type { EndpointPolicy } from "./ai-endpoint-guard.ts";
import { recordEventIf } from "./audit.ts";
import { aiProviderKeys, auditOutbox } from "./db/schema.ts";
import { resealBatchSize, vaultFor } from "./vault.ts";

// The AI providers' credentials, and the one place a model request leaves
// for a provider with one. Core's model gateway decides each call, has the
// model ledger admit each provider request and audits it (core's
// models.ts); it runs pi's adapter for the provider's API with a fetch that
// hands each request here (`modelFetch`), with a grant it signed for that
// request (@grasp-os/shared/capability, `signModelGrant`). Connect adds the
// key and sends it. Core never holds a key.
//
// Two credentials, one path: the organization's own key per provider
// (sealed in `ai_provider_keys`, src/vault.ts), and Grasp's own keys for
// platform features, as connect Worker secrets (`OPENAI_API_KEY` and the
// like, @grasp-os/shared/ai-providers). Threat model, and how each is
// closed:
//
// - A key leaks to core, the logs or the database: a key is sealed as soon
//   as it arrives, bound to its provider and, for a custom endpoint, its
//   base URL (a key moved to another row or another base URL doesn't
//   open), and never answered back: listings carry only a mask of its
//   last four characters (`…a3f2`). Nothing here logs a header, a body, a
//   URL's query, or an error's message (a database error's quotes its
//   query's values: the sealed key, its mask), only identifiers, statuses
//   and timings; a save or removal that fails is `ai_key.failed`, which
//   carries nothing of it.
// - A key changed with no trace: a save or removal and its audit event
//   are one write (connect's audit outbox, which core drains), so one is
//   never kept without the other.
// - A key sent somewhere else: only to its provider's own host, or the
//   organization's registered base URL for a custom endpoint (checked by
//   src/ai-endpoint-guard.ts when it is saved and again on every request),
//   over HTTPS, and only to the provider's model paths, never its files,
//   fine-tuning or account endpoints. The grant names the host too, so a
//   request core didn't decide for that host is refused. Redirects are
//   never followed (one would take the key along).
// - The key in more than one place, or core's own: the request must carry
//   `aiCredentialPlaceholder` exactly where the key goes, or it is refused
//   before anything is sent; nothing else of core's headers goes on but
//   what the API needs (content type, the Messages API's version and
//   betas), and the key goes in that one header.
// - A request core's gateway didn't decide: each needs a grant, made with
//   the capability key only core and connect hold, for a few seconds, for
//   that credential, provider, host and body (its hash); a grant never
//   passes for a connector capability, nor one for a grant.
// - One client's conversation kept by a provider on Grasp's key, where
//   anything else holding that key could read it back: a request on
//   Grasp's key to OpenAI goes with `store: false`, set here whatever core
//   sent, and one that names a stored response or conversation to build
//   on is refused.
// - A request left running, and billing, after core gave up on it: core
//   tells connect to stop it (`modelFetch`'s `stop`) as soon as its caller
//   cancels, even before the provider answered, and connect stops any at
//   the call's deadline (and a few seconds) whatever core does.
// - A provider's answer read as connect's: connect's own refusals carry
//   `aiRefusedHeader`, which is never passed back from a provider, nor any
//   other header but the content type, the request's ID and a rate
//   limit's wait.
// - A request that streams forever: the grant names the call's deadline,
//   which cuts the provider's request off here too.
// - A realtime socket (`modelSocket`, Grasp's live listening): the same
//   grant, placeholder, host and credential checks as a request, only to
//   the provider's realtime paths with their one query, and only on
//   Grasp's own key (an organization's key never opens one). Connect holds
//   both ends and passes each message on as it comes, keeping and logging
//   none; when either end closes, so does the other, and both close at the
//   grant's deadline.

/** The vault context a provider's key is sealed under: its row and destination. */
const contextOf = (provider: AiProviderId, baseUrl: string | null): string =>
  `ai-provider-key\n${provider}\n${baseUrl ?? ""}`;

/** The shortest key whose end a mask shows. */
const maskedFrom = 12;

/**
 * A key's last four characters, or nothing of a short one: never its
 * start, which with the end would give away much of a short custom key.
 */
const maskOf = (key: string): string =>
  key.length < maskedFrom ? "…" : `…${key.slice(-4)}`;

/** Where a custom endpoint may point, for this deployment. */
const policyOf = (env: Env): EndpointPolicy => ({
  onPrem: env.RUNTIME_PROFILE === "workerd",
  privateHosts: (env.AI_PRIVATE_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== ""),
});

/**
 * A custom endpoint's base URL as kept: checked by the endpoint guard,
 * without a query, fragment or trailing slash; or why it is refused.
 */
const baseUrlOf = (
  value: string,
  policy: EndpointPolicy
): string | undefined => {
  const checked = checkEndpoint(value, policy);
  if (
    "refused" in checked ||
    checked.url.search !== "" ||
    checked.url.hash !== ""
  ) {
    return undefined;
  }
  return `${checked.url.origin}${checked.url.pathname.replace(/\/+$/u, "")}`;
};

/** A row as core may see it: never the key. */
const keyOf = (row: typeof aiProviderKeys.$inferSelect): AiProviderKey => ({
  provider: aiProviderIdSchema.parse(row.provider),
  mask: row.mask,
  baseUrl: row.baseUrl,
  addedAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
});

/**
 * Who changes a key, as core names them: only ever a person, one of the
 * organization's own admins (core checks that); never staff or code.
 */
const changerOf = (by: unknown): AuditActor => {
  const parsed = auditActorSchema.safeParse(by);
  if (!parsed.success || parsed.data.type !== "person") {
    throw aiKeyErrors.create("ai_key.invalid");
  }
  return parsed.data;
};

/**
 * Runs a key's write, and turns any failure but connect's own refusals
 * into `ai_key.failed`, logged by its kind alone: a database error's
 * message quotes its query's values, the sealed key and its mask among
 * them, and must reach neither the logs nor core.
 */
const writing = async <T>(
  provider: AiProviderId,
  write: () => Promise<T>
): Promise<T> => {
  try {
    return await write();
  } catch (error) {
    if (aiKeyErrors.codeOf(error) !== undefined) {
      throw error;
    }
    log.error("ai.key_write_failed", {
      provider,
      error: error instanceof Error ? error.name : "unknown",
    });
    throw aiKeyErrors.create("ai_key.failed");
  }
};

/**
 * Stores `entry`'s event in the audit outbox only if `condition` holds
 * when it runs, in the batch it runs in, before the batch's later writes.
 */
const outboxedWhere = (
  db: DrizzleD1Database,
  entry: AuditEntry,
  condition: SQL
) => {
  const event = createAuditEvent(entry, "connect");
  return db
    .insert(auditOutbox)
    .select(
      sql`SELECT ${event.id}, ${JSON.stringify(event)}, ${Date.now()} WHERE ${condition}`
    );
};

/**
 * Seals and keeps the organization's key for a provider, replacing the one
 * it had; for an OpenAI-compatible endpoint, with the base URL it goes to.
 * Recorded in `by`'s name, `ai_provider.added` or `ai_provider.replaced`
 * by whether it had one as the write ran, in the same batch.
 */
export const saveAiProviderKey = async (
  env: Env,
  request: unknown,
  by: unknown
): Promise<AiProviderKey> => {
  const parsed = aiProviderKeySaveSchema.safeParse(request);
  if (!parsed.success) {
    throw aiKeyErrors.create("ai_key.invalid");
  }
  const actor = changerOf(by);
  const { provider, key } = parsed.data;
  const custom = provider === "openai-compatible";
  if (custom !== (parsed.data.baseUrl !== undefined)) {
    throw aiKeyErrors.create("ai_key.invalid");
  }
  let baseUrl: string | null = null;
  if (parsed.data.baseUrl !== undefined) {
    baseUrl = baseUrlOf(parsed.data.baseUrl, policyOf(env)) ?? null;
    if (baseUrl === null) {
      log.warn("ai.key_refused", { provider, reason: "endpoint" });
      throw aiKeyErrors.create("ai_key.endpoint_refused");
    }
  }
  const vault = await vaultFor(env);
  if (vault === undefined) {
    throw aiKeyErrors.create("ai_key.vault_unavailable");
  }
  const sealed = await vault.seal(key, contextOf(provider, baseUrl));
  const now = new Date();
  const db = drizzle(env.DB);
  const had = sql`EXISTS (SELECT 1 FROM ${aiProviderKeys} WHERE ${aiProviderKeys.provider} = ${provider})`;
  const entry = (action: string): AuditEntry => ({
    actor,
    action,
    target: { type: "ai_provider", id: provider },
    detail: {
      provider,
      endpointHost: baseUrl === null ? null : new URL(baseUrl).hostname,
    },
  });
  const row = await writing(provider, async () => {
    // Which event is decided by the row as the batch finds it, before
    // the write: a concurrent save is one or the other, never both.
    const [_added, _replaced, written] = await db.batch([
      outboxedWhere(db, entry("ai_provider.added"), sql`NOT ${had}`),
      outboxedWhere(db, entry("ai_provider.replaced"), had),
      db
        .insert(aiProviderKeys)
        .values({
          provider,
          sealed,
          mask: maskOf(key),
          baseUrl,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: aiProviderKeys.provider,
          set: { sealed, mask: maskOf(key), baseUrl, updatedAt: now },
        })
        .returning(),
    ]);
    const [kept] = written;
    if (kept === undefined) {
      throw new Error("The key's row wasn't written");
    }
    return kept;
  });
  log.info("ai.key_saved", { provider });
  return keyOf(row);
};

/**
 * Deletes the organization's key for a provider, recorded in `by`'s name
 * (`ai_provider.removed`) in the same batch when it had one; whether it
 * had one.
 */
export const removeAiProviderKey = async (
  env: Env,
  provider: unknown,
  by: unknown
): Promise<boolean> => {
  const parsed = aiProviderIdSchema.safeParse(provider);
  if (!parsed.success) {
    throw aiKeyErrors.create("ai_key.invalid");
  }
  const actor = changerOf(by);
  const which = eq(aiProviderKeys.provider, parsed.data);
  const removed = await writing(
    parsed.data,
    async () =>
      await recordEventIf(
        env,
        {
          actor,
          action: "ai_provider.removed",
          target: { type: "ai_provider", id: parsed.data },
          detail: { provider: parsed.data },
        },
        { from: aiProviderKeys, where: which },
        [drizzle(env.DB).delete(aiProviderKeys).where(which)]
      )
  );
  log.info("ai.key_removed", {
    provider: parsed.data,
    removed: removed ? 1 : 0,
  });
  return removed;
};

/** The organization's keys, as masks, in the providers' order. */
export const listAiProviderKeys = async (
  env: Env
): Promise<AiProviderKey[]> => {
  const rows = await drizzle(env.DB).select().from(aiProviderKeys);
  return rows
    .filter((row) => aiProviderIdSchema.safeParse(row.provider).success)
    .map(keyOf)
    .toSorted(
      (one, other) =>
        aiProviderIds.indexOf(one.provider) -
        aiProviderIds.indexOf(other.provider)
    );
};

/** Grasp's own key for `provider`, if this deployment has one. */
const platformKeyOf = (
  env: Env,
  provider: AiProviderId
): string | undefined => {
  const name = aiProviders[provider].platformSecret;
  const key = name === undefined ? undefined : env[name];
  return typeof key === "string" && key.trim() !== "" ? key.trim() : undefined;
};

/** What core routes by: never a key. */
export const aiProviderRoutes = async (env: Env): Promise<AiProviderRoutes> => {
  const keys = await listAiProviderKeys(env);
  return {
    organization: keys.map(({ provider, baseUrl }) => ({ provider, baseUrl })),
    platform: aiProviderIds.filter(
      (provider) => platformKeyOf(env, provider) !== undefined
    ),
  };
};

/**
 * The organization's key for `provider`, opened, with the base URL it may
 * go to; none without one, or when it doesn't open.
 */
const organizationKeyOf = async (
  env: Env,
  provider: AiProviderId
): Promise<{ key: string; baseUrl: string | null } | undefined> => {
  const [row] = await drizzle(env.DB)
    .select()
    .from(aiProviderKeys)
    .where(eq(aiProviderKeys.provider, provider));
  const vault = row === undefined ? undefined : await vaultFor(env);
  if (row === undefined || vault === undefined) {
    return undefined;
  }
  try {
    return {
      key: await vault.open(row.sealed, contextOf(provider, row.baseUrl)),
      baseUrl: row.baseUrl,
    };
  } catch (error) {
    log.error("ai.key_unreadable", { provider, ...errorFields(error) });
    return undefined;
  }
};

/** Connect's refusal of a model request: it never reached the provider. */
const refused = (
  reason: AiRefusal,
  claims?: Pick<ModelGrantClaims, "provider" | "credential">
): Response => {
  log.warn("ai.refused", {
    reason,
    provider: claims?.provider,
    credential: claims?.credential,
  });
  // A request that may have reached the provider without an answer is a
  // failure core can't call refused: never sent again, nor billed as nothing.
  const status = reason === "unreachable" ? 502 : 400;
  return Response.json(
    { error: { type: `grasp_${reason}` } },
    { status, headers: { [aiRefusedHeader]: reason } }
  );
};

/** The request headers a provider's API needs, and nothing else of core's. */
const forwardedHeaders = [
  "content-type",
  "accept",
  "anthropic-version",
  "anthropic-beta",
  "x-request-id",
] as const;

/** The response headers core may read: never a cookie, nor a refusal's. */
const answeredHeaders = [
  "content-type",
  "retry-after",
  "retry-after-ms",
  "request-id",
  "x-request-id",
] as const;

/** Whether `request` carries the placeholder, exactly, where the key goes. */
const carriesPlaceholder = (
  request: Request,
  provider: AiProviderId
): boolean =>
  aiProviders[provider].keyHeader === "x-api-key"
    ? request.headers.get("x-api-key") === aiCredentialPlaceholder
    : request.headers.get("authorization") ===
      `Bearer ${aiCredentialPlaceholder}`;

/** Whether `url` is one of the provider's model endpoints, at `base`. */
const isModelEndpoint = (
  url: URL,
  provider: AiProviderId,
  base: URL
): boolean => {
  const prefix = base.pathname.replace(/\/+$/u, "");
  // A fixed provider's paths are whole; a custom endpoint's sit below its
  // base URL's own path.
  const custom = provider === "openai-compatible";
  return aiProviders[provider].paths.some(
    (path) => url.pathname === (custom ? `${prefix}${path}` : path)
  );
};

/** Where the credential for `claims` may be sent, and the key. */
interface Destination {
  key: string;
  base: URL;
}

/** The key and where it may go, for `claims`; none when there is no key. */
const destinationOf = async (
  env: Env,
  { provider, credential, host: granted }: ModelGrantClaims
): Promise<Destination | undefined> => {
  if (credential === "platform") {
    // Grasp's own key goes to the host core's grant names, its project's
    // region's (`platformRouteOf`), only when it is one of that provider's
    // own hosts: OpenAI's EU or US host. Any other leaves the provider's
    // first, which the request's own host then fails as `endpoint`.
    const key = platformKeyOf(env, provider);
    const hosts = platformHostsOf(provider);
    const host = hosts.includes(granted) ? granted : hosts[0];
    return key === undefined || host === undefined
      ? undefined
      : { key, base: new URL(`https://${host}`) };
  }
  const found = await organizationKeyOf(env, provider);
  if (found === undefined) {
    return undefined;
  }
  if (found.baseUrl !== null) {
    return { key: found.key, base: new URL(found.baseUrl) };
  }
  const host = aiProviderHost(provider);
  return host === undefined
    ? undefined
    : { key: found.key, base: new URL(`https://${host}`) };
};

/**
 * The query a model request may carry: none, or the one Anthropic's SDK
 * puts on its beta Messages API (`?beta=true`), which names no data.
 */
const allowedQueries: ReadonlySet<string> = new Set(["", "?beta=true"]);

/**
 * How long past the call's deadline connect still lets a request run: core
 * cuts it off at its deadline itself; this is the backstop should core's
 * cut never reach here.
 */
const deadlineBackstopMs = 5000;

/** The longest a provider may take to accept a realtime socket. */
const socketOpenMs = 10_000;

/** Whether `url` may be sent to, `base`'s origin, checked again as it is sent. */
const sendsToBase = (url: URL, base: URL, policy: EndpointPolicy): boolean => {
  const checked = checkEndpoint(url.href, policy);
  return (
    !("refused" in checked) &&
    url.origin === base.origin &&
    allowedQueries.has(url.search) &&
    url.hash === ""
  );
};

/** The request's headers for the provider, the key in its one header. */
const headersFor = (
  request: Request,
  provider: AiProviderId,
  key: string
): Headers => {
  const headers = new Headers();
  for (const name of forwardedHeaders) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  if (aiProviders[provider].keyHeader === "x-api-key") {
    headers.set("x-api-key", key);
  } else {
    headers.set("authorization", `Bearer ${key}`);
  }
  return headers;
};

/** The provider's response as core may read it: its status, body and few headers. */
const passedBack = (answered: Response): Response => {
  const headers = new Headers();
  for (const name of answeredHeaders) {
    const value = answered.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  return new Response(answered.body, { status: answered.status, headers });
};

/** OpenAI's model paths whose JSON bodies take `store`. */
const storingPaths: ReadonlySet<string> = new Set([
  "/v1/responses",
  "/v1/chat/completions",
]);

/** Fields that build on what OpenAI kept of an earlier request. */
const storedContextFields = ["previous_response_id", "conversation"] as const;

/**
 * The body to send: on Grasp's own key to OpenAI, with `store: false`
 * whatever core sent, so nothing of one client's is kept where another
 * holding the same key could read it; `undefined` for one that names a
 * stored response or conversation, or isn't a JSON object. Any other
 * request's body goes as it came: an organization's own key keeps what
 * its owner's account settings say (pi asks `store: false` anyway).
 */
const unstoredBody = (
  asked: ArrayBuffer,
  claims: ModelGrantClaims,
  url: URL
): ArrayBuffer | Uint8Array | undefined => {
  if (
    claims.credential !== "platform" ||
    claims.provider !== "openai" ||
    !storingPaths.has(url.pathname)
  ) {
    return asked;
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(asked));
  } catch {
    return undefined;
  }
  if (
    typeof json !== "object" ||
    json === null ||
    Array.isArray(json) ||
    storedContextFields.some((field) => field in json)
  ) {
    return undefined;
  }
  return new TextEncoder().encode(JSON.stringify({ ...json, store: false }));
};

/**
 * A signal that aborts when core stops the request (`modelFetch`'s
 * `stop`, core's model-transport-connect.ts): a byte arrives, or the
 * stream breaks, as when core went away; and `release`, once the answer
 * began, after which cancelling its body stops it. Never aborts without
 * a stream.
 */
const stoppedBy = (
  stop: unknown
): { signal: AbortSignal; release: () => void } => {
  const controller = new AbortController();
  if (!(stop instanceof ReadableStream)) {
    return {
      signal: controller.signal,
      release: () => {
        // Nothing listened.
      },
    };
  }
  const reader = stop.getReader();
  let released = false;
  const listen = async () => {
    try {
      const { done } = await reader.read();
      if (done) {
        return;
      }
    } catch {
      // Broken: core went away.
    }
    if (!released) {
      controller.abort();
    }
  };
  const release = async () => {
    released = true;
    try {
      await reader.cancel();
    } catch {
      // Core closed it already.
    }
  };
  void listen();
  return {
    signal: controller.signal,
    release: () => {
      void release();
    },
  };
};

/** Whether an HTTP status sends the client elsewhere. */
const isRedirect = (status: number): boolean => status >= 300 && status < 400;

/**
 * Sends one provider request of a model call core's gateway decided, with
 * the credential its grant names, or refuses it (`aiRefusedHeader`).
 */
export const modelFetch = async (
  env: Env,
  signingKeys: readonly string[],
  request: unknown,
  grant: unknown,
  stop?: unknown
): Promise<Response> => {
  if (!(request instanceof Request)) {
    return refused("method");
  }
  let claims: ModelGrantClaims;
  try {
    claims = await verifyModelGrant(signingKeys, grant);
  } catch {
    return refused("grant");
  }
  if (request.method !== "POST") {
    return refused("method", claims);
  }
  if (!carriesPlaceholder(request, claims.provider)) {
    return refused("credential_header", claims);
  }
  const destination = await destinationOf(env, claims);
  if (destination === undefined) {
    return refused("no_credential", claims);
  }
  const { key, base } = destination;
  // A Request's URL is always absolute and parsed.
  const url = new URL(request.url);
  if (url.hostname !== claims.host || !sendsToBase(url, base, policyOf(env))) {
    return refused("endpoint", claims);
  }
  if (!isModelEndpoint(url, claims.provider, base)) {
    return refused("path", claims);
  }
  const startedAt = Date.now();
  const asked = await request.arrayBuffer();
  if ((await sha256HexOfBytes(asked)) !== claims.body) {
    return refused("body", claims);
  }
  const body = unstoredBody(asked, claims, url);
  if (body === undefined) {
    return refused("stored", claims);
  }
  const stopped = stoppedBy(stop);
  let answered: Response;
  try {
    answered = await fetch(url, {
      method: "POST",
      headers: headersFor(request, claims.provider, key),
      body,
      redirect: "manual",
      signal: AbortSignal.any([
        stopped.signal,
        AbortSignal.timeout(
          Math.max(1, claims.notAfter - startedAt + deadlineBackstopMs)
        ),
      ]),
    });
  } catch (error) {
    if (stopped.signal.aborted) {
      // Core stopped waiting: nobody reads this refusal.
      log.info("ai.stopped", {
        provider: claims.provider,
        credential: claims.credential,
        request: claims.request,
        ms: Date.now() - startedAt,
      });
      return refused("unreachable", claims);
    }
    // Never the error's message, which may name the URL: its kind only.
    log.warn("ai.unanswered", {
      provider: claims.provider,
      credential: claims.credential,
      error: error instanceof Error ? error.name : "unknown",
    });
    return refused("unreachable", claims);
  } finally {
    stopped.release();
  }
  log.info("ai.request", {
    provider: claims.provider,
    credential: claims.credential,
    request: claims.request,
    status: answered.status,
    ms: Date.now() - startedAt,
  });
  if (isRedirect(answered.status)) {
    // Never followed: an endpoint that moves is refused, its body unread.
    await answered.body?.cancel();
    return refused("redirect", claims);
  }
  return passedBack(answered);
};

/** Passes a message's `data` on to `to` while it is open; a closed socket drops it. */
const passOn = (to: WebSocket, data: unknown): void => {
  if (!(typeof data === "string" || data instanceof ArrayBuffer)) {
    return;
  }
  try {
    to.send(data);
  } catch {
    // Closed meanwhile: its close ends the other end too.
  }
};

/** Closes `socket` with `code`, if it is still open. */
const closeEnd = (socket: WebSocket, code: number): void => {
  try {
    // 1005 and 1006 are reported, never sent.
    socket.close(code === 1005 || code === 1006 ? 1011 : code, "");
  } catch {
    // Closed already.
  }
};

/**
 * Opens a realtime WebSocket of a model call core's gateway decided (a
 * listening, core's models.ts) to the provider, with Grasp's key, and
 * relays it: the upgrade carries its grant (`aiGrantHeader`) and the
 * placeholder where the key goes, to the provider's own realtime URL.
 * Its client end, or connect's refusal (`aiRefusedHeader`).
 */
export const modelSocket = async (
  env: Env,
  signingKeys: readonly string[],
  request: Request
): Promise<Response> => {
  let claims: ModelGrantClaims;
  try {
    claims = await verifyModelGrant(
      signingKeys,
      request.headers.get(aiGrantHeader)
    );
  } catch {
    return refused("grant");
  }
  if (
    request.method !== "GET" ||
    request.headers.get("upgrade")?.toLowerCase() !== "websocket"
  ) {
    return refused("method", claims);
  }
  // Only Grasp's own key opens a socket: no organization's is ever held
  // open for minutes on end.
  if (claims.credential !== "platform") {
    return refused("no_credential", claims);
  }
  if (!carriesPlaceholder(request, claims.provider)) {
    return refused("credential_header", claims);
  }
  const destination = await destinationOf(env, claims);
  if (destination === undefined) {
    return refused("no_credential", claims);
  }
  const url = new URL(request.url);
  const { base, key } = destination;
  const checked = checkEndpoint(url.href, policyOf(env));
  if (
    url.hostname !== claims.host ||
    "refused" in checked ||
    url.origin !== base.origin ||
    url.hash !== ""
  ) {
    return refused("endpoint", claims);
  }
  if (
    !aiProviders[claims.provider].realtime.some(
      ({ path, query }) => url.pathname === path && url.search === query
    )
  ) {
    return refused("path", claims);
  }
  const startedAt = Date.now();
  let answered: Response;
  try {
    answered = await fetch(url, {
      headers: { upgrade: "websocket", authorization: `Bearer ${key}` },
      redirect: "manual",
      signal: AbortSignal.timeout(socketOpenMs),
    });
  } catch (error) {
    log.warn("ai.unanswered", {
      provider: claims.provider,
      credential: claims.credential,
      error: error instanceof Error ? error.name : "unknown",
    });
    return refused("unreachable", claims);
  }
  const upstream = answered.webSocket;
  if (upstream === null) {
    log.warn("ai.socket_refused", {
      provider: claims.provider,
      status: answered.status,
    });
    await answered.body?.cancel();
    return refused("upgrade", claims);
  }
  upstream.accept();
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  log.info("ai.socket", {
    provider: claims.provider,
    credential: claims.credential,
    request: claims.request,
    ms: Date.now() - startedAt,
  });
  const ending = setTimeout(
    () => {
      closeEnd(upstream, 1000);
      closeEnd(server, 1000);
    },
    Math.max(1, claims.notAfter - startedAt + deadlineBackstopMs)
  );
  const end = (code: number): void => {
    clearTimeout(ending);
    closeEnd(upstream, code);
    closeEnd(server, code);
  };
  server.addEventListener("message", (event) => {
    passOn(upstream, event.data);
  });
  upstream.addEventListener("message", (event) => {
    passOn(server, event.data);
  });
  server.addEventListener("close", ({ code }) => {
    end(code);
  });
  upstream.addEventListener("close", ({ code }) => {
    end(code);
  });
  server.addEventListener("error", () => {
    end(1011);
  });
  upstream.addEventListener("error", () => {
    end(1011);
  });
  return new Response(null, { status: 101, webSocket: client });
};

/**
 * Seals again, with the current key, the organization's AI keys the
 * previous key sealed, a batch at a time (src/clock.ts).
 */
export const resealAiProviderKeys = async (env: Env): Promise<void> => {
  const vault = await vaultFor(env);
  if (vault?.sealedWithPrevious === undefined) {
    return;
  }
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(aiProviderKeys)
    .where(like(aiProviderKeys.sealed, vault.sealedWithPrevious))
    .limit(resealBatchSize);
  for (const row of rows) {
    const parsed = aiProviderIdSchema.safeParse(row.provider);
    if (!parsed.success) {
      continue;
    }
    const context = contextOf(parsed.data, row.baseUrl);
    let key: string;
    try {
      // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
      key = await vault.open(row.sealed, context);
    } catch (error) {
      // Left as it is: it goes on failing its provider's calls as
      // `no_credential`, and an admin adds the key again.
      log.error("ai.key_unreadable", {
        provider: parsed.data,
        ...errorFields(error),
      });
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
    const sealed = await vault.seal(key, context);
    // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
    await db
      .update(aiProviderKeys)
      .set({ sealed })
      .where(
        and(
          eq(aiProviderKeys.provider, row.provider),
          eq(aiProviderKeys.sealed, row.sealed)
        )
      );
  }
};
