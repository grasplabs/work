import { connectErrors } from "@grasp-os/shared/connect";
import type { Authority } from "@grasp-os/shared/permissions";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { organizationId } from "./auth/membership-sql.ts";
import { agentApps } from "./db/core/schema.ts";

// The gate of an agent's apps (agent-app-access.ts), apart from the rest
// of them, so the class gate (tool-classes.ts) reads it without reaching
// the models or the agents' records.

/**
 * Refuses a call of the agent `authority` acts as to the app `app`
 * (`<source>:<id>`) when the agent lists apps and this isn't one of them,
 * on: `connect.agent_app_off`. The company's first agent, and an agent
 * listing none, use any app, as before agents had apps.
 */
export const requireAgentHasApp = async (
  env: Pick<Env, "DB">,
  authority: Authority,
  app: string
): Promise<void> => {
  if (
    authority.subject.type !== "agent" ||
    authority.subject.agentId === organizationId
  ) {
    return;
  }
  const rows = await drizzle(env.DB)
    .select({ app: agentApps.app, state: agentApps.state })
    .from(agentApps)
    .where(eq(agentApps.agentId, authority.subject.agentId));
  if (rows.length === 0) {
    return;
  }
  if (!rows.some((row) => row.app === app && row.state === "on")) {
    throw connectErrors.create("connect.agent_app_off");
  }
};
