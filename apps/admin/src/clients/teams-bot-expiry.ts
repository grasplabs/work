/**
 * Warning staff before a client's Teams bot secret expires. A secret
 * minted in a client's Entra lasts at most 24 months; once it has
 * expired, Microsoft refuses every send, and Stephen goes silent in Teams.
 * The day it expires is part of the client's bot (src/clients/teams-bot.ts).
 *
 * Every day the expiry cron looks at each active client's bot, and when
 * the secret is within 60, 30 or 7 days of expiring, or expires today or
 * has, tells staff (src/alerts.ts) with the client, the days left and a
 * link to its page. Each stage is told once for each expiry day (the
 * alert's subject), so:
 *
 * - a day the cron didn't run is caught up the next: 59 days left still
 *   tells the 60-day stage, once;
 * - a run twice in one day tells nothing twice;
 * - a new secret, set with its new expiry day, starts over.
 *
 * Days are counted in UTC, from today to the expiry day as Entra shows it.
 */
import { and, eq, isNotNull } from "drizzle-orm";

import { sendStaffAlert } from "../alerts.ts";
import type { AlertOutcome } from "../alerts.ts";
import { adminDatabase } from "../db/act.ts";
import { clients } from "../db/schema.ts";
import { teamsBotOf } from "./teams-bot.ts";

/** The expiry check's cron (wrangler.jsonc): every day at 07:15 UTC. */
export const expiryCron = "15 7 * * *";

/** How many days before the secret expires staff are told, largest first; 0 is the day itself. */
const stages = [60, 30, 7, 0] as const;

const dayMs = 24 * 60 * 60 * 1000;

/** Whole days from `now`'s UTC day to `day` (`YYYY-MM-DD`): negative once it's past. */
export const daysUntil = (day: string, now: Date): number => {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  return Math.round((Date.parse(`${day}T00:00:00Z`) - today) / dayMs);
};

/**
 * The stage a secret `days` from expiring is in: the smallest that's at
 * least `days`, or the day itself once it's past; null when it's further
 * off than the first.
 */
export const stageOf = (days: number): number | null => {
  if (days <= 0) {
    return 0;
  }
  const within = stages.filter((stage) => stage >= days);
  return within.at(-1) ?? null;
};

/**
 * Tells staff of every active client's bot secret in a stage it hasn't
 * been told of for its expiry day, at `now`. What became of each alert
 * sent, by client: none for a client without a bot, or whose secret is
 * further off than 60 days.
 */
export const warnOfExpiringSecrets = async (
  env: Env,
  now: Date
): Promise<Record<string, AlertOutcome>> => {
  const rows = await adminDatabase(env.DB)
    .select({ id: clients.id, teamsBot: clients.teamsBot })
    .from(clients)
    .where(and(eq(clients.status, "active"), isNotNull(clients.teamsBot)));
  const outcomes: Record<string, AlertOutcome> = {};
  for (const { id, teamsBot } of rows) {
    const bot = teamsBotOf(teamsBot);
    if (bot === null) {
      continue;
    }
    const days = daysUntil(bot.secretExpiresOn, now);
    const stage = stageOf(days);
    if (stage === null) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one alert at a time: the channel rate-limits
    outcomes[id] = await sendStaffAlert(
      env,
      {
        clientId: id,
        kind: "teams_bot_secret_expiring",
        subject: `${bot.secretExpiresOn}/${stage}`,
        numbers: { days },
      },
      now
    );
  }
  return outcomes;
};
