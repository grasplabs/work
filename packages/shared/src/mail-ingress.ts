import { hkdfHmacKey } from "./client-secrets.ts";
import { fromHex, toHex } from "./encoding.ts";

// Raw mail into a client's core over HTTP: what the router's mail sorter
// sends for each message Email Routing hands it (one catch-all for every
// client's domain), and what an on-prem mail bridge sends instead. Core
// takes it as its `email` handler takes a message from Email Routing.
//
// Behind the router-secret check like every route, and signed besides: the
// router adds its secret to every public request it forwards, so the
// secret alone would let anyone who can reach a client's hostname post
// mail. The signature's key is derived from the router secret, and only
// the sorter signs; the router drops any signature header a public
// request carries. It covers the recipient, the envelope sender, the
// message's SHA-256 and size and when it was sent, so none of them can be
// swapped and an old delivery can't be sent again later.

/** Core's raw-mail ingress. */
export const mailIngressPath = "/platform/mail";

/** The envelope recipient, as Email Routing gave it. */
export const mailToHeader = "x-grasp-mail-to";
/** The envelope sender, as Email Routing gave it. */
export const mailFromHeader = "x-grasp-mail-from";
/** The raw message's SHA-256, lowercase hex. */
export const mailSha256Header = "x-grasp-mail-sha256";
/** The raw message's size in bytes, as the body must have it. */
export const mailSizeHeader = "x-grasp-mail-size";
/** When the sender signed it, ISO 8601. */
export const mailSentAtHeader = "x-grasp-mail-sent-at";
/** The signature: lowercase hex HMAC-SHA256 of `mailSigned`. */
export const mailSignatureHeader = "x-grasp-mail-signature";

/** Every header the ingress reads, which the router never forwards from the public. */
export const mailIngressHeaders: readonly string[] = [
  mailToHeader,
  mailFromHeader,
  mailSha256Header,
  mailSizeHeader,
  mailSentAtHeader,
  mailSignatureHeader,
];

/** The purpose the signing key is derived for (`hkdfHmacKey`). */
export const mailIngressPurpose = "grasp-os mail ingress key";

/**
 * The most bytes a message may have on its way in: Email Routing's own
 * limit. Core bounces what's over its own, lower one.
 */
export const mailIngressMaxBytes = 25 * 1024 * 1024;

/** How old, or how far ahead of core's clock, a signed delivery may be. */
export const mailIngressMaxSkewMs = 5 * 60 * 1000;

/**
 * Why core refused a message for good, as it answers the sender (422): the
 * reason Email Routing bounces it with.
 */
export const mailRejectedStatus = 422;

/** What a delivery's signature covers. */
export interface SignedMail {
  to: string;
  from: string;
  sha256: string;
  size: number;
  sentAt: string;
}

const signed = (mail: SignedMail): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(
    [
      "grasp-mail-v1",
      mail.to,
      mail.from,
      mail.sha256,
      String(mail.size),
      mail.sentAt,
    ].join("\n")
  );

/** The signature for `mail` with the key derived from `routerSecret`. */
export const signMail = async (
  routerSecret: string,
  mail: SignedMail
): Promise<string> => {
  const key = await hkdfHmacKey(routerSecret, mailIngressPurpose, ["sign"]);
  return toHex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, signed(mail)))
  );
};

/** Whether `signature` signs `mail` with the key derived from `routerSecret`, in constant time. */
export const verifyMail = async (
  routerSecret: string,
  mail: SignedMail,
  signature: string
): Promise<boolean> => {
  const bytes = fromHex(signature);
  if (bytes === undefined) {
    return false;
  }
  const key = await hkdfHmacKey(routerSecret, mailIngressPurpose, ["verify"]);
  return await crypto.subtle.verify("HMAC", key, bytes, signed(mail));
};
