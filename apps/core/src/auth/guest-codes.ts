import { actorOf } from "@grasp-os/shared/audit";
import { errorFields, log } from "@grasp-os/shared/log";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { keepAuditEvent } from "../audit-outbox.ts";
import { users, verifications } from "../db/core/schema.ts";
import { uuidSql } from "../db/d1.ts";
import { sendMail } from "../mail.ts";
import { boundedText, jsonOf } from "../request-body.ts";
import { guestNow } from "./membership-sql.ts";

// A guest (roles.ts `guestRole`) signs in with a code mailed to them,
// through Better Auth's email one-time-code plugin (auth.ts). Members
// sign in through their company's IdP alone. The threat model is on the
// issue (GRA-2235); what stops each way in, tested in
// test/guest-sign-in.test.ts:
//
// - Finding out who is invited: core answers a request for a code itself
//   (`guestCodeAsked`), the same once the body parses, before anything is
//   looked up; the rest runs after the answer. An address that is no
//   guest now has nothing stored and nothing sent. Signing in answers
//   every refusal alike (routes.ts), a wrong, used-up or run-out code as
//   an address that is no guest's.
// - Mail bombing, or guessing by asking again and again: at most
//   `guestCodesPerHour` codes go to one address in an hour, counted and
//   recorded in one statement in Better Auth's own `verifications` table,
//   so the count holds across isolates and on plain workerd. Better
//   Auth's own limiter is off (auth.ts): it counts per isolate and per
//   client address, never per address mailed. The router limits every
//   sign-in route per client address besides.
// - Guessing a code: `guestCodeDigits` digits, kept hashed, for
//   `guestCodeLifetimeS`, `guestCodeTries` tries; a new code voids the
//   one before (Better Auth consumes the newest of an address's and drops
//   the rest).
// - A code signing in someone else: sign-in is refused before the plugin
//   reads anything unless the address is a guest's now (auth.ts, its
//   `before` hook), and the session is made only for a guest now
//   (`startSession`). The plugin never makes a user (`disableSignUp`,
//   and `validateUserInfo` refuses any user not made by SSO).

/** Better Auth's path where a code is asked for, which core answers itself. */
export const guestCodePath = "/email-otp/send-verification-otp";

/** Better Auth's path where a code signs a guest in. */
export const guestSignInPath = "/sign-in/email-otp";

/** Digits in a code: 10^8 to guess from. */
export const guestCodeDigits = 8;
/** How long a code works, in seconds. */
export const guestCodeLifetimeS = 5 * 60;
/** Tries a code takes before it is used up. */
export const guestCodeTries = 3;
/** Codes one address is sent in an hour, at most. */
export const guestCodesPerHour = 5;

const hourMs = 60 * 60 * 1000;

/** The most bytes a request for a code may carry: an address, and its type. */
const askMaxBytes = 1024;

/** What asking for a code sends, as Better Auth's client sends it. */
const askSchema = z.looseObject({
  email: z.string().max(320),
  type: z.literal("sign-in").optional(),
});

/** An address as Better Auth signs it in: lower case, as an email. */
const addressSchema = z.email().max(254);

/** The address `email` is, as Better Auth reads it; undefined when it is none. */
const addressOf = (email: string): string | undefined => {
  const parsed = addressSchema.safeParse(email.toLowerCase());
  return parsed.success ? parsed.data : undefined;
};

/**
 * That `email` (as Better Auth reads it) is a guest's now, as SQL: exactly
 * the user Better Auth signs in under it (`findUserByEmail`).
 */
const isGuestAddress = (email: string) => sql`EXISTS (
  SELECT 1 FROM ${users} WHERE ${users.email} = ${email} AND ${guestNow(users.id)}
)`;

/** Whether `email` is a guest's address now: whom a code may sign in. */
export const guestAddress = async (
  env: Env,
  email: unknown
): Promise<boolean> => {
  const address = typeof email === "string" ? addressOf(email) : undefined;
  if (address === undefined) {
    return false;
  }
  const row = await drizzle(env.DB).get<{ guest: number }>(
    sql`SELECT ${isGuestAddress(address)} AS guest`
  );
  return row.guest === 1;
};

/**
 * Where a guest's sends are counted, in `verifications`, by their user ID
 * (`userId`, an ID or a column holding one): never by their address, which
 * an erasure must leave nowhere.
 */
const sendsOf = (userId: SQL | SQLiteColumn): SQL =>
  sql`'guest-code-sent-' || ${userId}`;

