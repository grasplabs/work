/**
 * Telling Grasp's staff when something about a client, or the platform,
 * needs a person: one alert, with the client (or the rollout or release
 * it's about), what kind of alert it is and a link to its page in the
 * admin.
 *
 * Every alert is recorded in D1 (`alerts`), whatever its channel: the
 * Alerts inbox on Home and Platform lists the open ones, and staff
 * acknowledge and resolve each there, audited (src/alert-inbox.ts). The
 * channel is only a delivery: the webhook in Secrets Store
 * (`STAFF_ALERTS_WEBHOOK`), a Discord webhook as the morning digest's is
 * (src/discord-webhook.ts), which names the channel. Without one, an
 * alert is still in the inbox.
 *
 * Threat model, and how each is closed:
 *
 * - A person's content leaking into the channel. An alert's words are
 *   fixed per kind (`alertKinds`); all a caller adds is numbers
 *   (`AlertNumbers`), so no message, name of a file or anything a person
 *   wrote can reach it. The client is named by its id and its name as the
 *   admin keeps it, both of which staff see everywhere already.
 * - A storm. An alert of the same client and kind within its kind's window
 *   isn't raised again: claiming it is one statement (`claim`), so ten at
 *   once raise one, and the inbox keeps one open of each, counting.
 * - A send that fails. The claim is given back, so the next alert of the
 *   kind tries again rather than staying silent for a window; it was in
 *   the inbox already.
 * - An alert resolved while what raised it goes on. Resolving gives back
 *   its claim too, so the next time it's raised it's told again.
 * - A webhook that isn't Discord's. Never posted to (src/discord-webhook.ts).
 * - Pinging people. Nobody is mentioned (`allowed_mentions`).
 */
import { log } from "@grasp-os/shared/log";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { Staff } from "./access.ts";
import { ifStored } from "./clients/grid.ts";
import { actIfChanged, adminDatabase } from "./db/act.ts";
import { alerts, clients, staffAlerts } from "./db/schema.ts";
import { storeSecret } from "./deploy/context.ts";
import { discordWebhookOf, postToDiscord } from "./discord-webhook.ts";

/** What a caller may add to an alert: numbers alone, never words. */
export type AlertNumbers = Readonly<Record<string, number>>;

/**
 * What an alert is about, which its link opens: a client (its Setup), a
 * rollout (its page, the alert's subject naming it) or the releases.
 */
export type AlertAbout = "client" | "rollout" | "releases";

/** A kind of alert: its title, its sentence from its numbers, and its window. */
interface AlertKind {
  title: string;
  /** What happened, then what staff do next. */
  words: (numbers: AlertNumbers) => string;
  /** How long after one is raised another of the same client is held back. */
  windowMs: number;
  /** What it's about: a client's unless said. */
  about?: AlertAbout;
}

/** Every kind of alert's name. */
export type AlertKindName =
  | "test"
  | "teams_bot_secret_expiring"
  | "stephen_refused"
  | "stephen_failing"
  | "stephen_slow"
  | "stephen_over_budget"
  | "stephen_busy"
  | "stephen_sends_failing"
  | "stephen_uninstalled"
  | "stephen_connections_again"
  | "release_rolled_back"
  | "release_rollback_failed"
  | "hosting_check_failed"
  | "provisioning_failed"
  | "apply_failed"
  | "rollout_failed"
  | "release_import_failing"
  | "offboarding_failed"
  | "deletion_failed";

/** How many failed attempts at importing one release raise an alert. */
export const importAlertAttempts = 3;

/**
 * How long one of the watch's alerts holds back the next of its kind: as
 * long as it takes, since the watch clears it once the signal is back
 * under its bar (`clearStaffAlert`, src/clients/watch.ts). One alert as a
 * signal goes over; another only once it went back and over again.
 */
const untilClearedMs = 400 * 24 * 60 * 60 * 1000;

/** Milliseconds as seconds, to one decimal. */
const secondsOf = (ms: number): string => (ms / 1000).toFixed(1);

