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

/** Millionths of a US dollar in a dollar, as the ledger counts them. */
export const microsPerDollar = 1_000_000;

/** The most organizations the platform's overview lists. */
export const topOrganizationsMost = 10;

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
}

/** The platform's: every active organization's summed, and those that cost the most. */
export interface PlatformSpend extends SpendOverview {
  top: OrganizationSpend[];
  /** How many active organizations were read. */
  organizations: number;
  /** The active organizations whose core didn't answer: not in the sums. */
  unread: string[];
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

/** One organization's, as its core reported its months. */
export const organizationSpendOf = ({
  platformSpend,
}: AiStatusReport): SpendOverview => ({
  thisMonth: monthSpendOf(platformSpend.thisMonth.period, [
    platformSpend.thisMonth,
  ]),
  lastMonth: monthSpendOf(platformSpend.lastMonth.period, [
    platformSpend.lastMonth,
  ]),
});
