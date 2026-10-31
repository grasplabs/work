/**
 * What Grasp's own AI features (document conversion, transcription,
 * speech) cost on Grasp's keys, read from what each client's core reports
 * with its AI status (src/clients/ai-status.ts, core's
 * src/ai-status-report.ts): the model ledger's charges at list prices, in
 * US dollars. For the platform: every active organization's summed, with
 * the organizations that cost the most (src/admin/platform-spend-sums.ts).
 * Read only: there is no cap on these features; staff watch what they
 * cost here instead.
 */
import { eq } from "drizzle-orm";

import {
  monthSpendOf,
  topOrganizationsMost,
} from "../admin/platform-spend-sums.ts";
import type { PlatformSpend } from "../admin/platform-spend-sums.ts";
import { adminDatabase } from "../db/act.ts";
import { clients } from "../db/schema.ts";
import { defaultLiveReadLimits, eachLimited } from "../live-reads.ts";
import { readAiStatus } from "./ai-status.ts";

/** The UTC month `monthsBack` before `now`'s, such as `2026-09`. */
const periodOf = (now: Date, monthsBack: number): string =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1))
    .toISOString()
    .slice(0, 7);

/**
 * Every active organization's, read from its core now, a few at a time,
 * each within its deadline: summed for the admin's own this month and last
 * (a core whose clock reads another month adds nothing to it), with the
 * organizations that cost the most this month, then last.
 */
export const platformSpend = async (
  env: Env,
  now = new Date()
): Promise<PlatformSpend> => {
  const active = await adminDatabase(env.DB)
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(eq(clients.status, "active"))
    .all();
  const reports = await eachLimited(
    active,
    defaultLiveReadLimits.concurrency,
    async (client) => ({ client, report: await readAiStatus(env, client.id) })
  );
  const thisPeriod = periodOf(now, 0);
  const lastPeriod = periodOf(now, 1);
  // A core on a release before it reported spend answers its providers
  // only: not in the sums, and named for it.
  const reported = reports.flatMap(({ client, report }) =>
    report?.platformSpend === undefined
      ? []
      : [{ client, spend: report.platformSpend }]
  );
  const months = reported.flatMap(({ spend }) => [
    spend.thisMonth,
    spend.lastMonth,
  ]);
  const top = reported
    .flatMap(({ client, spend: reportedSpend }) => {
      const own = [reportedSpend.thisMonth, reportedSpend.lastMonth];
      const spend = {
        clientId: client.id,
        name: client.name,
        thisMonth: monthSpendOf(thisPeriod, own).micros,
        lastMonth: monthSpendOf(lastPeriod, own).micros,
      };
      return spend.thisMonth + spend.lastMonth > 0 ? [spend] : [];
    })
    .toSorted(
      (one, other) =>
        other.thisMonth - one.thisMonth ||
        other.lastMonth - one.lastMonth ||
        one.name.localeCompare(other.name)
    )
    .slice(0, topOrganizationsMost);
  return {
    thisMonth: monthSpendOf(thisPeriod, months),
    lastMonth: monthSpendOf(lastPeriod, months),
    top,
    organizations: active.length,
    unread: reports
      .filter(({ report }) => report === null)
      .map(({ client }) => client.name),
    unreported: reports
      .filter(
        ({ report }) => report !== null && report.platformSpend === undefined
      )
      .map(({ client }) => client.name),
  };
};
