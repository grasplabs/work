/**
 * Where an organization's Grasp runs, as staff choose it when they
 * create it: in Grasp Cloud, its data kept in the EU or anywhere in
 * Cloudflare's network, or on its own premises. Both are fixed once it
 * is provisioned: every database, bucket and Durable Object is created in
 * its jurisdiction and can't move, and an on-prem install is its own.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { AdminDatabase } from "../db/act.ts";
import { clients } from "../db/schema.ts";

/** How an organization is hosted: in Grasp's cloud, or on its own premises. */
export const hostingKinds = ["grasp_cloud", "on_prem"] as const;

export type HostingKind = (typeof hostingKinds)[number];

/** Where Grasp Cloud keeps an organization's data: in the EU, or in no jurisdiction. */
export const jurisdictions = ["eu", "none"] as const;

export type Jurisdiction = (typeof jurisdictions)[number];

export const organizationHostingSchema = z.object({
  hosting: z.enum(hostingKinds),
  jurisdiction: z.enum(jurisdictions),
});

export type OrganizationHosting = z.infer<typeof organizationHostingSchema>;

/**
 * The jurisdiction a client's databases and buckets are created in, as
 * Cloudflare names it: R2's `default` for none (a D1 database is then
 * created with none named).
 */
export type ResourceJurisdiction = "eu" | "default";

export const resourceJurisdictionOf = (
  jurisdiction: Jurisdiction
): ResourceJurisdiction => (jurisdiction === "eu" ? "eu" : "default");

/** Client `clientId`'s hosting and jurisdiction. Throws for a client the admin has no record of. */
export const clientHostingOf = async (
  db: AdminDatabase,
  clientId: string
): Promise<OrganizationHosting> => {
  const row = await db
    .select({ hosting: clients.hosting, jurisdiction: clients.jurisdiction })
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();
  if (row === undefined) {
    throw new Error(`No client ${clientId}`);
  }
  return row;
};

/** Where an organization runs, in a few plain words. */
export const hostingWords = ({
  hosting,
  jurisdiction,
}: OrganizationHosting): string => {
  if (hosting === "on_prem") {
    return "On-premises: on the organization's own servers";
  }
  return jurisdiction === "eu"
    ? "Grasp Cloud, data kept in the EU"
    : "Grasp Cloud, data stored anywhere in Cloudflare's network";
};