/** Every kind of alert, by name. */
export const alertKinds: Readonly<Record<AlertKindName, AlertKind>> = {
  /** Sent by staff, to see the channel works. */
  test: {
    title: "Test alert",
    words: () => "A test from the admin: staff alerts reach this channel.",
    windowMs: 60 * 1000,
  },
  /**
   * Its Teams bot's secret runs out soon (src/clients/teams-bot-expiry.ts):
   * `days` left, none or fewer once it has. Sent once for each stage of
   * each expiry day, which its subject names.
   */
  teams_bot_secret_expiring: {
    title: "Teams bot secret expiring",
    words: ({ days = 0 }) => {
      const action =
        "Mint a new client secret for its bot in its own Entra and set it on its Setup, with the day it expires.";
      if (days > 1) {
        return `Its Teams bot's secret expires in ${days} days. ${action}`;
      }
      if (days === 1) {
        return `Its Teams bot's secret expires tomorrow. ${action}`;
      }
      if (days === 0) {
        return `Its Teams bot's secret expires today: Stephen stops answering in Teams once it has. ${action}`;
      }
      return `Its Teams bot's secret has expired: Stephen can't answer in Teams. ${action}`;
    },
    // Each stage of an expiry day is its own subject: once is enough.
    windowMs: 400 * 24 * 60 * 60 * 1000,
  },
  // Stephen in the chat apps, over the last day, as the watch reads it.
  stephen_refused: {
    title: "Stephen: requests refused",
    words: ({ refused = 0 }) =>
      `Its door refused ${refused} requests in the last day as not sent by Teams for its bot. If its people are writing, check its bot's app id and tenant on its Setup.`,
    windowMs: untilClearedMs,
  },
  stephen_failing: {
    title: "Stephen: turns failing",
    words: ({ failed = 0, turns = 0 }) =>
      `${failed} of ${turns} turns in the last day ended in Stephen's line for a failure.`,
    windowMs: untilClearedMs,
  },
  stephen_slow: {
    title: "Stephen: answers slow",
    words: ({ p90Ms = 0 }) =>
      `9 in 10 answers in the last day took up to ${secondsOf(p90Ms)} s, over the bar of 12 s.`,
    windowMs: untilClearedMs,
  },
  stephen_over_budget: {
    title: "Stephen: over budget",
    words: ({ overBudget = 0 }) =>
      `${overBudget} turns in the last day were refused for the company's AI budget.`,
    windowMs: untilClearedMs,
  },
  stephen_busy: {
    title: "Stephen: busy",
    words: ({ busy = 0 }) =>
      `${busy} turns in the last day were turned away as the model or the agent was busy.`,
    windowMs: untilClearedMs,
  },
  stephen_sends_failing: {
    title: "Stephen: sends failing",
    words: ({ failed = 0 }) =>
      `Teams didn't take ${failed} of Stephen's answers or lines in the last day, besides any for an uninstalled app.`,
    windowMs: untilClearedMs,
  },
  stephen_uninstalled: {
    title: "Stephen: app uninstalled",
    words: ({ uninstalled = 0 }) =>
      `Teams refused ${uninstalled} of Stephen's answers in the last day as his app is no longer installed for those people.`,
    windowMs: untilClearedMs,
  },
  /**
   * A release failed its probe once its code was live, and the client was
   * rolled back to the release before on its own (src/hosting/operation.ts).
   */
  /**
   * Provisioning read back a database or bucket outside the jurisdiction
   * its hosting policy requires: it stopped, and the destination takes no
   * one until a person looks (src/hosting/provision.ts).
   */
  hosting_check_failed: {
    title: "Hosting check failed",
    words: () =>
      "Provisioning found a database or bucket outside the jurisdiction its hosting policy requires, and stopped. Nothing more is placed in that destination until someone checks it.",
    windowMs: untilClearedMs,
  },
  release_rolled_back: {
    title: "Release rolled back",
    words: () =>
      "A release failed its probe once live, so the client was rolled back to the release before. Look at the release before releasing it again.",
    windowMs: 60 * 1000,
  },
  /** As `release_rolled_back`, but the rollback didn't finish: it may serve broken. */
  release_rollback_failed: {
    title: "Release failed, rollback didn't finish",
    words: () =>
      "A release failed its probe once live, and rolling the client back didn't finish: it may be serving the broken release. Look at its Setup now.",
    windowMs: 60 * 1000,
  },
  /** A provisioning attempt stopped (src/hosting/workflow.ts). */
  provisioning_failed: {
    title: "Provisioning stopped",
    words: () =>
      "Setting it up stopped. Its Setup says at which step and why: fix that, then resume it from Hosting.",
    windowMs: 60 * 60 * 1000,
  },
  /** Applying its settings stopped (src/clients/apply.ts). */
  apply_failed: {
    title: "Applying settings stopped",
    words: () =>
      "Applying its settings stopped before they were live. Its Setup says why: fix that, then apply them again.",
    windowMs: 60 * 60 * 1000,
  },
  /**
   * A rollout stopped, or waits with `failed` fleet clients that failed
   * (src/rollout/workflow.ts): about the rollout its subject names.
   */
  rollout_failed: {
    title: "Rollout stopped",
    words: ({ failed = 0 }) =>
      failed > 0
        ? `${failed} ${failed === 1 ? "company" : "companies"} failed in a rollout, which waits for someone at Grasp. Open the rollout: retry them once fixed, or cancel it.`
        : "A rollout stopped. Open the rollout to see where and why, then start it again once fixed.",
    windowMs: 60 * 60 * 1000,
    about: "rollout",
  },
  /**
   * Importing a published release failed `attempts` times
   * (src/releases/import.ts): about the release its subject names.
   */
  release_import_failing: {
    title: "Release import failing",
    words: ({ attempts = 0 }) =>
      `Importing a release CI published failed ${attempts} times; it's tried again after a longer wait each time, and can't be rolled out until it imports. The Releases page says why: publish it again from CI if its files are wrong.`,
    windowMs: 24 * 60 * 60 * 1000,
    about: "releases",
  },
  /** Offboarding it failed for something other than a refusal staff act on at once. */
  offboarding_failed: {
    title: "Offboarding failed",
    words: () =>
      "Offboarding it failed, so it may still be served. Offboard it again from its Setup; if it fails again, its hostname or destination needs a look.",
    windowMs: 60 * 60 * 1000,
  },
  /** Deleting its resources failed part way, or was refused as not its own. */
  deletion_failed: {
    title: "Deleting resources failed",
    words: () =>
      "Deleting its resources failed, part way or before it began. Delete again from Platform's Offboarded page; what's gone stays deleted.",
    windowMs: 60 * 60 * 1000,
  },
  stephen_connections_again: {
    title: "Stephen: connections need a new sign-in",
    words: ({ company = 0, personal = 0 }) =>
      `${company} of the company's connections and ${personal} of people's own need a new sign-in before Stephen can use them.`,
    windowMs: untilClearedMs,
  },
};

