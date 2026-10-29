/**
 * The Alerts inbox, on Home and Platform: every staff alert the admin
 * raised and nobody resolved yet (src/alerts.ts), whatever became of its
 * delivery to the channel, each with what happened, what to do next and a
 * link to where. Staff acknowledge one (someone is on it) and resolve it
 * (fixed), each audited, behind the Access check every request passes
 * (src/access.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import {
  acknowledgeStaffAlert,
  alertKinds,
  alertPageOf,
  resolveStaffAlert,
} from "./alerts.ts";
import type {
  AlertDelivery,
  AlertKindName,
  AlertNumbers,
  AlertPage,
} from "./alerts.ts";
import { adminDatabase } from "./db/act.ts";
import type { AdminDatabase } from "./db/act.ts";
import { alerts, clients } from "./db/schema.ts";

/** How many open alerts the inbox lists: the newest. */
export const inboxLimit = 50;

/** An open alert, as the inbox shows it. */
export interface AlertView {
  id: string;
  clientId: string | null;
  /** Its client's name as the admin keeps it; null for the platform, or a client it lost. */
  clientName: string | null;
  kind: AlertKindName;
  /** What of the client or platform it's about, such as a rollout's or release's id. */
  subject: string | null;
  title: string;
  /** What happened, then what to do next. */
  words: string;
  /** Where its link goes. */
  page: AlertPage;
  raisedAt: Date;
  lastRaisedAt: Date;
  /** How many times it was raised while open. */
  times: number;
  delivery: AlertDelivery;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
}

const isKind = (kind: string): kind is AlertKindName =>
  Object.hasOwn(alertKinds, kind);

const deliveries: readonly AlertDelivery[] = [
  "sent",
  "no_channel",
  "failed",
  "sending",
];
const isDelivery = (delivery: string): delivery is AlertDelivery =>
  deliveries.some((each) => each === delivery);

const numbersSchema = z.record(z.string(), z.number());

/** `text` as an alert's numbers; none for anything else. */
const numbersOf = (text: string): AlertNumbers => {
  try {
    const parsed = numbersSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
};

/** Every open alert, the newest raised first. */
export const openAlerts = async (db: AdminDatabase): Promise<AlertView[]> => {
  const rows = await db
    .select({ alert: alerts, clientName: clients.name })
    .from(alerts)
    .leftJoin(clients, eq(clients.id, alerts.clientId))
    .where(isNull(alerts.resolvedAt))
    .orderBy(desc(alerts.lastRaisedAt), desc(alerts.id))
    .limit(inboxLimit);
  return rows.flatMap(({ alert, clientName }) => {
    const { kind, delivery } = alert;
    // One of a kind this build no longer has isn't shown with words it lacks.
    if (!isKind(kind)) {
      return [];
    }
    const subject = alert.subject ?? undefined;
    return [
      {
        id: alert.id,
        clientId: alert.clientId,
        clientName,
        kind,
        subject: alert.subject,
        title: alertKinds[kind].title,
        words: alertKinds[kind].words(numbersOf(alert.numbers)),
        page: alertPageOf({ clientId: alert.clientId, kind, subject }),
        raisedAt: alert.raisedAt,
        lastRaisedAt: alert.lastRaisedAt,
        times: alert.times,
        delivery: isDelivery(delivery) ? delivery : "sending",
        acknowledgedBy: alert.acknowledgedBy,
        acknowledgedAt: alert.acknowledgedAt,
      },
    ];
  });
};

/** The inbox's open alerts. */
export const fetchAlerts = createServerFn({ method: "GET" }).handler(
  async () => await openAlerts(adminDatabase(env.DB))
);

const alertSchema = z.object({ alertId: z.string().min(1) });

/**
 * What acknowledging or resolving answers: refused as `not_open` when the
 * alert was resolved already, or acknowledged already, by someone else.
 */
export interface AlertActionResult {
  refused: "not_open" | null;
}

/** `changed` as an action's answer. */
const answerOf = (changed: boolean): AlertActionResult => ({
  refused: changed ? null : "not_open",
});

/** Acknowledging an open alert: someone at Grasp is on it. */
export const acknowledgeAlertFn = createServerFn({ method: "POST" })
  .validator(alertSchema)
  .handler(async ({ data, context }): Promise<AlertActionResult> =>
    answerOf(await acknowledgeStaffAlert(env, context.staff, data.alertId))
  );

/** Resolving an open alert: fixed, and told again if raised again. */
export const resolveAlertFn = createServerFn({ method: "POST" })
  .validator(alertSchema)
  .handler(async ({ data, context }): Promise<AlertActionResult> =>
    answerOf(await resolveStaffAlert(env, context.staff, data.alertId))
  );
