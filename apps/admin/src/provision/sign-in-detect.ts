/**
 * How a company's people sign in, found from its email domain, so adding
 * an organization asks staff for no tenant id or Workspace domain:
 *
 * - its mail exchangers, by a DNS-over-HTTPS query (Cloudflare's resolver,
 *   JSON answers): Google Workspace's (`aspmx.l.google.com`,
 *   `smtp.google.com`, anything under `google.com` or `googlemail.com`)
 *   or Microsoft 365's (anything under `mail.protection.outlook.com`);
 * - for Microsoft 365, its Entra tenant id, from the domain's OpenID
 *   configuration at Microsoft's sign-in service, whose issuer names it.
 *
 * Google Workspace is pinned by the domain itself (`hd`): right for a
 * company's primary domain, and put right on Setup otherwise. Anything
 * that doesn't answer, or answers otherwise, finds nothing: staff choose
 * by hand then. Nothing here is a secret; only the domain leaves.
 */
import { z } from "zod";

/** What was found of a domain's sign-in. */
export type DetectedSignIn =
  | { provider: "google"; googleHostedDomain: string }
  | { provider: "microsoft"; entraTenantId: string }
  | { provider: null };

/** Cloudflare's DNS-over-HTTPS resolver, in its JSON form. */
const resolver = "https://cloudflare-dns.com/dns-query";

/** Microsoft's sign-in service, where a domain's tenant is found. */
const microsoftLogin = "https://login.microsoftonline.com";

/** How long each lookup may take. */
const lookupTimeoutMs = 3000;

/** An MX record's type number. */
const mxType = 15;

const dnsAnswerSchema = z.object({
  Status: z.number(),
  Answer: z.array(z.object({ type: z.number(), data: z.string() })).optional(),
});

const openIdSchema = z.object({ issuer: z.url() });

const tenantInIssuer =
  /^https:\/\/login\.microsoftonline\.com\/(?<tenant>[0-9a-f-]{36})\/v2\.0\/?$/u;

/** A domain a company's people could have addresses at: lowercase, at least one dot. */
export const emailDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u);

/** The exchanger hosts `domain`'s MX records name, lowercase and without the final dot. */
const mailExchangers = async (
  domain: string,
  fetcher: typeof fetch
): Promise<string[]> => {
  const url = new URL(resolver);
  url.searchParams.set("name", domain);
  url.searchParams.set("type", "MX");
  const response = await fetcher(url, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(lookupTimeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return [];
  }
  const parsed = dnsAnswerSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.Status !== 0) {
    return [];
  }
  return (parsed.data.Answer ?? [])
    .filter(({ type }) => type === mxType)
    .map(({ data }) => (data.split(/\s+/u).at(-1) ?? "").toLowerCase())
    .map((host) => host.replace(/\.$/u, ""))
    .filter((host) => host !== "");
};

const isGoogle = (host: string): boolean =>
  host === "smtp.google.com" ||
  host.endsWith(".google.com") ||
  host.endsWith(".googlemail.com");

const isMicrosoft = (host: string): boolean =>
  host.endsWith(".mail.protection.outlook.com");

/** `domain`'s Entra tenant id, from its OpenID configuration; undefined when it has none. */
const entraTenantOf = async (
  domain: string,
  fetcher: typeof fetch
): Promise<string | undefined> => {
  const response = await fetcher(
    `${microsoftLogin}/${encodeURIComponent(domain)}/v2.0/.well-known/openid-configuration`,
    { signal: AbortSignal.timeout(lookupTimeoutMs) }
  );
  if (!response.ok) {
    await response.body?.cancel();
    return undefined;
  }
  const parsed = openIdSchema.safeParse(await response.json());
  return parsed.success
    ? tenantInIssuer.exec(parsed.data.issuer)?.groups?.tenant
    : undefined;
};

/** How `domain`'s people sign in, as far as its DNS and Microsoft tell. */
export const detectSignIn = async (
  domain: string,
  fetcher: typeof fetch = fetch
): Promise<DetectedSignIn> => {
  const parsed = emailDomainSchema.safeParse(domain);
  if (!parsed.success) {
    return { provider: null };
  }
  try {
    const exchangers = await mailExchangers(parsed.data, fetcher);
    if (exchangers.some(isGoogle)) {
      return { provider: "google", googleHostedDomain: parsed.data };
    }
    if (exchangers.some(isMicrosoft)) {
      const entraTenantId = await entraTenantOf(parsed.data, fetcher);
      return entraTenantId === undefined
        ? { provider: null }
        : { provider: "microsoft", entraTenantId };
    }
    return { provider: null };
  } catch {
    // Unanswered or timed out: staff choose by hand.
    return { provider: null };
  }
};