/** An alert about client `clientId`. */
export interface StaffAlert {
  clientId: string;
  kind: AlertKindName;
  /**
   * What of the client it's about, when one kind can be about several
   * things in turn, such as the stage of a secret's expiry: alerts of
   * another subject aren't held back by this one's. An identifier: the
   * inbox names a rollout's or release's, never anything a person wrote.
   */
  subject?: string;
  numbers?: AlertNumbers;
}

/** An alert about the platform: a rollout or a release, its subject naming which. */
export interface PlatformStaffAlert extends Omit<StaffAlert, "clientId"> {
  clientId: null;
}

/** An alert about a client, or about the platform. */
export type AnyStaffAlert = StaffAlert | PlatformStaffAlert;

/** What `alert` is held back by: its kind, and its subject if it has one. */
const heldBy = ({
  kind,
  subject,
}: Pick<AnyStaffAlert, "kind" | "subject">): string =>
  subject === undefined ? kind : `${kind}/${subject}`;

/**
 * Whom an alert's claim names (`staff_alerts.client_id`, part of its key):
 * its client, or the empty string for one about the platform, which no
 * client id is.
 */
const claimantOf = (clientId: string | null): string => clientId ?? "";

/** The key of `alert` while it's open in the inbox: its client and what holds it back. */
const openKeyOf = (
  alert: Pick<AnyStaffAlert, "clientId" | "kind" | "subject">
): string => `${claimantOf(alert.clientId)}:${heldBy(alert)}`;

