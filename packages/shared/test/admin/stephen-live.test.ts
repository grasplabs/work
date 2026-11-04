/**
 * When a group of real interviews did worse with a new Stephen
 * (stephen-live.ts): only beyond chance, never on a handful of interviews.
 */
import { describe, expect, it } from "vite-plus/test";

import { finishedFell, ratingFell } from "../../src/admin/stephen-live.ts";

const tally = (started: number, finished: number, ratings: number[] = []) => ({
  started,
  finished,
  ratings,
});

describe("who finished", () => {
  it("fell when the drop is larger than two standard errors", () => {
    expect(finishedFell(tally(20, 8), tally(20, 18))).toBeTruthy();
  });

  it("didn't fall on a drop chance explains, nor on a rise", () => {
    expect(finishedFell(tally(20, 15), tally(20, 17))).toBeFalsy();
    expect(finishedFell(tally(20, 18), tally(20, 8))).toBeFalsy();
  });

  it("says nothing with fewer than five interviews on either side", () => {
    expect(finishedFell(tally(4, 0), tally(20, 20))).toBeFalsy();
  });
});

describe("the rating", () => {
  it("fell when the means part by more than two standard errors", () => {
    expect(
      ratingFell(
        tally(6, 6, [2, 2, 3, 2, 3, 2]),
        tally(6, 6, [5, 4, 5, 5, 4, 5])
      )
    ).toBeTruthy();
  });

  it("didn't fall on noisy ratings, nor with too few of them", () => {
    expect(
      ratingFell(
        tally(6, 6, [1, 5, 2, 5, 3, 4]),
        tally(6, 6, [5, 1, 4, 5, 2, 5])
      )
    ).toBeFalsy();
    expect(
      ratingFell(tally(3, 3, [1, 1, 1]), tally(6, 6, [5, 5, 5, 5, 5, 5]))
    ).toBeFalsy();
  });
});
