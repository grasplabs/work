import { errorFields, log } from "@grasp-os/shared/log";
import { lastWeeks, weekOf } from "@grasp-os/shared/stephen-requests";
import type { WeeklySummary } from "@grasp-os/shared/stephen-requests";
import { and, asc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { activeMember } from "./auth/auth.ts";
import { signInConfig } from "./auth/config.ts";
import { companyDay } from "./channels/stephen-requests.ts";
import { teamsAdapter } from "./channels/teams.ts";
import { channelLocales, say } from "./channels/words.ts";
import type { ChannelLocale } from "./channels/words.ts";
import {
  stephenSummaries,
  stephenSummaryReaders,
  users,
} from "./db/core/schema.ts";
import { sendMail } from "./mail.ts";
import { readOrganization } from "./organization.ts";
import { summaryFor, teamsChatOf } from "./stephen-requests.ts";

// The weekly summary of Stephen's requests (GRA-1268): every Monday
// morning, in the company's time zone, to each owner or admin who asked
// for it, in Microsoft Teams from Stephen or by mail. A few lines of the
// week before: its requests against the week before that, the time they
// saved, what is new that he cannot do or does poorly, what was fixed
// lately and what it did since, and where the month is heading. Counts
// and Grasp's own wording only, as the page shows them.
//
// Queued as an outbox: one row per week and reader, written once, then
// sent from there and marked, so a week's summary goes once even when the
// clock runs twice: a run claims a row for as long as a send may take
// before it sends it, so a second run, or one restarted, passes it by.
// One that can't be sent is tried again a few times, then ends failed
// with its reason. Only to someone who is an admin asking for it as it
// is queued, and still is as it is sent; never to anyone else. A late
// one sums up the week it was queued for.

/** From this hour on a Monday, in the company's time zone, the week's summaries are queued. */
const fromHour = 7;

/** Tries before a summary ends failed. */
const attemptsMax = 5;

/** Most summaries one run sends. */
const sendMax = 20;

/** How long a run holds a summary it sends: longer than any send takes. */
const claimMs = 10 * 60_000;

/** The hour `at` is in, in `timeZone`; in UTC should the zone be unknown. */
const hourIn = (timeZone: string, at: Date): number => {
  try {
    return Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone,
        hour: "2-digit",
        hourCycle: "h23",
      }).format(at)
    );
  } catch {
    return at.getUTCHours();
  }
};

const localeOf = (locale: string | null): ChannelLocale =>
  channelLocales.find((each) => each === locale?.split("-")[0]) ?? "en";

/** The summary's lines, in `locale`, as they go out. */
export const summaryLines = (
  summary: WeeklySummary,
  locale: ChannelLocale
): string[] => {
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const count = number(summary.billed);
  const change =
    summary.billedBefore === 0
      ? null
      : summary.billed / summary.billedBefore - 1;
  const share = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(Math.abs(change ?? 0));
  const requests =
    change === null
      ? say("summaryRequests", locale, { count })
      : say(change >= 0 ? "summaryMore" : "summaryFewer", locale, {
          count,
          change: share,
        });
  return [
    requests,
    say("summaryHours", locale, {
      hours: number(Math.round(summary.minutes / 60)),
    }),
    ...summary.fresh.map((need) =>
      say("summaryNew", locale, { label: need.label })
    ),
    ...summary.fixed.map((need) =>
      say("summaryFixed", locale, {
        label: need.label,
        requests: number(need.since?.requests ?? 0),
      })
    ),
    ...(summary.pace === null || summary.included === null
      ? []
      : [
          say("summaryPace", locale, {
            pace: number(summary.pace),
            included: number(summary.included),
          }),
        ]),
  ];
};

/** The summary's title: its week. */
const titleOf = (summary: WeeklySummary, locale: ChannelLocale): string => {
  const day = (value: string) =>
    new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    }).format(new Date(`${value}T00:00:00Z`));
  return say("summaryTitle", locale, {
    from: day(summary.week.from),
    to: day(summary.week.to),
  });
};

const escaped = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * Whether `personId` may still have the summary as `via` sends it: still
 * an admin, and still asking for it that way. Checked as it is sent, not
 * only as it was queued.
 */
const stillReader = async (
  env: Env,
  personId: string,
  via: "teams" | "email"
): Promise<boolean> => {
  const found = await drizzle(env.DB)
    .select({ one: sql<number>`1` })
    .from(stephenSummaryReaders)
    .where(
      and(
        eq(stephenSummaryReaders.personId, personId),
        eq(stephenSummaryReaders.via, via),
        activeMember(personId, ["admin"])
      )
    )
    .get();
  return found !== undefined;
};