/** What became of an alert. */
export type AlertOutcome =
  /** Posted to the channel. */
  | "sent"
  /** One of the same client and kind went out within its window. */
  | "held"
  /** No channel is set, or it isn't a Discord webhook: in the inbox alone. */
  | "no_channel"
  /** The channel refused it; the next one tries again. */
  | "failed";

/** What became of an alert's delivery, as its record keeps it: its outcome, or still being posted. */
export type AlertDelivery = Exclude<AlertOutcome, "held"> | "sending";

/** The channel's webhook; null while there is none, or it isn't Discord's. */
const alertsWebhook = async (env: Env): Promise<URL | null> => {
  const stored = await ifStored(
    async () => await storeSecret(env, "STAFF_ALERTS_WEBHOOK")
  );
  if (stored === null) {
    return null;
  }
  const url = discordWebhookOf(stored);
  if (url === null) {
    log.warn("alerts.not_discord", {});
  }
  return url;
};

/**
 * Claims the send of `alert` at `now`: true when none of its client and
 * kind went out within its window, recording this one as sent. One
 * statement, so of alerts racing each other only one claims it.
 */
const claim = async (
  env: Env,
  alert: AnyStaffAlert,
  now: Date
): Promise<boolean> => {
  const db = adminDatabase(env.DB);
  const since = now.getTime() - alertKinds[alert.kind].windowMs;
  const claimed = await db
    .insert(staffAlerts)
    .values({
      clientId: claimantOf(alert.clientId),
      kind: heldBy(alert),
      sentAt: now,
    })
    .onConflictDoUpdate({
      target: [staffAlerts.clientId, staffAlerts.kind],
      set: { sentAt: now },
      setWhere: sql`${staffAlerts.sentAt} <= ${since}`,
    })
    .returning({ kind: staffAlerts.kind });
  return claimed.length > 0;
};

/** Gives back the claim of `alert` made at `at`, unless a later one replaced it. */
const release = async (
  env: Env,
  alert: AnyStaffAlert,
  at: Date
): Promise<void> => {
  const db = adminDatabase(env.DB);
  await db
    .delete(staffAlerts)
    .where(
      and(
        eq(staffAlerts.clientId, claimantOf(alert.clientId)),
        eq(staffAlerts.kind, heldBy(alert)),
        eq(staffAlerts.sentAt, at)
      )
    );
};

/**
 * Records `alert`, raised at `now`, in the inbox: a new open alert, or one
 * more time of the one open already of its client, kind and subject.
 * Answers its id.
 */
const record = async (
  env: Env,
  alert: AnyStaffAlert,
  now: Date,
  delivery: AlertDelivery
): Promise<string> => {
  const numbers = JSON.stringify(alert.numbers ?? {});
  const [row] = await adminDatabase(env.DB)
    .insert(alerts)
    .values({
      id: crypto.randomUUID(),
      clientId: alert.clientId,
      kind: alert.kind,
      subject: alert.subject ?? null,
      numbers,
      openKey: openKeyOf(alert),
      raisedAt: now,
      lastRaisedAt: now,
      times: 1,
      delivery,
    })
    .onConflictDoUpdate({
      target: alerts.openKey,
      set: {
        numbers,
        lastRaisedAt: now,
        times: sql`${alerts.times} + 1`,
        delivery,
      },
    })
    .returning({ id: alerts.id });
  if (row === undefined) {
    throw new Error("The alert wasn't recorded");
  }
  return row.id;
};

