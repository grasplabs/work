import { z } from "zod";

import { appLinkSchema } from "./apps.ts";
import { defineErrorFamily } from "./errors.ts";

// Visitors (core's app-visitors.ts): someone who isn't a member opens a
// published App at its own link (`appLinkSchema`), once they sign in with
// a code core mails them. Only an address the App's builders listed, or
// one at a domain they listed, can ask for a code. A visitor's session
// opens that one App's screens and nothing else, and the screens call
// none of the App's functions: nothing runs as a member, or as anyone.
// How each part can be attacked, and what stops it, is in core's
// app-visitors.ts.

/** Where a visitor's page talks to core: one POST per action. */
export const appVisitorApiPath = "/api/app-visitor";

/** Where a visitor opens an App: the page, then the App's link. */
export const appVisitorPagePath = "/visit";

/** Most addresses and domains one App lists. */
export const appVisitorsMax = 50;

/** How many digits a code has. */
export const appVisitorCodeDigits = 8;

/** How long a code works, in minutes. */
export const appVisitorCodeMinutes = 10;

/** Most tries one code takes; the last wrong one ends it. */
export const appVisitorCodeTriesMax = 5;

/** Most codes one address is sent for one App in an hour. */
export const appVisitorCodesPerAddressPerHour = 5;

/** Most codes one App sends in an hour, to anyone. */
export const appVisitorCodesPerAppPerHour = 100;

/** How long a visitor's session works, in hours. */
export const appVisitorSessionHours = 8;

/**
 * A domain as builders list it and as an address ends: ASCII only, lower
 * case, at least two labels, none starting or ending with `-`. A name in
 * another script is listed by its `xn--` form, so a look-alike written
 * with other letters is another domain, never this one.
 */
export const appVisitorDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
    "a domain, such as example.com"
  );

/**
 * An address, compared as written but for case: no `+tag` is stripped and
 * no dot ignored, so `a+b@example.com` is another address than
 * `a@example.com`. ASCII only: its domain is `appVisitorDomainSchema`'s,
 * and its local part plain letters, digits and `.!#$%&'*+/=?^_`{|}~-`,
 * never quoted, so nothing in it reads as a second `@`.
 */
export const appVisitorAddressSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .refine((value) => {
    const at = value.lastIndexOf("@");
    if (at <= 0 || value.indexOf("@") !== at) {
      return false;
    }
    const local = value.slice(0, at);
    return (
      local.length <= 64 &&
      /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/u.test(
        local
      ) &&
      appVisitorDomainSchema.safeParse(value.slice(at + 1)).success
    );
  }, "an email address");

/** The domain of an address `appVisitorAddressSchema` took. */
export const appVisitorDomainOf = (address: string): string =>
  address.slice(address.lastIndexOf("@") + 1);

/** One entry of an App's list: an address, or every address at a domain. */
export const appVisitorEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("address"),
    value: appVisitorAddressSchema,
  }),
  z.strictObject({ kind: z.literal("domain"), value: appVisitorDomainSchema }),
]);
export type AppVisitorEntry = z.output<typeof appVisitorEntrySchema>;

/** An App's whole list, as its builders set it. */
export const appVisitorListSchema = z
  .array(appVisitorEntrySchema)
  .max(appVisitorsMax);

/** A code as a visitor types it: its digits, spaces allowed between. */
export const appVisitorCodeSchema = z
  .string()
  .transform((value) => value.replaceAll(/\s/gu, ""))
  .pipe(z.string().regex(new RegExp(`^\\d{${appVisitorCodeDigits}}$`, "u")));

/** A visitor's session: 32 random bytes, base64url. */
export const appVisitorTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u, "A visitor's session");

/** What a visitor's page sends. */
export const appVisitorRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("ask"),
    link: appLinkSchema,
    address: z.string().max(320),
  }),
  z.strictObject({
    action: z.literal("sign_in"),
    link: appLinkSchema,
    address: z.string().max(320),
    code: z.string().max(32),
  }),
  z.strictObject({ action: z.literal("open"), token: appVisitorTokenSchema }),
  z.strictObject({
    action: z.literal("sign_out"),
    token: appVisitorTokenSchema,
  }),
]);
export type AppVisitorRequest = z.input<typeof appVisitorRequestSchema>;

/** A signed-in visitor's session, as their page keeps it. */
export interface AppVisitorSession {
  token: string;
  /** ISO 8601. */
  expiresAt: string;
}

export const appVisitorErrors = defineErrorFamily({
  "visitor.invalid": "That isn't something this page takes.",
  "visitor.code_invalid":
    "That code doesn't work. Check it, or ask for a new one.",
  "visitor.signed_out": "You're signed out of this App. Sign in again.",
  "visitor.too_many":
    "Too many codes were asked for. Wait a while, then ask again.",
  "visitor.unavailable": "No code could be sent now. Try again later.",
});
