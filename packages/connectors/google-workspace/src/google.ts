import type { VendorErrors } from "@grasp-os/sdk/connector";

// Google's APIs, as this connector's tools reach them: gmail.googleapis.com
// (Gmail), www.googleapis.com (Calendar, Drive) and sheets.googleapis.com
// (Sheets), through connect's egress, which adds the token and lets through
// only the called tool's routes (threat model R9, Q11).
//
// Addressing. Gmail and Calendar name their resource in the path, by
// address: `/gmail/v1/users/{userId}/...`, `/calendar/v3/calendars/
// {calendarId}/...`, never Google's aliases `me` and `primary`, so the
// egress binds every request to the mailbox or calendar a call's
// capability names. Drive has no path of its own per drive: it takes a
// shared drive in the query (`corpora=drive&driveId=...`) and addresses a
// file by its ID alone, so drive.ts holds each call to its drive itself.
// Sheets, the same: a spreadsheet is a Drive file, addressed by its ID
// alone, so sheets.ts reads its Drive metadata first and goes no further
// unless it is in the bound drive.
//
// Batch endpoints are never declared, and the egress strips method
// override headers, which Google honours on a POST. None of the endpoints
// used echoes request headers into its answer (the token would reach this
// code if one did).

export const gmailHost = "gmail.googleapis.com";
export const apisHost = "www.googleapis.com";
export const sheetsHost = "sheets.googleapis.com";

/** A Google OAuth scope, by its name: `drive.readonly`. */
export const googleScope = (name: string): string =>
  `https://www.googleapis.com/auth/${name}`;

/** Where a list goes on: Google's page token, or null on its last page. */
export const nextOf = (token: string | undefined): string | null =>
  token === undefined || token === "" ? null : token;

/**
 * The reasons Google gives a 403 that is a rate limit (Calendar and Drive
 * answer 403 as often as 429): the request was refused before anything
 * was done.
 */
const rateLimitReasons: ReadonlySet<string> = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);

/** A property of an object, if `value` is one. */
const propertyOf = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, name)
    : undefined;

/**
 * How Google's error answers read: `{ error: { status, errors: [{ reason }] } }`.
 * Its reason (`notFound`, `rateLimitExceeded`), or else its status
 * (`NOT_FOUND`), is passed on, never its message. 409 (a duplicate), 412
 * (a precondition) and 413 refuse a request as not valid, besides 400.
 */
export const googleErrors = {
  code: (body) => {
    const error = propertyOf(body, "error");
    const errors = propertyOf(error, "errors");
    const reason = Array.isArray(errors)
      ? propertyOf(errors[0], "reason")
      : undefined;
    const status = propertyOf(error, "status");
    if (typeof reason === "string") {
      return reason;
    }
    return typeof status === "string" ? status : undefined;
  },
  isThrottled: (status, code) =>
    status === 403 && code !== undefined && rateLimitReasons.has(code),
  invalid: [400, 409, 412, 413],
} satisfies VendorErrors;
