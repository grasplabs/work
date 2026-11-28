/**
 * The alert channels as staff run them on Platform's Maintenance page:
 * each switched on or off (`alert_channels`, off until switched on), set
 * up or not (src/alerts/senders.ts), and tried with a test alert that
 * looks like a real one (src/alerts/message.ts). Each is audited
 * (`alerts.on`, `alerts.off`, `alerts.test`).
 */
import "@tanstack/react-start/server-only";
import { and, eq } from "drizzle-orm";

import type { Staff } from "../access.ts";
import { actIfChanged, adminDatabase, audit } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import { alertChannels } from "../db/schema.ts";
import { alertChannelIds } from "./alert-channels.ts";
import type { AlertChannel } from "./alert-channels.ts";
import { testMessageOf } from "./message.ts";
import { senderOf } from "./senders.ts";
import type { AlertSender } from "./senders.ts";

/** One channel as the Maintenance page shows it. */
export interface AlertChannelState {
  channel: AlertChannel;
  on: boolean;
  /** Whether its binding or webhook is there: switched on without it, nothing is sent. */
  ready: boolean;
  /** The one mailbox mail goes to, for the mail channel once it's set up. */
  mailbox: string | null;
}

/** The channels switched on, as `alert_channels` holds them. */
export const switchedOn = async (
  db: AdminDatabase
): Promise<Set<AlertChannel>> => {
  const rows = await db.select().from(alertChannels);
  return new Set(rows.filter((row) => row.on).map((row) => row.channel));
};

/**
 * Each channel switched on now, with its sender: null while it isn't set
 * up, or its webhook can't be read just now.
 */
export const onChannels = async (
  env: Env
): Promise<Map<AlertChannel, AlertSender | null>> => {
  const on = await switchedOn(adminDatabase(env.DB));
  const senders = new Map<AlertChannel, AlertSender | null>();
  for (const channel of alertChannelIds) {
    if (on.has(channel)) {
      // oxlint-disable-next-line no-await-in-loop -- two channels
      senders.set(channel, await senderOf(env, channel));
    }
  }
  return senders;
};

/** Every channel: on or off, and set up or not. */
export const alertChannelStates = async (
  env: Env
): Promise<AlertChannelState[]> => {
  const on = await switchedOn(adminDatabase(env.DB));
  return await Promise.all(
    alertChannelIds.map(async (channel) => {
      const ready = (await senderOf(env, channel)) !== null;
      return {
        channel,
        on: on.has(channel),
        ready,
        mailbox:
          channel === "mail" && ready ? (env.ALERTS_MAIL_TO ?? null) : null,
      };
    })
  );
};

/**
 * Switches channel `channel` on or off, audited once when that changes it
 * (`alerts.on`, `alerts.off`): one without a row is off already.
 */
export const switchAlertChannel = async (
  env: Env,
  staff: Staff,
  channel: AlertChannel,
  on: boolean
): Promise<void> => {
  const db = adminDatabase(env.DB);
  await actIfChanged(
    db,
    staff,
    on
      ? db
          .insert(alertChannels)
          .values({ channel, on })
          .onConflictDoUpdate({
            target: alertChannels.channel,
            set: { on },
            setWhere: eq(alertChannels.on, false),
          })
      : db
          .update(alertChannels)
          .set({ on })
          .where(
            and(eq(alertChannels.channel, channel), eq(alertChannels.on, true))
          ),
    { action: on ? "alerts.on" : "alerts.off", target: channel }
  );
};

/** What became of a test alert: `sent`, `not_ready` (not set up), or the channel's code for refusing it. */
export type TestOutcome = string;

/**
 * Sends a test alert on channel `channel`, on or off, to see it works
 * before it's needed, and how a real one looks: a sample failure, and
 * on Discord its recovery beside it, each saying it's a test. Audited
 * with what became of it.
 */
export const sendTestAlert = async (
  env: Env,
  staff: Staff,
  channel: AlertChannel
): Promise<TestOutcome> => {
  const send = await senderOf(env, channel);
  const refused =
    send === null ? "not_ready" : await send(testMessageOf(env, new Date()));
  const outcome = refused ?? "sent";
  await audit(adminDatabase(env.DB), staff, {
    action: "alerts.test",
    target: channel,
    detail: { outcome },
  });
  return outcome;
};
