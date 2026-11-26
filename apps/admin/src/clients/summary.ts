/**
 * Every client's summary, as the admin's sidebar and Inbox show it: what
 * each core answers at `adminSummaryPath` (core's src/admin-summary.ts),
 * counts and dates only, beside what its Stripe customer says is overdue.
 * Asked as the grid asks for the onboarding summary (onboarding.ts):
 * through the router's route with the router secret, signed with the key
 * both derive from the client's auth secret, here for the summary's
 * purpose alone. Unlike the admin snapshot (admin.ts) it names nobody, so
 * no staff member is named and no core audits the read: the frame can
 * read it on every load.
 *
 * Every client the admin knows but those offboarded is in the answer, read
 * a few at a time (src/live-reads.ts), each within the grid's deadline
 * from when its own read starts, as the snapshots are read, so one slow or
 * failing core never holds up the others. One whose core doesn't answer is
 * unreachable; one not deployed yet, not deployed; one on a release from
 * before the summary, older, read in full as before until it updates. An answer is kept a
 * minute in the Worker's cache, as the grid keeps its live answers: the
 * frame reads it on every load, for every staff member, and its weekly
 * count of active people reads weeks of the company's audit log. Counts
 * and dates only, never persisted: the admin holds no client data.
 */
import "@tanstack/react-start/server-only";
import {
  adminSummaryPath,
  adminSummaryPurpose,
  adminSummarySchema,
} from "@grasp-os/shared/admin-summary";
import type { AdminSummary } from "@grasp-os/shared/admin-summary";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toHex } from "@grasp-os/shared/encoding";
import { log } from "@grasp-os/shared/log";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import { routerSecretHeader } from "@grasp-os/shared/router";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { billingOf, stripeKey, stripeLinks } from "../billing/billing.ts";
import type { Billing } from "../billing/billing.ts";
import { adminDatabase } from "../db/act.ts";
import { deploySecrets, ifStored } from "../deploy/context.ts";
import { errorCode } from "../deploy/errors.ts";
import { clientAuthSecret } from "../deploy/secrets.ts";
import type { DeploySecrets } from "../deploy/secrets.ts";
import { eachLimited, within } from "../live-reads.ts";
import { clientAdmins, defaultAdminReadOptions } from "./admin.ts";
import type { AdminReadOptions, ClientAdmin } from "./admin.ts";
import { clientGrid, routeOf } from "./grid.ts";
import type { GridRow } from "./grid.ts";

const encoder = new TextEncoder();

/** One client's summary, with its billing; or why there is none now. */
export type ClientSummary =
  | {
      client: GridRow;
      state: "answered";
      summary: AdminSummary;
      /** What it pays and whether it is paid, as Stripe says, or why that isn't read. */
      billing: Billing;
    }
  | {
      client: GridRow;
      /**
       * Its core is on a release from before the summary (it answers 404):
       * its full snapshot is read instead, as before, so what needs Grasp
       * there stays readable until it updates.
       */
      state: "older";
      admin: Extract<ClientAdmin, { state: "answered" }>;
    }
  | { client: GridRow; state: "not_deployed" | "unreachable" };

/** The cache summaries are kept in, and for how long. */
const cacheName = "admin-summary";
const cacheSeconds = 60;

/**
 * How long a forget is remembered: past the life of any answer a read
 * begun before it could still keep, which keeps a minute from when that
 * read ends, within its deadline.
 */
const forgottenSeconds = 2 * cacheSeconds;

/** Where client `clientId`'s summary is kept: a URL only the admin uses. */
const cacheKey = (clientId: string): string =>
  `https://admin-summary.admin.invalid/${encodeURIComponent(clientId)}`;

/** Where the last time client `clientId`'s summary was forgotten is kept. */
const forgottenKey = (clientId: string): string =>
  `https://admin-summary.admin.invalid/forgotten/${encodeURIComponent(clientId)}`;

/** A summary as kept: with when the read that answered it was asked. */
const keptSchema = z.object({
  askedAt: z.number(),
  summary: adminSummarySchema,
});

/** When client `clientId`'s summary was last forgotten, in Unix milliseconds; 0 for not lately. */
const forgottenAt = async (cache: Cache, clientId: string): Promise<number> => {
  const marker = await cache.match(forgottenKey(clientId));
  if (marker === undefined) {
    return 0;
  }
  const at = z.number().safeParse(await marker.json());
  return at.success ? at.data : 0;
};

/**
 * Client `clientId`'s summary kept within the last minute, if any, and
 * asked after it was last forgotten: an answer to a read asked before a
 * forget, kept after it, is never served. A cache that fails is a miss.
 */
const cached = async (clientId: string): Promise<AdminSummary | null> => {
  try {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(cacheKey(clientId));
    if (hit === undefined) {
      return null;
    }
    const parsed = keptSchema.safeParse(await hit.json());
    if (!parsed.success) {
      return null;
    }
    return parsed.data.askedAt > (await forgottenAt(cache, clientId))
      ? parsed.data.summary
      : null;
  } catch (error) {
    log.warn("admin.summary_cache_unread", {
      clientId,
      error: errorCode(error),
    });
    return null;
  }
};

/**
 * Forgets client `clientId`'s kept summary, so the next read asks its
 * core: after staff changed something its summary counts (a command, the
 * kickoff), as the frame reads again then. It keeps when, in the cache
 * every isolate of the location shares, so an answer to a read asked
 * before now that is kept after it is never served (`cached`). A cache
 * that fails to forget it is logged: the summary is then at most a minute
 * old, as any kept one.
 */
