/**
 * Adding a client (spec 40.1): staff record it, with no account of its
 * own, then place it in a hosting destination and provision it there
 * from its Setup (src/hosting/placement.ts). Destination allocation is
 * automatic; a dedicated destination is an explicit choice staff make
 * there. No account is adopted or created for a client: a destination
 * holds the account, shared or dedicated.
 */
import { newClientIdSchema } from "@grasp-os/shared/router";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { actIfChanged, adminDatabase } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import { clients } from "../db/schema.ts";
import { clientDomain, signInApps } from "../deploy/context.ts";
import { clientSignInSchema, missingSignInApp } from "../deploy/core-config.ts";
import { hostingKinds, jurisdictions } from "../hosting/organization.ts";
import { clientIdProblem } from "./client-id.ts";
import { ProvisionError } from "./errors.ts";

/** What staff fill in to add a client. */
export const provisionInputSchema = z.object({
  clientId: newClientIdSchema,
  name: z.string().trim().min(1).max(100),
  /** The rollout ring it's in: Production's unless staff move it on Setup. */
  ring: z.int().nonnegative().default(1),
  /** How its people sign in: every deploy makes core's `SIGN_IN` from it. */
  signIn: clientSignInSchema,
  /**
   * Its company in Grasp's Attio, when it starts from a deal won there: the
   * record's id, linked as Details links one (src/crm/link.ts).
   */
  attioCompanyId: z.string().trim().toLowerCase().pipe(z.uuid()).optional(),
  /**
   * Where it runs (src/hosting/organization.ts): Grasp Cloud unless staff
   * choose its own premises, and for Grasp Cloud, its data in the EU
   * unless staff untick it. Both fixed once it is provisioned.
   */
  hosting: z.enum(hostingKinds).default("grasp_cloud"),
  jurisdiction: z.enum(jurisdictions).default("eu"),
});
export type ProvisionInput = z.input<typeof provisionInputSchema>;

/**
 * Why `clientId` can't be a new organization's web address, in words, or
 * null when it can: the server's own rule for an id (`clientIdProblem`),
 * and that no organization has it.
 */
export const clientIdAvailability = async (
  db: AdminDatabase,
  clientId: string
): Promise<{ problem: string | null }> => {
  const problem = clientIdProblem(clientId);
  if (problem !== null) {
    return { problem };
  }
  const taken = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();
  return {
    problem:
      taken === undefined ? null : `${clientId} is taken: choose another.`,
  };
};

/**
 * Records the client `input` describes, as `staff`, being provisioned and
 * with no account of its own, and returns its id. Refused while the admin
 * has no client domain, for a sign-in naming an IdP the admin has no app
 * for, and for an id a client has already (`client_exists`), also one
 * recorded at the same moment.
 */
export const createClient = async (
  env: Env,
  staff: Staff,
  input: ProvisionInput
): Promise<string> => {
  const db = adminDatabase(env.DB);
  const parsed = provisionInputSchema.parse(input);
  const { clientId } = parsed;
  if (clientDomain(env) === null) {
    throw new ProvisionError(
      "domain_not_set",
      "Set CLIENT_DOMAIN on the admin before adding a client"
    );
  }
  const missing = missingSignInApp(parsed.signIn, signInApps(env));
  if (missing !== null) {
    throw new ProvisionError(
      "sign_in_app_missing",
      `The admin has no ${missing} app id for ${clientId}'s sign-in`
    );
  }
  const now = new Date();
  const created = await actIfChanged(
    db,
    staff,
    db
      .insert(clients)
      .values({
        id: clientId,
        name: parsed.name,
        ring: parsed.ring,
        signIn: JSON.stringify(parsed.signIn),
        hosting: parsed.hosting,
        jurisdiction: parsed.jurisdiction,
        attioCompanyId: parsed.attioCompanyId ?? null,
        createdBy: staff.email,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing(),
    {
      action: "client.create",
      clientId,
      detail: {
        ring: parsed.ring,
        hosting: parsed.hosting,
        jurisdiction: parsed.jurisdiction,
        ...(parsed.attioCompanyId === undefined
          ? {}
          : { attioCompany: parsed.attioCompanyId }),
      },
    }
  );
  if (!created) {
    throw new ProvisionError("client_exists", `Client ${clientId} exists`);
  }
  return clientId;
};