/** Sends one queued summary, of the week it was queued for; what became of it. */
const sendOne = async (
  env: Env,
  row: { week: string; personId: string; via: "teams" | "email" }
): Promise<{ sent: boolean; reason: string | null; retry: boolean }> => {
  if (!(await stillReader(env, row.personId, row.via))) {
    return { sent: false, reason: "not_reader", retry: false };
  }
  const summary = await summaryFor(env, row.personId, row.week);
  const origin = signInConfig(env)?.origin;
  const link = origin === undefined ? null : `${origin}/workflows/requests`;
  if (row.via === "teams") {
    const chat = await teamsChatOf(env, row.personId);
    if (chat === undefined) {
      return { sent: false, reason: "teams_closed", retry: false };
    }
    const locale = localeOf(chat.locale);
    const text = [
      `**${titleOf(summary, locale)}**`,
      ...summaryLines(summary, locale).map((line) => `- ${line}`),
      ...(link === null ? [] : [say("summaryOpen", locale, { url: link })]),
    ].join("\n");
    const adapter = await teamsAdapter(env);
    await adapter.postMessage(chat.threadId, text);
    return { sent: true, reason: null, retry: false };
  }
  const [person] = await drizzle(env.DB)
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, row.personId));
  if (person === undefined) {
    return { sent: false, reason: "no_person", retry: false };
  }
  const chat = await teamsChatOf(env, row.personId);
  const locale = localeOf(chat?.locale ?? null);
  const title = titleOf(summary, locale);
  const lines = summaryLines(summary, locale);
  const open = link === null ? null : say("summaryOpen", locale, { url: link });
  const sent = await sendMail(env, {
    to: person.email,
    subject: title,
    text: [
      title,
      "",
      ...lines.map((line) => `- ${line}`),
      ...(open === null ? [] : ["", open]),
    ].join("\n"),
    html: `<p><strong>${escaped(title)}</strong></p><ul>${lines.map((line) => `<li>${escaped(line)}</li>`).join("")}</ul>${link === null ? "" : `<p><a href="${escaped(link)}">${escaped(link)}</a></p>`}`,
    language: locale,
  });
  return sent.outcome === "sent"
    ? { sent: true, reason: null, retry: false }
    : { sent: false, reason: sent.reason, retry: sent.outcome === "retry" };
};

/**
 * The clock's task: on Monday from seven in the company's time zone,
 * queues the week's summary for each reader still an admin, once; then
 * sends what is queued.
 */
export const sendStephenSummaries = async (
  env: Env,
  now: Date
): Promise<void> => {
  const db = drizzle(env.DB);
  const [today, { timeZone }] = await Promise.all([
    companyDay(env, now),
    readOrganization(env),
  ]);
  if (weekOf(today) === today && hourIn(timeZone, now) >= fromHour) {
    const { week } = lastWeeks(today);
    await db.run(sql`INSERT INTO ${stephenSummaries}
      (week, person_id, via, state, attempts, queued_at)
      SELECT ${week.from}, ${stephenSummaryReaders.personId}, ${stephenSummaryReaders.via},
        'queued', 0, ${now.getTime()}
      FROM ${stephenSummaryReaders}
      WHERE ${activeMember(stephenSummaryReaders.personId, ["admin"])}
      ON CONFLICT DO NOTHING`);
  }
  // Free to take: queued, and not claimed by a run still within its lease.
  const free = and(
    eq(stephenSummaries.state, "queued"),
    or(
      isNull(stephenSummaries.claimedUntil),
      lt(stephenSummaries.claimedUntil, now)
    )
  );
  // One whose every try was taken by a run that never came back ends failed.
  await db
    .update(stephenSummaries)
    .set({ state: "failed", reason: "unfinished", settledAt: now })
    .where(and(free, gte(stephenSummaries.attempts, attemptsMax)));
  const queued = await db
    .select()
    .from(stephenSummaries)
    .where(and(free, lt(stephenSummaries.attempts, attemptsMax)))
    .orderBy(asc(stephenSummaries.queuedAt))
    .limit(sendMax);
  for (const row of queued) {
    const key = and(
      eq(stephenSummaries.week, row.week),
      eq(stephenSummaries.personId, row.personId),
      eq(stephenSummaries.state, "queued")
    );
    // Claimed before it is sent, for as long as a send may take: another
    // run passes it by until the claim ends, so it goes once.
    // oxlint-disable-next-line no-await-in-loop -- one at a time
    const taken = await db
      .update(stephenSummaries)
      .set({
        attempts: row.attempts + 1,
        claimedUntil: new Date(now.getTime() + claimMs),
      })
      .where(and(key, free, eq(stephenSummaries.attempts, row.attempts)));
    if (taken.meta.changes === 0) {
      continue;
    }
    let outcome: { sent: boolean; reason: string | null; retry: boolean };
    try {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      outcome = await sendOne(env, row);
    } catch (error) {
      log.warn("stephen_summary.unsent", errorFields(error));
      outcome = { sent: false, reason: "unexpected", retry: true };
    }
    const ended =
      outcome.sent || !outcome.retry || row.attempts + 1 >= attemptsMax;
    if (!ended) {
      // Free again for the next run to try.
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await db.update(stephenSummaries).set({ claimedUntil: null }).where(key);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one at a time
    await db
      .update(stephenSummaries)
      .set({
        state: outcome.sent ? "sent" : "failed",
        reason: outcome.reason,
        settledAt: now,
      })
      .where(key);
    if (!outcome.sent) {
      log.warn("stephen_summary.failed", {
        reason: outcome.reason ?? "unknown",
      });
    }
  }
};
