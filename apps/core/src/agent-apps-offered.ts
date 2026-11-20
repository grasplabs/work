import { agentAppOf } from "@grasp-os/shared/agents";
import { drizzle } from "drizzle-orm/d1";

import { hiddenConnectors } from "./db/core/schema.ts";

// The apps an agent may be given: the company's catalog, less what its
// admins hid. Read alone, never the Brain, so both an agent's apps
// (agent-app-access.ts) and a card from the chat (chats-rpc.ts) check
// against it.

/** An app the company offers: in its catalog, and not hidden by an admin. */
export interface OfferedApp {
  app: string;
  name: string;
  description: string | null;
}

/** The apps the company offers now, by key. */
export const offeredApps = async (
  env: Env
): Promise<Map<string, OfferedApp>> => {
  const [catalog, hidden] = await Promise.all([
    env.CONNECT.catalog(),
    drizzle(env.DB)
      .select({
        source: hiddenConnectors.source,
        id: hiddenConnectors.connectorId,
      })
      .from(hiddenConnectors),
  ]);
  const off = new Set(hidden.map(({ source, id }) => agentAppOf(source, id)));
  return new Map(
    catalog.entries.flatMap(({ source, id, name, description }) => {
      const app = agentAppOf(source, id);
      return off.has(app) ? [] : [[app, { app, name, description }] as const];
    })
  );
};
