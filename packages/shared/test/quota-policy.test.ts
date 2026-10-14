import { describe, expect, it } from "vite-plus/test";

import { platformLimits } from "../src/platform-limits.ts";
import { quotaLimitsSchema, quotaPolicyOf } from "../src/quota-policy.ts";

describe("quota policy", () => {
  it("is the platform's own limits, generation 0, with no policy set", () => {
    expect(quotaPolicyOf()).toStrictEqual({
      generation: 0,
      limits: {
        workflowSteps: 1000,
        workflowAttemptsPerStep: 5,
        workflowNestingLevels: 8,
        workflowDescendantRuns: 100,
        workflowActiveMs: 30 * 60 * 1000,
        workflowAgeMs: 365 * 24 * 60 * 60 * 1000,
        lineageModelRequests: 100,
        lineageHostCalls: 10_000,
        workflowResourcesPerPerson: 200,
      },
    });
  });

  it("lowers the limits an operator sets, at its generation, and keeps the platform's for the rest", () => {
    const policy = quotaPolicyOf(
      quotaLimitsSchema.parse({
        generation: 7,
        limits: { workflowSteps: 200, workflowDescendantRuns: 10 },
      })
    );

    expect(policy).toMatchObject({
      generation: 7,
      limits: {
        workflowSteps: 200,
        workflowDescendantRuns: 10,
        workflowAttemptsPerStep: platformLimits.workflowAttemptsPerStep,
      },
    });
  });

  it("refuses a limit above the platform's, one at zero, one it doesn't enforce, or no generation", () => {
    const refused = [
      { generation: 1, limits: { workflowSteps: 1001 } },
      { generation: 1, limits: { workflowAttemptsPerStep: 6 } },
      { generation: 1, limits: { lineageModelRequests: 101 } },
      { generation: 1, limits: { workflowActiveMs: 30 * 60 * 1000 + 1 } },
      { generation: 1, limits: { workflowNestingLevels: 0 } },
      { generation: 1, limits: { lineageHostCalls: 10_001 } },
      { generation: 1, limits: { workflowBranches: 4 } },
      { generation: 1, limits: { workflowSteps: 1.5 } },
      { limits: { workflowSteps: 10 } },
      { generation: 0, limits: {} },
    ];

    expect(
      refused.map((value) => quotaLimitsSchema.safeParse(value).success)
    ).toStrictEqual(refused.map(() => false));
    expect(
      quotaLimitsSchema.safeParse({
        generation: 1,
        limits: { workflowSteps: platformLimits.workflowSteps },
      }).success
    ).toBeTruthy();
  });
});
