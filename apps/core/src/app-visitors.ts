import {
  appVisitorAddressSchema,
  appVisitorCodeDigits,
  appVisitorCodeMinutes,
  appVisitorCodeSchema,
  appVisitorCodesPerAddressPerHour,
  appVisitorCodesPerAppPerHour,
  appVisitorCodeTriesMax,
  appVisitorDomainOf,
  appVisitorErrors,
  appVisitorListSchema,
  appVisitorRequestSchema,
  appVisitorSessionHours,
} from "@grasp-os/shared/app-visitors";
import type {
  AppVisitorEntry,
  AppVisitorSession,
} from "@grasp-os/shared/app-visitors";
import type { App } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import { randomToken, sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError, requestErrors } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import type { ScreenBundle } from "@grasp-os/shared/screens";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { editableApp, toApp } from "./apps.ts";
import {
  auditedBatch,
  keepAuditEvent,
  outboxed,
  outboxedIfChanged,
} from "./audit-outbox.ts";
import {
  apps,
  appVisitorCodes,
  appVisitorEntries,
  appVisitorSessions,
} from "./db/core/schema.ts";
import { errorResponse } from "./errors.ts";
import { escapeHtml } from "./mail-outbox.ts";
import { sendMail } from "./mail.ts";
import { boundedText, jsonOf } from "./request-body.ts";
import { visitorScreen } from "./screens-rpc.ts";
import { requireNotStaff } from "./sharing.ts";

// Visitors (`@grasp-os/shared/app-visitors`): someone who isn't a member
// opens a published App at its own link (app-own-links.ts) after signing
// in with a code mailed to them. It is a way in from outside, so here is
// each way it can be attacked, and what stops it. Each has a test in
// test/app-visitors.test.ts.
//
// - Anyone asking for a code. Only an address the App's builders listed,
//   or one at a domain they listed, is sent one, and only while the App
//   is published. The answer is the same whether a code went out or not
//   (and whatever the link names), so asking tells nobody what is listed.
// - A look-alike domain, or an address made to read as a listed one.
//   Addresses and domains are ASCII and lower case only
//   (`appVisitorAddressSchema`): a name in another script must be listed
//   by its `xn--` form, so `exаmple.com` with a Cyrillic `а` is refused,
//   not matched. A domain matches only itself: neither `sub.example.com`
//   nor `example.com.evil.test` is `example.com`. A quoted local part, a
//   second `@`, a trailing dot or a comment never parses, so nothing in
//   an address can name another domain. `a+b@example.com` is its own
//   address, matched only by its domain or by itself.
// - Guessing a code. A code is 8 random digits, kept only as a salted
//   SHA-256 and compared in constant time. It works for 10 minutes and
//   takes 5 tries; at most 5 codes go to one address for one App in an
//   hour, and 100 for the App in all. So a guesser has 25 tries in 10^8
//   an hour per address, and every wrong try is audited. The router
//   limits the endpoint per client address too.
// - Mail bombing someone through the App: the same 5 an hour per address
//   and 100 per App; each code sent is audited.
// - A session used for something else. A session (256 random bits, kept
//   as its SHA-256) belongs to one App: opening takes only the token and
//   answers that App's screen, and signing in to another App needs that
//   App's own code. A visitor never holds a member's session, so `/rpc`
//   and every member's route refuse them.
// - The screen reaching past the App. The screen runs in the frame core
//   serves for every screen (screen-frame.ts), and no App function is
//   called for a visitor: function calls need a member's session
//   (app-function-route.ts), and the lease a visitor's screen gets is for
//   `visitor:<session>`, which no member's is. Nothing runs as a member,
//   or as anyone: what a screen shows a visitor is what its code holds.
// - Access that outlives its reason. On every open, the session must be
//   unexpired (8 hours at most), the App still published, and the address
//   still listed; removing it from the list, or unpublishing, ends it at
//   once. Signing out deletes the session.
// - Unseen. Every code sent and every refusal (an address not listed,
//   too many codes, a wrong or used-up code), every sign-in and sign-out
//   is audited as the visitor; setting the list is audited as the
//   builder. A refusal of an address not listed keeps only its domain.
//
// Codes are deleted an hour after they were sent, once they can't count
// towards the hour's limits; sessions once they expire (`sweepAppVisitors`).

const minuteMs = 60 * 1000;
const hourMs = 60 * minuteMs;

/** The most a visitor's request may carry: an address and a code. */
const requestMaxLength = 4 * 1024;

