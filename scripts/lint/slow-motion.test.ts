import { describe, expect, it } from "vite-plus/test";

import { durationMs, findSlowClass } from "./slow-motion.ts";

describe(findSlowClass, () => {
  it.each([
    ["transition-opacity duration-500", 500],
    ["data-open:duration-450 ease-out", 450],
    ["ease-out duration-[0.35s]", 350],
    ["duration-[400ms]", 400],
    ["duration-[calc(var(--strength)*400ms)]", 400],
  ])("finds the slow duration in %j", (classes, ms) => {
    expect(findSlowClass(classes)).toBe(ms);
  });

  it.each([
    "transition-opacity duration-200",
    "duration-300",
    "duration-[calc(var(--strength)*250ms)]",
    "animate-spin duration-1000",
    "a duration-500ms word in a sentence",
  ])("lets %j through", (classes) => {
    expect(findSlowClass(classes)).toBeUndefined();
  });
});

describe(durationMs, () => {
  it("reads a duration in the unit its API sets it in", () => {
    expect([durationMs(0.25, "s"), durationMs(700, "ms")]).toStrictEqual([
      250, 700,
    ]);
  });
});
