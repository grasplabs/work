import { aiPurposes } from "@grasp-os/shared/onboarding-staff";
import type {
  AiPurpose,
  StaffAiUseRow,
} from "@grasp-os/shared/onboarding-staff";

// The AI the onboarding used, as Grasp's area adds it up from what core
// counted (`onboardingStaff.aiUse`): in all, by purpose and the models
// each used, and by day. Pure, so tested on its own.

/** How much was used: calls, tokens read (of them from a cache) and written, and seconds of voice. */
export interface Used {
  calls: number;
  tokensIn: number;
  tokensCached: number;
  tokensOut: number;
  seconds: number;
}

const nothing = (): Used => ({
  calls: 0,
  tokensIn: 0,
  tokensCached: 0,
  tokensOut: 0,
  seconds: 0,
});

const plus = (sum: Used, row: Used): Used => ({
  calls: sum.calls + row.calls,
  tokensIn: sum.tokensIn + row.tokensIn,
  tokensCached: sum.tokensCached + row.tokensCached,
  tokensOut: sum.tokensOut + row.tokensOut,
  seconds: sum.seconds + row.seconds,
});

const sumOf = (rows: Used[]): Used => {
  let sum = nothing();
  for (const row of rows) {
    sum = plus(sum, row);
  }
  return sum;
};

/** The AI used, added up three ways. */
export interface AiUse {
  total: Used;
  /** Every purpose, in order, with the models it used, the most calls first. */
  purposes: {
    purpose: AiPurpose;
    used: Used;
    models: { model: string; used: Used }[];
  }[];
  /** The days with any use, the newest first. */
  days: { day: string; used: Used }[];
}

export const aiUseOf = (rows: readonly StaffAiUseRow[]): AiUse => {
  const days = new Map<string, Used>();
  for (const row of rows) {
    days.set(row.day, plus(days.get(row.day) ?? nothing(), row));
  }
  return {
    total: sumOf([...rows]),
    purposes: aiPurposes.map((purpose) => {
      const models = new Map<string, Used>();
      for (const row of rows.filter((each) => each.purpose === purpose)) {
        models.set(row.model, plus(models.get(row.model) ?? nothing(), row));
      }
      const used = [...models].map(([model, use]) => ({ model, used: use }));
      return {
        purpose,
        used: sumOf(used.map((each) => each.used)),
        models: used.toSorted((a, b) => b.used.calls - a.used.calls),
      };
    }),
    days: [...days]
      .map(([day, used]) => ({ day, used }))
      .toSorted((a, b) => b.day.localeCompare(a.day)),
  };
};
