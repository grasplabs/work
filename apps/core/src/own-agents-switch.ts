import { log } from "@grasp-os/shared/log";
import {
  ownAgentsDefault,
  ownAgentsSettingsSchema,
} from "@grasp-os/shared/org-settings";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { orgSettings } from "./db/core/schema.ts";

// Whether people may have agents of their own (agents.ts), as the
// company's admins set it on the Agents page and org-settings.ts keeps
// it: a row of `org_settings` under `own_agents`. On until an admin turns
// it off. Read here, apart from org-settings.ts, so the agents' own
// modules read it without reaching the settings' RPC.

/** The `org_settings` kind the switch is kept under. */
export const ownAgentsKind = "own_agents";

/** Whether people may have agents of their own now; on when unset or unreadable. */
export const ownAgentsOn = async (env: Pick<Env, "DB">): Promise<boolean> => {
  const row = await drizzle(env.DB)
    .select({ value: orgSettings.value })
    .from(orgSettings)
    .where(eq(orgSettings.kind, ownAgentsKind))
    .get();
  if (row === undefined) {
    return ownAgentsDefault.on;
  }
  const parsed = ownAgentsSettingsSchema.safeParse(JSON.parse(row.value));
  if (!parsed.success) {
    log.warn("org_settings.unreadable", { kind: ownAgentsKind });
    return ownAgentsDefault.on;
  }
  return parsed.data.on;
};

/**
 * The same, as a SQL condition a write holds as it lands: true unless an
 * admin turned agents of people's own off.
 */
export const ownAgentsOnSql = sql`NOT EXISTS (
  SELECT 1 FROM ${orgSettings}
  WHERE ${orgSettings.kind} = ${ownAgentsKind}
    AND json_extract(${orgSettings.value}, '$.on') = 0
)`;