/** Most rows the sweep deletes of each, a run. */
const sweptPerRun = 500;

/** A visitor as the audit log names them. */
const visitorActor = (app: AppId, sessionId?: string): AuditActor => ({
  type: "visitor",
  appId: app,
  ...(sessionId === undefined ? {} : { sessionId }),
});

const appTarget = (app: AppId) => ({ type: "app", id: app });

/** An entry as one word: its kind and value. */
const entryKey = (entry: AppVisitorEntry): string =>
  `${entry.kind}:${entry.value}`;

/** An App's list, in a stable order. */
const listOf = async (env: Env, app: AppId): Promise<AppVisitorEntry[]> => {
  const rows = await drizzle(env.DB)
    .select({ kind: appVisitorEntries.kind, value: appVisitorEntries.value })
    .from(appVisitorEntries)
    .where(eq(appVisitorEntries.appId, app))
    .orderBy(asc(appVisitorEntries.kind), asc(appVisitorEntries.value));
  return rows;
};

/** Who may visit App `app`, for its builders. */
export const appVisitors = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<AppVisitorEntry[]> => {
  const found = await editableApp(env, by, app);
  return await listOf(env, found.id);
};

/**
 * Sets who may visit App `app`, the whole list at once, for its builders.
 * Whoever leaves the list can't open it from their next request on.
 */
export const setAppVisitors = async (
  env: Env,
  by: Identity,
  app: unknown,
  list: unknown
): Promise<AppVisitorEntry[]> => {
  requireNotStaff(by);
  const parsed = appVisitorListSchema.safeParse(list);
  if (!parsed.success) {
    throw appVisitorErrors.create("visitor.invalid");
  }
  const found = await editableApp(env, by, app);
  const wanted = [
    ...new Map(
      parsed.data.map((entry) => [`${entry.kind}:${entry.value}`, entry])
    ).values(),
  ];
  const before = await listOf(env, found.id);
  const had = new Set(before.map(entryKey));
  const has = new Set(wanted.map(entryKey));
  const added = wanted.filter((entry) => !had.has(entryKey(entry)));
  const removed = before.filter((entry) => !has.has(entryKey(entry)));
  if (added.length === 0 && removed.length === 0) {
    return before;
  }
  const db = drizzle(env.DB);
  const now = new Date();
  await auditedBatch(env, db, [
    db.delete(appVisitorEntries).where(eq(appVisitorEntries.appId, found.id)),
    ...wanted.map((entry) =>
      db.insert(appVisitorEntries).values({
        appId: found.id,
        kind: entry.kind,
        value: entry.value,
        addedBy: by.userId,
        addedAt: now,
      })
    ),
    outboxed(db, {
      actor: actorOf(by),
      action: "app.visitors_set",
      target: appTarget(found.id),
      detail: {
        added: added.map(entryKey).join(" "),
        removed: removed.map(entryKey).join(" "),
      },
    }),
  ]);
  return await listOf(env, found.id);
};

/** The published App at `link`, or undefined. */
const publishedAt = async (
  env: Env,
  link: string
): Promise<App | undefined> => {
  const row = await drizzle(env.DB)
    .select()
    .from(apps)
    .where(and(eq(apps.link, link), eq(apps.status, "published")))
    .get();
  return row === undefined ? undefined : toApp(row);
};

/** The published App `app`, or undefined. */
const publishedApp = async (env: Env, app: AppId): Promise<App | undefined> => {
  const row = await drizzle(env.DB)
    .select()
    .from(apps)
    .where(and(eq(apps.id, app), eq(apps.status, "published")))
    .get();
  return row === undefined ? undefined : toApp(row);
};

/** Whether `address` is on App `app`'s list, itself or by its domain. */
const isListed = async (
  env: Env,
  app: AppId,
  address: string
): Promise<boolean> => {
  const row = await drizzle(env.DB)
    .select({ kind: appVisitorEntries.kind })
    .from(appVisitorEntries)
    .where(
      and(
        eq(appVisitorEntries.appId, app),
        or(
          and(
            eq(appVisitorEntries.kind, "address"),
            eq(appVisitorEntries.value, address)
          ),
          and(
            eq(appVisitorEntries.kind, "domain"),
            eq(appVisitorEntries.value, appVisitorDomainOf(address))
          )
        )
      )
    )
    .get();
  return row !== undefined;
};