/**
 * The plugin's own row of the code outstanding for `address` (SQL holding
 * a lower-case address), in `verifications`: the plugin keys it
 * `sign-in-otp-<address>` (its `toOTPIdentifier`). A guest's removal and
 * erasure delete it (members.ts, person-erasure.ts), so no row names the
 * address afterwards.
 */
export const signInCodeOf = (address: SQL): SQL =>
  sql`${verifications.identifier} = 'sign-in-otp-' || ${address}`;

/** A code's mail, in plain words. */
const codeMail = (to: string, code: string) => {
  const spaced = `${code.slice(0, 4)} ${code.slice(4)}`;
  const minutes = guestCodeLifetimeS / 60;
  const text = `Your code to sign in to Grasp is ${spaced}.\n\nIt works for ${minutes} minutes. If you didn't ask for it, ignore this mail: nobody can sign in without it.`;
  const html = `<p>Your code to sign in to Grasp is <strong>${spaced}</strong>.</p><p>It works for ${minutes} minutes. If you didn't ask for it, ignore this mail: nobody can sign in without it.</p>`;
  return { to, subject: "Your sign-in code for Grasp", text, html };
};

/**
 * Mails `code` to `email`, as the plugin hands it over: only a sign-in
 * code, and only to a guest now (checked again here). Throws when it
 * isn't sent, so the plugin's call fails and nothing reads as sent.
 */
export const mailGuestCode = async (
  env: Env,
  { email, otp, type }: { email: string; otp: string; type: string }
): Promise<void> => {
  if (type !== "sign-in" || !(await guestAddress(env, email))) {
    throw new Error("Not a guest's sign-in code");
  }
  const sent = await sendMail(env, codeMail(email, otp));
  if (sent.outcome !== "sent") {
    throw new Error(`The code wasn't sent: ${sent.reason}`);
  }
};

/** What sends the code: Better Auth's own call, server side (auth.ts). */
export type SendCode = (email: string) => Promise<unknown>;

/**
 * Sends a code to `address` if it is a guest's now and under the hour's
 * limit, and audits it as the guest once it went. Runs after the answer
 * (`guestCodeAsked`).
 */
const sendGuestCode = async (
  env: Env,
  address: string,
  sendCode: SendCode
): Promise<void> => {
  const now = Date.now();
  const db = drizzle(env.DB);
  // Counted and recorded in one statement, only for a guest now and under
  // the limit, so asks at the same time can't go past it. Better Auth
  // deletes these rows once they expire, as all of its own.
  const counted = await db
    .insert(verifications)
    .select(
      sql`SELECT ${uuidSql}, ${sendsOf(users.id)}, ${users.id}, ${now + hourMs}, ${now}, ${now}
        FROM ${users}
        WHERE ${users.email} = ${address} AND ${guestNow(users.id)}
          AND (SELECT count(*) FROM ${verifications}
            WHERE ${verifications.identifier} = ${sendsOf(users.id)}
              AND ${verifications.expiresAt} > ${now}) < ${guestCodesPerHour}`
    )
    .returning({ userId: verifications.value });
  const guest = counted[0]?.userId;
  if (guest === undefined) {
    return;
  }
  try {
    await sendCode(address);
  } catch (error) {
    // Never the address or the code.
    log.error("guest.code_not_sent", errorFields(error));
    return;
  }
  await keepAuditEvent(env, db, {
    actor: actorOf({ userId: guest, staff: false }),
    action: "member.guest_code_sent",
    target: { type: "user", id: guest },
  });
};

/**
 * Answers a request for a code (`guestCodePath`): the same for every
 * address once the body parses, before anything is looked up, so neither
 * the answer nor how long it takes says who is a guest. The code goes
 * after (`ctx.waitUntil`).
 */
export const guestCodeAsked = async (
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  sendCode: SendCode
): Promise<Response> => {
  const text = await boundedText(request.body, askMaxBytes);
  const asked = askSchema.safeParse(
    text === undefined ? undefined : jsonOf(text)
  );
  if (!asked.success) {
    return Response.json(
      { code: "INVALID_REQUEST", message: "Send an email address." },
      { status: 400 }
    );
  }
  const address = addressOf(asked.data.email);
  if (address !== undefined) {
    ctx.waitUntil(sendGuestCode(env, address, sendCode));
  }
  return Response.json({ success: true });
};

/** Whether `userId` is a guest now (`guestNow`). */
export const isGuestNow = async (
  env: Env,
  userId: string
): Promise<boolean> => {
  const row = await drizzle(env.DB).get<{ guest: number }>(
    sql`SELECT ${guestNow(userId)} AS guest`
  );
  return row.guest === 1;
};
