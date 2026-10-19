/**
 * What a person at Grasp did to an organization in this console, as the
 * prototype's admin kept it by hand (its trail, `TrailEntry`), read from
 * the console's own audit log. Of everything the console records, only
 * adding the client has an entry there (`made`): its deploys, rollouts and
 * settings are the setup's, not the onboarding's.
 */
import type { TrailEntry } from "@grasp-os/shared/admin/trail";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { consoleDatabase } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import { auditEvents } from "../db/schema.ts";

/** Client `clientId`'s trail: when it was added, as the audit log recorded it. */
export const organizationTrail = async (
  db: ConsoleDatabase,
  clientId: string
): Promise<TrailEntry[]> => {
  const added = await db
    .select({ at: auditEvents.at })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.clientId, clientId),
        eq(auditEvents.action, "client.create")
      )
    )
    .orderBy(asc(auditEvents.at))
    .limit(1);
  return added.map(({ at }) => ({ at: at.getTime(), what: "made" }));
};

/** Client `clientId`'s trail, for its log. */
export const fetchOrganizationTrail = createServerFn({ method: "GET" })
  .validator(z.object({ clientId: z.string().min(1) }))
  .handler(
    async ({ data }) =>
      await organizationTrail(consoleDatabase(env.DB), data.clientId)
  );
