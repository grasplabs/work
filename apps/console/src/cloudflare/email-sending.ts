/**
 * A client account's sending domain for Email Sending: the zone that
 * holds it, in the client's own account, and Email Sending turned on for
 * it there, which writes the domain's sending records (its bounce MX,
 * SPF and DKIM on `cf-bounce`) into that zone. A Worker in the account
 * can then send from the domain through a `send_email` binding.
 *
 * Idempotent, as the other `ensure*` calls are: each finds what it needs
 * first and creates only what's missing, so a deploy run again, after a
 * failure part way or once the domain is set up, changes nothing.
 *
 * The API's shape here follows Cloudflare's reference for zones and for
 * Email Sending's sending subdomains (`/zones/{zone_id}/email/sending/
 * subdomains`), which says little beyond its fields: it hasn't been run
 * against a real account yet, so what it reads is checked loosely.
 */
import { z } from "zod";

import { listAll } from "./api.ts";
import type { CloudflareApi } from "./api.ts";

const zoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** `active` once the zone's name servers are delegated to Cloudflare. */
  status: z.string(),
});

const sendingDomainSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
});

/** The zone `name` in account `accountId`, created if it has none. */
const ensureZone = async (
  api: CloudflareApi,
  accountId: string,
  name: string
): Promise<z.infer<typeof zoneSchema>> => {
  // The API matches `name` exactly, and `account.id` keeps it to this
  // account; picked again here all the same.
  const zones = await listAll(api, "/zones", zoneSchema, {
    name,
    "account.id": accountId,
  });
  // A create is a POST, so it isn't retried after a lost answer; running
  // this again finds the zone it made by its name.
  return (
    zones.find((zone) => zone.name === name) ??
    (await api.call(
      {
        method: "POST",
        path: "/zones",
        json: { name, account: { id: accountId }, type: "full" },
      },
      zoneSchema
    ))
  );
};

/** The sending domain as a deploy ensured it. */
export interface SendingDomain {
  zoneId: string;
  /**
   * Whether the zone is active: until its name servers are delegated to
   * Cloudflare, mail from it fails as an unverified sender.
   */
  active: boolean;
}

/**
 * Ensures Email Sending sends from `domain` in account `accountId`: the
 * zone `domain` there, created if it's missing, with Email Sending turned
 * on for the domain itself. One already on is left as it is; one turned
 * off is turned on again (a create does that, by the API's reference).
 */
export const ensureSendingDomain = async (
  api: CloudflareApi,
  accountId: string,
  domain: string
): Promise<SendingDomain> => {
  const zone = await ensureZone(api, accountId, domain);
  const path = `/zones/${zone.id}/email/sending/subdomains`;
  // A zone has a handful of sending domains at most: one page.
  const sending = await api.call(
    { method: "GET", path },
    z.array(sendingDomainSchema)
  );
  const existing = sending.find(({ name }) => name === domain);
  if (existing?.enabled !== true) {
    await api.call(
      { method: "POST", path, json: { name: domain } },
      sendingDomainSchema
    );
  }
  return { zoneId: zone.id, active: zone.status === "active" };
};