/** Records what became of alert `id`'s delivery. */
const delivered = async (
  env: Env,
  id: string,
  delivery: AlertDelivery
): Promise<void> => {
  await adminDatabase(env.DB)
    .update(alerts)
    .set({ delivery })
    .where(eq(alerts.id, id));
};

/** Who resolves an alert: a staff member in the inbox, or the admin once its signal cleared. */
export type Resolver = Staff | "system";

/**
 * Resolves the open alert `id` as `by`, audited (`alert.resolve`), and
 * gives back what holds back the next of its client, kind and subject, so
 * raised again it's told again. Whether it was open.
 */
export const resolveStaffAlert = async (
  env: Env,
  by: Resolver,
  id: string,
  now = new Date()
): Promise<boolean> => {
  const db = adminDatabase(env.DB);
  const open = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.id, id), isNull(alerts.resolvedAt)))
    .get();
  if (open === undefined) {
    return false;
  }
  // What holds it back, as `heldBy` makes it.
  const kind =
    open.subject === null ? open.kind : `${open.kind}/${open.subject}`;
  return await actIfChanged(
    db,
    by,
    db
      .update(alerts)
      .set({
        resolvedAt: now,
        resolvedBy: by === "system" ? "system" : by.email,
        openKey: null,
      })
      .where(and(eq(alerts.id, id), isNull(alerts.resolvedAt))),
    {
      action: "alert.resolve",
      ...(open.clientId === null ? {} : { clientId: open.clientId }),
      target: id,
      detail: { kind: open.kind },
    },
    [
      db
        .delete(staffAlerts)
        .where(
          and(
            eq(staffAlerts.clientId, claimantOf(open.clientId)),
            eq(staffAlerts.kind, kind)
          )
        ),
    ]
  );
};

/**
 * Acknowledges the open alert `id` as `staff`, audited
 * (`alert.acknowledge`): someone at Grasp is on it. It stays open until
 * resolved. Whether it was open and not acknowledged yet.
 */
export const acknowledgeStaffAlert = async (
  env: Env,
  staff: Staff,
  id: string,
  now = new Date()
): Promise<boolean> => {
  const db = adminDatabase(env.DB);
  const open = await db
    .select({ clientId: alerts.clientId, kind: alerts.kind })
    .from(alerts)
    .where(eq(alerts.id, id))
    .get();
  if (open === undefined) {
    return false;
  }
  return await actIfChanged(
    db,
    staff,
    db
      .update(alerts)
      .set({ acknowledgedAt: now, acknowledgedBy: staff.email })
      .where(
        and(
          eq(alerts.id, id),
          isNull(alerts.resolvedAt),
          isNull(alerts.acknowledgedAt)
        )
      ),
    {
      action: "alert.acknowledge",
      ...(open.clientId === null ? {} : { clientId: open.clientId }),
      target: id,
      detail: { kind: open.kind },
    }
  );
};

/**
 * Clears what holds back the next `kind` alert about client `clientId`
 * (or the platform, null), of `subject` if it has one, and resolves the
 * one open in the inbox as the admin's own (`system`): the watch's
 * alerts, once their signal is back under its bar, so the next time it
 * goes over is told again; a release's import alert once it imported.
 * Whether one was held.
 */
export const clearStaffAlert = async (
  env: Env,
  clientId: string | null,
  kind: AlertKindName,
  subject?: string
): Promise<boolean> => {
  const db = adminDatabase(env.DB);
  const open = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(eq(alerts.openKey, openKeyOf({ clientId, kind, subject })))
    .get();
  if (open !== undefined) {
    await resolveStaffAlert(env, "system", open.id);
  }
  const cleared = await db
    .delete(staffAlerts)
    .where(
      and(
        eq(staffAlerts.clientId, claimantOf(clientId)),
        eq(staffAlerts.kind, heldBy({ kind, subject }))
      )
    )
    .returning({ kind: staffAlerts.kind });
  return cleared.length > 0 || open !== undefined;
};

