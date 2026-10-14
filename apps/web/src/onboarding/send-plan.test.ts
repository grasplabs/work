import { describe, expect, it } from "vite-plus/test";

import {
  choiceHolds,
  choiceOfPlan,
  dayChoices,
  firstChoice,
  momentOf,
  planOf,
} from "./send-plan.ts";

// From the prototype's `lib/send-plan.test.ts`.

describe("the days offered", () => {
  it("are the next two working days and the Monday after", () => {
    // Monday 5 October 2026.
    expect(dayChoices("2026-10-05").map((each) => each.day)).toStrictEqual([
      "2026-10-06",
      "2026-10-07",
      "2026-10-12",
    ]);
  });

  it("skip the weekend, and never offer the same day twice", () => {
    // Friday 9 October 2026: Monday and Tuesday, so next week is the Monday after those.
    expect(dayChoices("2026-10-09").map((each) => each.day)).toStrictEqual([
      "2026-10-12",
      "2026-10-13",
      "2026-10-19",
    ]);
    // Thursday: Friday, Monday, and the Monday after.
    expect(dayChoices("2026-10-08").map((each) => each.day)).toStrictEqual([
      "2026-10-09",
      "2026-10-12",
      "2026-10-19",
    ]);
  });
});

describe("a choice", () => {
  const choice = firstChoice("2026-10-05");

  it("starts at nine on the next working day, for every team", () => {
    expect(choice).toStrictEqual({
      day: "2026-10-06",
      time: "09:00",
      held: [],
      heldDay: null,
      heldTime: "09:00",
    });
    expect(choiceHolds(choice, ["a", "b"])).toBeTruthy();
  });

  it("becomes a plan with the moment on this device's clock", () => {
    const plan = planOf(choice, 14);
    expect(plan.start).toBe("2026-10-06");
    expect(plan.at).toBe(new Date("2026-10-06T09:00:00").toISOString());
    expect(plan.later).toBeUndefined();
  });

  it("keeps the teams left out for later, with or without a moment", () => {
    expect(planOf({ ...choice, held: ["b"] }, 14).later).toStrictEqual({
      b: null,
    });
    expect(
      planOf({ ...choice, held: ["b"], heldDay: "2026-10-12" }, 14).later
    ).toStrictEqual({ b: new Date("2026-10-12T09:00:00").toISOString() });
  });

  it("does not hold without a real moment, with nobody to send to, or with a later team before the first", () => {
    expect(choiceHolds({ ...choice, time: "" }, ["a"])).toBeFalsy();
    expect(
      choiceHolds({ ...choice, held: ["a", "b"] }, ["a", "b"])
    ).toBeFalsy();
    expect(
      choiceHolds({ ...choice, held: ["b"], heldDay: "2026-10-05" }, ["a", "b"])
    ).toBeFalsy();
    expect(
      choiceHolds({ ...choice, held: ["b"], heldDay: "2026-10-06" }, ["a", "b"])
    ).toBeTruthy();
    expect(momentOf("tomorrow", "09:00")).toBeNull();
  });

  it("comes back from the plan it made", () => {
    const later = { ...choice, held: ["b"], heldDay: "2026-10-12" };
    expect(choiceOfPlan(planOf(later, 14))).toStrictEqual(later);
    expect(choiceOfPlan({ start: "2026-10-06" })).toStrictEqual(choice);
  });
});
