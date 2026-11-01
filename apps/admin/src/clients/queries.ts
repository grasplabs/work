/** Reading a client's settings and history, as its page shows them. */
import { desc, eq, sql } from "drizzle-orm";

import type { AdminDatabase } from "../db/act.ts";
import { auditEvents, clients } from "../db/schema.ts";
import { clientSignInSchema } from "../deploy/core-config.ts";
import type { ClientSignInRecord } from "../deploy/core-config.ts";
import { isConfigPending } from "../rollout/targets.ts";
import { teamsBotOf } from "./teams-bot.ts";
import type { TeamsBot } from "./teams-bot.ts";

/** A client's settings, as its page shows them. */
export interface ClientSettingsView {
  ring: number;
  /** Whether it's live: only then can its settings be applied now. */
  active: boolean;
  /** The release rollouts leave it on, if it's pinned. */
  pinnedReleaseId: string | null;
  /** Its record's sign-in; null when it has none, or one that doesn't parse. */
  signIn: ClientSignInRecord | null;
  /** Its own Teams bot (src/clients/teams-bot.ts); null when it has none. */
  teamsBot: TeamsBot | null;
  /** Whether a change to its sign-in or bot waits for its next deploy. */
  configPending: boolean;
}

/** JSON `text`, parsed; undefined when it isn't JSON. */
const parsedJson = (text: string | null | undefined): unknown => {
  try {
    return JSON.parse(text ?? "null");
  } catch {
    return undefined;
  }
};

/** Client `clientId`'s settings, or null when there's no such client. */
export const clientSettings = async (
  db: AdminDatabase,
  clientId: string
): Promise<ClientSettingsView | null> => {
  const [client] = await db
    .select({
      ring: clients.ring,
      status: clients.status,
      pinnedReleaseId: clients.pinnedReleaseId,
      signIn: clients.signIn,
      teamsBot: clients.teamsBot,
      configChangedAt: clients.configChangedAt,
    })
    .from(clients)
    .where(eq(clients.id, clientId));
  if (client === undefined) {
    return null;
  }
  const signIn = clientSignInSchema.safeParse(parsedJson(client.signIn));
  return {
    ring: client.ring,
    active: client.status === "active",
    pinnedReleaseId: client.pinnedReleaseId,
    signIn: signIn.success ? signIn.data : null,
    teamsBot: teamsBotOf(client.teamsBot),
    configPending: await isConfigPending(db, clientId, client.configChangedAt),
  };
};

/** How many of a client's latest admin actions its page shows. */
export const historyLimit = 50;

/** One admin action on a client, as its history shows it. */
export interface HistoryEntry {
  id: string;
  at: Date;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
}

/**
 * Client `clientId`'s latest admin actions, newest first: staff's
 * changes, and its provisioning, deploys and rollouts, as the audit log
 * recorded them.
 */
export const clientHistory = async (
  db: AdminDatabase,
  clientId: string
): Promise<HistoryEntry[]> =>
  await db
    .select({
      id: auditEvents.id,
      at: auditEvents.at,
      actor: auditEvents.actor,
      action: auditEvents.action,
      target: auditEvents.target,
      detail: auditEvents.detail,
    })
    .from(auditEvents)
    .where(eq(auditEvents.clientId, clientId))
    // Events of one millisecond in the order they were written.
    .orderBy(desc(auditEvents.at), desc(sql`rowid`))
    .limit(historyLimit);
