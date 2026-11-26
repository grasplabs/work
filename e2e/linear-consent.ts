/**
 * How the e2e stack's Linear (e2e/connect-entry.ts) takes a person's
 * approval: the browser can't reach the fake, which lives in connect's
 * isolate, so the test answers Linear's `/authorize` page itself with a
 * code that carries the whole authorization request connect built. When
 * connect redeems it, the fake approves that request (its `consent`, which
 * checks the client, the redirect and the PKCE challenge as Linear would)
 * and the code it issues is the one redeemed. Imported by the test (Node)
 * and by connect's entry (workerd).
 */

/** What starts such a code. */
const prefix = "e2e-consent.";

/** The code the person's approval of `authorizationUrl` comes back with. */
export const consentCodeOf = (authorizationUrl: string): string =>
  `${prefix}${btoa(authorizationUrl).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;

/** The authorization URL a code from `consentCodeOf` carries, if it is one. */
export const consentedUrlOf = (code: string): string | undefined => {
  if (!code.startsWith(prefix)) {
    return undefined;
  }
  const base64 = code
    .slice(prefix.length)
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
};