/** The largest multiple of 10^digits a 32-bit number can be under. */
const codeRange = 10 ** appVisitorCodeDigits;
const codeCeiling = Math.floor(2 ** 32 / codeRange) * codeRange;

/** A code of 8 uniformly random digits. */
const newCode = (): string => {
  const draw = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(draw);
    const [value = codeCeiling] = draw;
    // Past the last whole range: drawn again, so no digit is likelier.
    if (value < codeCeiling) {
      return String(value % codeRange).padStart(appVisitorCodeDigits, "0");
    }
  }
};

/** A code's hash, salted with its row's ID. */
const codeHashOf = async (id: string, code: string): Promise<string> =>
  await sha256Hex(`${id}:${code}`);

/** Whether two hex hashes are the same, in constant time. */
const sameHash = (a: string, b: string): boolean => {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  return (
    left.byteLength === right.byteLength &&
    crypto.subtle.timingSafeEqual(left, right)
  );
};

/** A code's mail, in plain words. */
const codeMail = (to: string, appName: string, code: string) => {
  const spaced = `${code.slice(0, 4)} ${code.slice(4)}`;
  const text = `Your code to open ${appName} is ${spaced}.\n\nIt works for ${appVisitorCodeMinutes} minutes. If you didn't ask for it, ignore this mail: nobody can open the App without it.`;
  const html = `<p>Your code to open ${escapeHtml(appName)} is <strong>${spaced}</strong>.</p><p>It works for ${appVisitorCodeMinutes} minutes. If you didn't ask for it, ignore this mail: nobody can open the App without it.</p>`;
  return { to, subject: `Your code for ${appName}`, text, html };
};

/** Records `entry` as the visitor, never failing what they asked. */
const audited = async (
  env: Env,
  app: AppId,
  action: string,
  detail: Record<string, string | number | boolean | null>,
  sessionId?: string
): Promise<void> => {
  await keepAuditEvent(env, drizzle(env.DB), {
    actor: visitorActor(app, sessionId),
    action,
    target: appTarget(app),
    detail,
  });
};

/**
 * Sends a code to `address` for the App at `link`, if it is listed and
 * the hour's limits allow. Answers nothing either way.
 */
const askForCode = async (
  env: Env,
  link: string,
  raw: string
): Promise<void> => {
  const parsed = appVisitorAddressSchema.safeParse(raw);
  if (!parsed.success) {
    throw appVisitorErrors.create("visitor.invalid");
  }
  const address = parsed.data;
  const found = await publishedAt(env, link);
  if (found === undefined) {
    return;
  }
  if (!(await isListed(env, found.id, address))) {
    // Only the domain: an address nobody listed isn't kept.
    await audited(env, found.id, "app.visitor_refused", {
      reason: "not_listed",
      domain: appVisitorDomainOf(address),
    });
    return;
  }
  const now = Date.now();
  const code = newCode();
  const id = crypto.randomUUID();
  const hourAgo = new Date(now - hourMs);
  const db = drizzle(env.DB);
  const byAddress = db
    .select({ sent: count() })
    .from(appVisitorCodes)
    .where(
      and(
        eq(appVisitorCodes.appId, found.id),
        eq(appVisitorCodes.address, address),
        gt(appVisitorCodes.sentAt, hourAgo)
      )
    );
  const byApp = db
    .select({ sent: count() })
    .from(appVisitorCodes)
    .where(
      and(
        eq(appVisitorCodes.appId, found.id),
        gt(appVisitorCodes.sentAt, hourAgo)
      )
    );
  // Only under both of the hour's limits, checked as it inserts, so asks
  // at the same time can't go past them.
  const [inserted] = await auditedBatch(env, db, [
    db
      .insert(appVisitorCodes)
      .select(
        sql`SELECT ${id}, ${found.id}, ${address}, ${await codeHashOf(id, code)}, 0, NULL, ${now}, ${now + appVisitorCodeMinutes * minuteMs} WHERE (${byAddress}) < ${appVisitorCodesPerAddressPerHour} AND (${byApp}) < ${appVisitorCodesPerAppPerHour}`
      )
      .returning({ id: appVisitorCodes.id }),
    outboxedIfChanged(db, {
      actor: visitorActor(found.id),
      action: "app.visitor_code_sent",
      target: appTarget(found.id),
      detail: { address },
    }),
  ]);
  if (inserted.length === 0) {
    await audited(env, found.id, "app.visitor_refused", {
      reason: "too_many_codes",
      address,
    });
    return;
  }
  const sent = await sendMail(env, codeMail(address, found.name, code));
  if (sent.outcome !== "sent") {
    // Never the address or the code: only that one wasn't sent.
    log.error("visitor.code_not_sent", { reason: sent.reason });
  }
};