/** Where an alert's link goes: a client's Setup, a rollout's page, or the releases. */
export type AlertPage =
  | { to: "setup"; clientId: string }
  | { to: "rollout"; rolloutId: string }
  | { to: "releases" }
  | { to: "platform" };

/** The page that alert `alert` of kind `kind` opens. */
export const alertPageOf = (
  alert: Pick<AnyStaffAlert, "clientId" | "kind" | "subject">
): AlertPage => {
  const about = alertKinds[alert.kind].about ?? "client";
  if (about === "rollout" && alert.subject !== undefined) {
    return { to: "rollout", rolloutId: alert.subject };
  }
  if (about === "releases") {
    return { to: "releases" };
  }
  return alert.clientId === null
    ? { to: "platform" }
    : { to: "setup", clientId: alert.clientId };
};

/** `page` as a path in the admin. */
const pathOf = (page: AlertPage): string => {
  switch (page.to) {
    case "setup": {
      return `/organizations/${encodeURIComponent(page.clientId)}/setup`;
    }
    case "rollout": {
      return `/platform/rollouts/${encodeURIComponent(page.rolloutId)}`;
    }
    case "releases": {
      return "/platform/releases";
    }
    case "platform": {
      return "/platform";
    }
    default: {
      return page satisfies never;
    }
  }
};

/** `alert`'s page in the admin; null while the admin has no hostname of its own. */
const alertPage = (env: Env, alert: AnyStaffAlert): string | null => {
  const host = env.ADMIN_HOST ?? "";
  return host === "" ? null : `https://${host}${pathOf(alertPageOf(alert))}`;
};

/** `alert` about the client named `name` as its message. */
const messageOf = (
  env: Env,
  alert: AnyStaffAlert,
  name: string | null
): string => {
  const kind = alertKinds[alert.kind];
  let about = "the platform";
  if (alert.clientId !== null) {
    about = name === null ? alert.clientId : `${name} (${alert.clientId})`;
  }
  const page = alertPage(env, alert);
  return [
    `**${kind.title}**: ${about}`,
    kind.words(alert.numbers ?? {}),
    ...(page === null ? [] : [page]),
  ].join("\n");
};

/** Client `clientId`'s name as the admin keeps it; null for the platform or one it lost. */
const nameOf = async (
  env: Env,
  clientId: string | null
): Promise<string | null> => {
  if (clientId === null) {
    return null;
  }
  const [client] = await adminDatabase(env.DB)
    .select({ name: clients.name })
    .from(clients)
    .where(eq(clients.id, clientId));
  return client?.name ?? null;
};

/**
 * Tells staff `alert` at `now`: recorded in the inbox, and posted to the
 * alerts' channel when there is one, unless one of the same client and
 * kind was raised within its window. What became of it; never throws for
 * the channel, so whatever raised the alert goes on.
 */
export const sendStaffAlert = async (
  env: Env,
  alert: AnyStaffAlert,
  now = new Date()
): Promise<AlertOutcome> => {
  const fields = { client: alert.clientId ?? "platform", kind: alert.kind };
  if (!(await claim(env, alert, now))) {
    return "held";
  }
  const webhook = await alertsWebhook(env);
  if (webhook === null) {
    await record(env, alert, now, "no_channel");
    log.warn("alerts.no_channel", fields);
    return "no_channel";
  }
  const id = await record(env, alert, now, "sending");
  try {
    const posted = await postToDiscord(
      webhook,
      messageOf(env, alert, await nameOf(env, alert.clientId))
    );
    if (posted.ok) {
      await delivered(env, id, "sent");
      log.info("alerts.sent", fields);
      return "sent";
    }
    log.warn("alerts.refused", { ...fields, status: posted.status });
  } catch {
    // Nothing of the webhook's URL: it's the channel's credential.
    log.warn("alerts.unreachable", fields);
  }
  await delivered(env, id, "failed");
  await release(env, alert, now);
  return "failed";
};