export const forgetSummary = async (clientId: string): Promise<void> => {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(
      forgottenKey(clientId),
      Response.json(Date.now(), {
        headers: { "cache-control": `max-age=${forgottenSeconds}` },
      })
    );
    await cache.delete(cacheKey(clientId));
  } catch (error) {
    log.warn("admin.summary_cache_unforgotten", {
      clientId,
      error: errorCode(error),
    });
  }
};

/**
 * Keeps client `clientId`'s summary for a minute, with when its read was
 * asked (`askedAt`); a cache that fails to keep it is logged.
 */
const keep = async (
  clientId: string,
  summary: AdminSummary,
  askedAt: number
): Promise<void> => {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(
      cacheKey(clientId),
      Response.json(
        { askedAt, summary },
        { headers: { "cache-control": `max-age=${cacheSeconds}` } }
      )
    );
  } catch (error) {
    log.warn("admin.summary_cache_unkept", {
      clientId,
      error: errorCode(error),
    });
  }
};

/**
 * Client `row`'s summary, asked of its core within `timeoutMs` from when
 * this is called, signed for the summary's purpose alone, never following
 * a redirect (it would take the signed body and the router secret
 * elsewhere); `older` when its core answers 404, a release from before
 * the summary; null when it can't be asked or doesn't answer with one.
 * Never throws.
 */
const askedSummary = async (
  env: Env,
  secrets: DeploySecrets | null,
  row: GridRow,
  timeoutMs: number
): Promise<AdminSummary | "older" | null> =>
  await within(
    timeoutMs,
    async (signal) => {
      if (secrets === null) {
        return null;
      }
      const route = await routeOf(
        env.ROUTER_HOSTS,
        secrets.routerKey,
        row.id,
        row.hostname,
        env.DISPATCHER
      );
      if (typeof route === "string") {
        return null;
      }
      try {
        const body = JSON.stringify({ sentAt: new Date().toISOString() });
        const key = await hkdfHmacKey(
          await clientAuthSecret(secrets, row.id, route.generation),
          adminSummaryPurpose,
          ["sign"]
        );
        const signature = toHex(
          new Uint8Array(
            await crypto.subtle.sign("HMAC", key, encoder.encode(body))
          )
        );
        const response = await route.core.fetch(
          `${route.core.origin}${adminSummaryPath}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [routerSecretHeader]: route.secret,
              [platformUpdateSignatureHeader]: signature,
            },
            body,
            redirect: "manual",
            signal,
          }
        );
        if (!response.ok) {
          await response.body?.cancel();
          return response.status === 404 ? "older" : null;
        }
        const parsed = adminSummarySchema.safeParse(await response.json());
        return parsed.success ? parsed.data : null;
      } catch (error) {
        log.warn("admin.summary_unread", {
          clientId: row.id,
          error: errorCode(error),
        });
        return null;
      }
    },
    null
  );

/**
 * Client `row`'s summary: kept within the last minute, else asked of its
 * core within `timeoutMs` from when this is called and kept; null when it
 * can't be asked or doesn't answer with one. Never throws.
 */
const summaryOf = async (
  env: Env,
  secrets: DeploySecrets | null,
  row: GridRow,
  timeoutMs: number
): Promise<AdminSummary | "older" | null> => {
  const kept = await cached(row.id);
  if (kept !== null) {
    return kept;
  }
  const askedAt = Date.now();
  const read = await askedSummary(env, secrets, row, timeoutMs);
  if (read !== null && read !== "older") {
    await keep(row.id, read, askedAt);
  }
  return read;
};

/**
 * Every client the admin knows but those offboarded, each with its
 * summary and billing, or why there is none now. Never throws for a
 * client; every one is in the answer, in the grid's order.
 */
export const clientSummaries = async (
  env: Env,
  staff: Staff,
  options: AdminReadOptions = defaultAdminReadOptions
): Promise<ClientSummary[]> => {
  const db = adminDatabase(env.DB);
  const grid = await clientGrid(env);
  const known = grid.filter(({ status }) => status !== "offboarded");
  const [secrets, key, links] = await Promise.all([
    ifStored(async (): Promise<DeploySecrets> => await deploySecrets(env)),
    stripeKey(env),
    stripeLinks(db),
  ]);
  // Each client's deadline starts inside its turn, not here.
  return await eachLimited(
    known,
    options.concurrency,
    async (client): Promise<ClientSummary> => {
      if (client.status !== "active") {
        return { client, state: "not_deployed" };
      }
      const [summary, billing] = await Promise.all([
        summaryOf(env, secrets, client, options.timeoutMs),
        billingOf({
          key,
          customerId: links.get(client.id) ?? null,
          clientId: client.id,
          timeoutMs: options.timeoutMs,
        }),
      ]);
      if (summary === "older") {
        // As before the summary: its full snapshot, read as `staff`, whom
        // its audit log records, for this client alone. Not read either, it
        // is a client whose core didn't answer.
        const [admin] = await clientAdmins(env, staff, options, client.id);
        return admin?.state === "answered"
          ? { client, state: "older", admin }
          : { client, state: "unreachable" };
      }
      return summary === null
        ? { client, state: "unreachable" }
        : { client, state: "answered", summary, billing };
    }
  );
};