/** The refusal of a code, the same whatever was wrong. */
const codeRefused = async (
  env: Env,
  app: AppId,
  address: string,
  reason: string
): Promise<never> => {
  await audited(env, app, "app.visitor_refused", { reason, address });
  throw appVisitorErrors.create("visitor.code_invalid");
};

/**
 * A session for `address` on the App at `link`, for the code it was last
 * sent: one try of it taken, whatever the code. `visitor.code_invalid`
 * for any reason it doesn't open.
 */
const signIn = async (
  env: Env,
  link: string,
  rawAddress: string,
  rawCode: string
): Promise<AppVisitorSession> => {
  const address = appVisitorAddressSchema.safeParse(rawAddress);
  const code = appVisitorCodeSchema.safeParse(rawCode);
  const found = await publishedAt(env, link);
  if (!address.success || !code.success || found === undefined) {
    throw appVisitorErrors.create("visitor.code_invalid");
  }
  if (!(await isListed(env, found.id, address.data))) {
    return await codeRefused(env, found.id, address.data, "not_listed");
  }
  const db = drizzle(env.DB);
  const now = Date.now();
  const latest = await db
    .select({ id: appVisitorCodes.id, codeHash: appVisitorCodes.codeHash })
    .from(appVisitorCodes)
    .where(
      and(
        eq(appVisitorCodes.appId, found.id),
        eq(appVisitorCodes.address, address.data),
        isNull(appVisitorCodes.usedAt),
        gt(appVisitorCodes.expiresAt, new Date(now))
      )
    )
    .orderBy(desc(appVisitorCodes.sentAt))
    .get();
  if (latest === undefined) {
    return await codeRefused(env, found.id, address.data, "no_code");
  }
  // One try taken before the code is compared, and only while it has
  // tries left: tries at the same time can't take more than 5.
  const [tried] = await db
    .update(appVisitorCodes)
    .set({ tries: sql`${appVisitorCodes.tries} + 1` })
    .where(
      and(
        eq(appVisitorCodes.id, latest.id),
        isNull(appVisitorCodes.usedAt),
        lt(appVisitorCodes.tries, appVisitorCodeTriesMax)
      )
    )
    .returning({ tries: appVisitorCodes.tries });
  if (tried === undefined) {
    return await codeRefused(env, found.id, address.data, "no_tries_left");
  }
  if (!sameHash(await codeHashOf(latest.id, code.data), latest.codeHash)) {
    return await codeRefused(env, found.id, address.data, "wrong_code");
  }
  const token = randomToken();
  const sessionId = crypto.randomUUID();
  const expiresAt = now + appVisitorSessionHours * hourMs;
  // The code is used once: the session goes in only if this took it.
  const [, inserted] = await auditedBatch(env, db, [
    db
      .update(appVisitorCodes)
      .set({ usedAt: new Date(now) })
      .where(
        and(eq(appVisitorCodes.id, latest.id), isNull(appVisitorCodes.usedAt))
      ),
    db
      .insert(appVisitorSessions)
      .select(
        sql`SELECT ${sessionId}, ${found.id}, ${address.data}, ${await sha256Hex(token)}, ${now}, ${expiresAt} WHERE changes() > 0`
      )
      .returning({ id: appVisitorSessions.id }),
    outboxedIfChanged(db, {
      actor: visitorActor(found.id, sessionId),
      action: "app.visitor_signed_in",
      target: appTarget(found.id),
      detail: { address: address.data },
    }),
  ]);
  if (inserted.length === 0) {
    return await codeRefused(env, found.id, address.data, "used");
  }
  return { token, expiresAt: new Date(expiresAt).toISOString() };
};

/** The session `token` names, unexpired, or undefined. */
const sessionOf = async (env: Env, token: string) =>
  await drizzle(env.DB)
    .select()
    .from(appVisitorSessions)
    .where(
      and(
        eq(appVisitorSessions.tokenHash, await sha256Hex(token)),
        gt(appVisitorSessions.expiresAt, new Date())
      )
    )
    .get();

/** What a visitor opens: the App, by name, and its first screen. */
export interface AppVisit {
  app: AppId;
  name: string;
  screen: ScreenBundle | null;
}

