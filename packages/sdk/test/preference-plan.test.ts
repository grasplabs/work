import { describe, expect, test } from "vite-plus/test";

import { planPreferenceChange } from "../src/preference-plan.ts";
import type { PreferencePlan } from "../src/preference-plan.ts";
import { v } from "../src/values.ts";

// The preferences contract a store keeps across the versions sealed on it
// (preference-plan.ts): pure logic, so unit tests. Which changes to an
// App's preferences a seal accepts, and what the contract is after.

const compact = v.boolean().default(false);
const theme = v.enum(["light", "dark"]).default("light");

/** The preferences of a version declaring `fields`. */
const declaring = (fields: Parameters<typeof v.object>[0]) =>
  v.object(fields).descriptor;

/** The contract after a first version declaring `fields`. */
const contractOf = (fields: Parameters<typeof v.object>[0]) => {
  const plan = planPreferenceChange(null, declaring(fields));
  if (!plan.accepted) {
    throw new Error("The first version was refused");
  }
  return plan.contract;
};

/** The names of the preferences a plan refused, or "accepted". */
const refusedOf = (plan: PreferencePlan): string[] | "accepted" =>
  plan.accepted ? "accepted" : plan.refused.map(({ preference }) => preference);

describe("a store's preferences contract", () => {
  test("takes a first version's preferences whole", () => {
    expect(
      planPreferenceChange(null, declaring({ compact, theme }))
    ).toStrictEqual({
      accepted: true,
      contract: { compact: compact.descriptor, theme: theme.descriptor },
      changed: true,
    });
  });

  test("accepts a new preference, keeps one a version leaves out, and takes a new default", () => {
    const contract = contractOf({ compact, theme });
    const plan = planPreferenceChange(
      contract,
      declaring({
        theme: v.enum(["light", "dark"]).default("dark"),
        pageSize: v.number().integer().min(10).max(100).default(25),
      })
    );
    expect(plan).toStrictEqual({
      accepted: true,
      contract: {
        compact: compact.descriptor,
        pageSize: v.number().integer().min(10).max(100).default(25).descriptor,
        theme: v.enum(["light", "dark"]).default("dark").descriptor,
      },
      changed: true,
    });
  });

  test("is unchanged by a version declaring what it holds, or none at all", () => {
    const contract = contractOf({ compact, theme });
    expect(
      planPreferenceChange(contract, declaring({ compact }))
    ).toMatchObject({
      accepted: true,
      changed: false,
    });
    expect(planPreferenceChange(contract, null)).toMatchObject({
      accepted: true,
      changed: false,
    });
  });

  test.each([
    ["a narrowed enum", v.enum(["light"]).default("light")],
    ["a widened enum", v.enum(["light", "dark", "blue"]).default("light")],
    ["another kind", v.string().default("light")],
    ["a nullable one", v.enum(["light", "dark"]).nullable().default("light")],
  ])("refuses %s, whatever the default", (_case, changed) => {
    const contract = contractOf({ compact, theme });
    expect(
      refusedOf(
        planPreferenceChange(contract, declaring({ compact, theme: changed }))
      )
    ).toStrictEqual(["theme"]);
  });

  test("refuses a changed constraint, and a nested field's change", () => {
    const contract = contractOf({
      pageSize: v.number().integer().min(10).max(100).default(25),
      layout: v
        .object({ columns: v.number().integer().min(1).max(4) })
        .default({ columns: 2 }),
    });
    expect(
      refusedOf(
        planPreferenceChange(
          contract,
          declaring({
            pageSize: v.number().integer().min(10).max(50).default(25),
            layout: v
              .object({ columns: v.number().integer().min(1).max(6) })
              .default({ columns: 2 }),
          })
        )
      )
    ).toStrictEqual(["layout", "pageSize"]);
  });

  test("takes a removed preference back only as it was", () => {
    const contract = contractOf({ compact, theme });
    const removed = planPreferenceChange(contract, declaring({ compact }));
    if (!removed.accepted) {
      throw new Error("Removing a preference was refused");
    }
    expect([
      refusedOf(
        planPreferenceChange(
          removed.contract,
          declaring({
            compact,
            theme: v.enum(["light", "dark"]).default("dark"),
          })
        )
      ),
      refusedOf(
        planPreferenceChange(
          removed.contract,
          declaring({ compact, theme: v.enum(["light"]).default("light") })
        )
      ),
    ]).toStrictEqual(["accepted", ["theme"]]);
  });
});
