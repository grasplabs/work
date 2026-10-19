import { describe, expect, it } from "vite-plus/test";

import {
  choiceHolds,
  choiceOfPlan,
  dayChoices,
  firstChoice,
  momentOf,
  planOf,
  replanOf,
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

describe("a plan saved again", () => {
  const north = new Date("2026-10-12T09:00:00").toISOString();
  const south = new Date("2026-10-14T13:30:00").toISOString();
  // Saved from somewhere else: 21 days, the first links at a moment with seconds, and two teams each at their own moment.
  const saved = {
    start: "2026-10-06",
    days: 21,
    at: "2026-10-06T07:00:30.000Z",
    later: { north, south, east: null },
  };

  it("changes nothing the admin did not change", () => {
    expect(replanOf(choiceOfPlan(saved), saved, 14)).toStrictEqual(saved);
  });

  it("keeps how long the interviews run, and each team's moment, when only the first day changes", () => {
    const choice = { ...choiceOfPlan(saved), day: "2026-10-07" };
    expect(replanOf(choice, saved, 14)).toStrictEqual({
      start: "2026-10-07",
      days: 21,
      at: new Date(`2026-10-07T${choice.time}:00`).toISOString(),
      later: { north, south, east: null },
    });
  });

  it("gives a team newly held the moment shown, and every held team the moment the admin sets", () => {
    const shown = choiceOfPlan(saved);
    expect(
      replanOf({ ...shown, held: [...shown.held, "west"] }, saved, 14).later
    ).toStrictEqual({
      north,
      south,
      east: null,
      west: north,
    });
    const moved = new Date("2026-10-20T10:00:00").toISOString();
    expect(
      replanOf(
        { ...shown, heldDay: "2026-10-20", heldTime: "10:00" },
        saved,
        14
      ).later
    ).toStrictEqual({ north: moved, south: moved, east: moved });
  });

  it("runs the usual days when there was no plan", () => {
    const choice = firstChoice("2026-10-05");
    expect(replanOf(choice, null, 14)).toStrictEqual(planOf(choice, 14));
  });
});