/**
 * The App a visitor's session opens, with its first screen, while the
 * session is unexpired, the App published and the address still listed.
 * `visitor.signed_out` otherwise.
 */
const openVisit = async (env: Env, token: string): Promise<AppVisit> => {
  const session = await sessionOf(env, token);
  if (session === undefined) {
    throw appVisitorErrors.create("visitor.signed_out");
  }
  const appId = appIdSchema.parse(session.appId);
  const found = await publishedApp(env, appId);
  let reason: string | undefined;
  if (found === undefined) {
    reason = "not_published";
  } else if (!(await isListed(env, appId, session.address))) {
    reason = "not_listed";
  }
  if (found === undefined || reason !== undefined) {
    await audited(
      env,
      appId,
      "app.visitor_refused",
      { reason: reason ?? null, address: session.address },
      session.id
    );
    throw appVisitorErrors.create("visitor.signed_out");
  }
  return {
    app: found.id,
    name: found.name,
    screen: await visitorScreen(env, found, `visitor:${session.id}`),
  };
};

/** Ends the session `token` names, if there is one. */
const signOut = async (env: Env, token: string): Promise<void> => {
  const db = drizzle(env.DB);
  const session = await sessionOf(env, token);
  if (session === undefined) {
    return;
  }
  const appId = appIdSchema.parse(session.appId);
  await auditedBatch(env, db, [
    db.delete(appVisitorSessions).where(eq(appVisitorSessions.id, session.id)),
    outboxedIfChanged(db, {
      actor: visitorActor(appId, session.id),
      action: "app.visitor_signed_out",
      target: appTarget(appId),
      detail: {},
    }),
  ]);
};

/** The HTTP status of each refusal a visitor meets. */
const statusFor: Record<string, number> = {
  "visitor.invalid": 400,
  "visitor.code_invalid": 401,
  "visitor.signed_out": 401,
  "visitor.too_many": 429,
  "visitor.unavailable": 503,
};

/**
 * A visitor's page's calls (`POST /api/app-visitor`): ask for a code,
 * sign in with it, open the App, and sign out. No cookie is read or set:
 * the session's token travels in the body, so no other page can use it.
 */
export const appVisitorResponse = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  if (request.method !== "POST") {
    return errorResponse(
      405,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  try {
    const length = Number(request.headers.get("content-length") ?? 0);
    const raw =
      length > requestMaxLength
        ? undefined
        : await boundedText(request.body, requestMaxLength);
    if (raw === undefined || raw === "") {
      throw appVisitorErrors.create("visitor.invalid");
    }
    const parsed = appVisitorRequestSchema.safeParse(jsonOf(raw));
    if (!parsed.success) {
      throw appVisitorErrors.create("visitor.invalid");
    }
    const body = parsed.data;
    switch (body.action) {
      case "ask": {
        await askForCode(env, body.link, body.address);
        return Response.json({ asked: true }, { status: 202 });
      }
      case "sign_in": {
        return Response.json(
          await signIn(env, body.link, body.address, body.code)
        );
      }
      case "open": {
        return Response.json(await openVisit(env, body.token));
      }
      case "sign_out": {
        await signOut(env, body.token);
        return Response.json({ signedOut: true });
      }
      default: {
        return body satisfies never;
      }
    }
  } catch (error) {
    if (!isExpectedError(error)) {
      throw error;
    }
    // A screen refused (unreviewed or revoked) is the App's to fix: 409.
    return errorResponse(statusFor[error.code] ?? 409, error, requestId);
  }
};

/**
 * Deletes codes sent more than an hour ago, which no longer count towards
 * the hour's limits, and sessions that expired: at most 500 of each a run.
 */
export const sweepAppVisitors = async (env: Env, now: Date): Promise<void> => {
  const db = drizzle(env.DB);
  const hourAgo = new Date(now.getTime() - hourMs);
  await db.batch([
    db
      .delete(appVisitorCodes)
      .where(
        sql`${appVisitorCodes.id} IN (SELECT ${appVisitorCodes.id} FROM ${appVisitorCodes} WHERE ${lt(appVisitorCodes.sentAt, hourAgo)} LIMIT ${sweptPerRun})`
      ),
    db
      .delete(appVisitorSessions)
      .where(
        sql`${appVisitorSessions.id} IN (SELECT ${appVisitorSessions.id} FROM ${appVisitorSessions} WHERE ${lt(appVisitorSessions.expiresAt, now)} LIMIT ${sweptPerRun})`
      ),
  ]);
};
