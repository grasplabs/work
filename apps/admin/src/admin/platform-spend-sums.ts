/**
 * What Grasp's own AI features cost on its keys, summed from what clients'
 * cores report (core's src/ai-status-report.ts): this month and last, in
 * all, by feature and by model, the dearest first. Pure, for the server's
 * reading (src/clients/platform-spend.ts) and the pages alike
 * (src/admin/platform-spend.tsx).
 */
import type {
  AiStatusReport,
  PlatformMonthSpend,
} from "@grasp-os/shared/ai-status-report";
import type { PlatformAiFeature } from "@grasp-os/shared/platform-ai";

/** Millionths of a US dollar in a dollar, as core reports them. */
export const microsPerDollar = 1_000_000;

/** The most organizations the platform's overview draws. */
export const topOrganizationsMost = 10;

/** From this share of its limit on, an organization's AI use is near it. */
const nearShare = 0.8;

/** A day, in milliseconds. */
const dayMs = 86_400_000;

/** Until a month is this many days old, its pace says too little to tell. */
const paceAfterDays = 3;

/** What one UTC month cost, in all, by feature and by model, the dearest first. */
export interface MonthSpend {
  /** Such as `2026-10`. */
  period: string;
  micros: number;
  byFeature: { feature: PlatformAiFeature | null; micros: number }[];
  byModel: { model: string; micros: number }[];
}

/** This month's and last month's. */
export interface SpendOverview {
  thisMonth: MonthSpend;
  lastMonth: MonthSpend;
}

/** What one organization cost Grasp this month and last, in micros. */
export interface OrganizationSpend {
  clientId: string;
  name: string;
  thisMonth: number;
  lastMonth: number;
  /**
   * Its own AI on Grasp's key this month (`spent`) against what it may
   * use a month (`limit`), in micros; null while it runs its AI on its
   * own key, or its release doesn't report it.
   */
  graspAi: { spent: number; limit: number } | null;
}

/** An organization the sums name: its stable id, and its name to say. */
export interface SpendOrganization {
  clientId: string;
  name: string;
}

/** The platform's: every active organization's summed, and each one's. */
export interface PlatformSpend extends SpendOverview {
  /** Each organization whose core reported it, the dearest this month first, then last. */
  byOrganization: OrganizationSpend[];
  /** How many active organizations were read. */
  organizations: number;
  /** The active organizations whose core didn't answer: not in the sums. */
  unread: SpendOrganization[];
  /**
   * The active organizations whose core answered on a release that
   * doesn't report what Grasp's features cost: not in the sums either.
   */
  unreported: SpendOrganization[];
}

/** `rows` summed by `keyOf`, the dearest first. */
const summedBy = <Row extends { micros: number }, K>(
  rows: readonly Row[],
  keyOf: (row: Row) => K
): { key: K; micros: number }[] => {
  const sums = new Map<K, number>();
  for (const row of rows) {
    const key = keyOf(row);
    sums.set(key, (sums.get(key) ?? 0) + row.micros);
  }
  return [...sums]
    .map(([key, micros]) => ({ key, micros }))
    .toSorted((one, other) => other.micros - one.micros);
};

/** What `period` cost, from as many reports' months as there are: those of other months left out. */
export const monthSpendOf = (
  period: string,
  months: readonly PlatformMonthSpend[]
): MonthSpend => {
  const rows = months
    .filter((month) => month.period === period)
    .flatMap((month) => month.rows);
  return {
    period,
    micros: rows.reduce((sum, row) => sum + row.micros, 0),
    byFeature: summedBy(rows, (row) => row.feature).map(({ key, micros }) => ({
      feature: key,
      micros,
    })),
    byModel: summedBy(rows, (row) => row.model).map(({ key, micros }) => ({
      model: key,
      micros,
    })),
  };
};

/** One organization's, as its core reported its months; null when its release doesn't report them. */
export const organizationSpendOf = ({
  platformSpend,
}: AiStatusReport): SpendOverview | null =>
  platformSpend === undefined
    ? null
    : {
        thisMonth: monthSpendOf(platformSpend.thisMonth.period, [
          platformSpend.thisMonth,
        ]),
        lastMonth: monthSpendOf(platformSpend.lastMonth.period, [
          platformSpend.lastMonth,
        ]),
      };

/** Its own AI on Grasp's key at or past `nearShare` of its limit. */
export const nearLimit = (spend: OrganizationSpend | undefined): boolean =>
  spend?.graspAi !== null &&
  spend?.graspAi !== undefined &&
  spend.graspAi.limit > 0 &&
  spend.graspAi.spent >= spend.graspAi.limit * nearShare;

/**
 * What `month` comes to by its end at the pace it went so far, in micros,
 * on `now`'s clock: null for a month that isn't `now`'s (UTC), or before
 * it is `paceAfterDays` old.
 */
export const monthPace = (month: MonthSpend, now: Date): number | null => {
  const [year = Number.NaN, number = Number.NaN] = month.period
    .split("-")
    .map(Number);
  const start = Date.UTC(year, number - 1, 1);
  const end = Date.UTC(year, number, 1);
  const elapsed = now.getTime() - start;
  if (elapsed < paceAfterDays * dayMs || now.getTime() >= end) {
    return null;
  }
  return Math.round((month.micros / elapsed) * (end - start));
};
