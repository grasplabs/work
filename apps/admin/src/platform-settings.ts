/**
 * The platform settings staff choose on Platform, kept in the admin's
 * database: which organization is Grasp's own, whose core answers Ask
 * Grasp (src/admin/ask.ts). Each change is audited as the staff member
 * Access vouches for (`platform.grasp_client`), behind the Access check
 * every request passes (src/access.ts).
 *
 * Where the rest lives: Grasp's own public settings (Rooms' origin, the
 * Discord bot's public key and staff) in wrangler.jsonc per stage; secrets
 * in the stage's 1Password Environment, which CI copies to Secrets Store;
 * each client's settings with the client.
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { asc, eq, ne } from "drizzle-orm";
import { z } from "zod";

import type { Staff } from "./access.ts";
import { act, adminDatabase } from "./db/act.ts";
import type { AdminDatabase } from "./db/act.ts";
import { clients, platformSettings } from "./db/schema.ts";

/** The one row's id. */
const settingsId = 1;

/** Grasp's own organization's client id; null until staff choose one. */
export const graspClientIdOf = async (
  db: AdminDatabase
): Promise<string | null> => {
  const row = await db
    .select({ graspClientId: platformSettings.graspClientId })
    .from(platformSettings)
    .where(eq(platformSettings.id, settingsId))
    .get();
  return row?.graspClientId ?? null;
};

/** An organization staff may choose as Grasp's own: any not offboarded. */
export interface GraspCandidate {
  id: string;
  name: string;
  status: "provisioning" | "active" | "offboarded";
}

/** What Platform shows of the settings: the choice, and what may be chosen. */
export interface PlatformSettingsView {
  graspClientId: string | null;
  /** The chosen one's name; null when none is chosen, or the admin no longer has it. */
  graspClientName: string | null;
  candidates: GraspCandidate[];
}

export const platformSettingsView = async (
  db: AdminDatabase
): Promise<PlatformSettingsView> => {
  const [graspClientId, rows] = await Promise.all([
    graspClientIdOf(db),
    db
      .select({ id: clients.id, name: clients.name, status: clients.status })
      .from(clients)
      .where(ne(clients.status, "offboarded"))
      .orderBy(asc(clients.name)),
  ]);
  const chosen = rows.find(({ id }) => id === graspClientId);
  return {
    graspClientId,
    graspClientName: chosen?.name ?? null,
    candidates: rows,
  };
};

/** Why choosing Grasp's own organization was refused. */
export type GraspClientRefusal = "client_unknown";

/**
 * Chooses client `clientId` as Grasp's own organization, or none (null),
 * as `staff`, audited. Refused (`client_unknown`) for one the admin
 * doesn't have, or that's offboarded.
 */
export const setGraspClient = async (
  db: AdminDatabase,
  staff: Staff,
  clientId: string | null
): Promise<GraspClientRefusal | null> => {
  if (clientId !== null) {
    const client = await db
      .select({ status: clients.status })
      .from(clients)
      .where(eq(clients.id, clientId))
      .get();
    if (client === undefined || client.status === "offboarded") {
      return "client_unknown";
    }
  }
  const now = new Date();
  await act(
    db,
    staff,
    [
      db
        .insert(platformSettings)
        .values({
          id: settingsId,
          graspClientId: clientId,
          updatedBy: staff.email,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: platformSettings.id,
          set: {
            graspClientId: clientId,
            updatedBy: staff.email,
            updatedAt: now,
          },
        }),
    ],
    {
      action: "platform.grasp_client",
      ...(clientId === null ? {} : { clientId }),
    }
  );
  return null;
};

/** Platform's settings, and the organizations Grasp's own may be. */
export const fetchPlatformSettings = createServerFn({ method: "GET" }).handler(
  async () => await platformSettingsView(adminDatabase(env.DB))
);

/** Choosing Grasp's own organization, or none. */
export const setGraspClientFn = createServerFn({ method: "POST" })
  .validator(z.object({ clientId: z.string().min(1).nullable() }))
  .handler(
    async ({
      data,
      context,
    }): Promise<{ refused: GraspClientRefusal | null }> => ({
      refused: await setGraspClient(
        adminDatabase(env.DB),
        context.staff,
        data.clientId
      ),
    })
  );
