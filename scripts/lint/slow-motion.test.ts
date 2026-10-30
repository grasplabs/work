import { describe, expect, it } from "vite-plus/test";

import { findSlowClass, motionMs } from "./slow-motion.ts";

describe(findSlowClass, () => {
  it.each([
    ["transition-opacity duration-500", 500],
    ["data-open:duration-450 ease-out", 450],
    ["ease-out duration-[0.35s]", 350],
    ["duration-[400ms]", 400],
  ])("finds the slow duration in %j", (classes, ms) => {
    expect(findSlowClass(classes)).toBe(ms);
  });

  it.each([
    "transition-opacity duration-200",
    "duration-300",
    "animate-spin duration-1000",
    "a duration-500ms word in a sentence",
  ])("lets %j through", (classes) => {
    expect(findSlowClass(classes)).toBeUndefined();
  });
});

describe(motionMs, () => {
  it("reads Motion's seconds and the Web Animations API's milliseconds", () => {
    expect([motionMs(0.25), motionMs(700)]).toStrictEqual([250, 700]);
  });
});
