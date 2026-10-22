import { describe, expect, it } from "vite-plus/test";

import {
  pageOf,
  stopBeside,
  tourDue,
  tourPages,
  tourStops,
} from "./tour-script.ts";

// Which stops Stephen's tour takes for whom, when it offers itself, and
// where a step back or on lands.

const admin = { role: "admin", staff: false };
const builder = { role: "builder", staff: false };
const user = { role: "user", staff: false };
const staff = { role: "admin", staff: true };
const onboardingOnly = {
  role: "admin",
  staff: true,
  onboardingOnly: true as const,
};

describe(tourStops, () => {
  it("takes everyone who sees the product's sections through them in the sidebar's order, Chat last", () => {
    for (const viewer of [admin, builder, user, staff]) {
      expect(tourStops(viewer)).toStrictEqual([
        "brain",
        "domains",
        "workflows",
        "integrations",
        "chat",
      ]);
    }
  });

  it("skips every stop for staff who reach the onboarding alone, as their sidebar shows none of the pages", () => {
    expect(tourStops(onboardingOnly)).toStrictEqual([]);
  });

  it("goes only to pages the tour keeps going on, and says its last line where it is", () => {
    const stops = tourStops(user);
    for (const stop of stops) {
      const page = pageOf(stop);
      expect(page === null || tourPages.includes(page)).toBeTruthy();
    }
    expect(pageOf(stops.at(-1) ?? "brain")).toBeNull();
  });
});

describe(tourDue, () => {
  it("offers itself to someone who wasn't offered it before", () => {
    expect(tourDue({ viewer: user, seen: false, asked: false })).toBeTruthy();
  });

  it("offers itself once: not after it was offered in this browser or this visit", () => {
    expect(tourDue({ viewer: user, seen: true, asked: false })).toBeFalsy();
    expect(tourDue({ viewer: user, seen: false, asked: true })).toBeFalsy();
  });

  it("doesn't offer itself to someone it has no stops for", () => {
    expect(
      tourDue({ viewer: onboardingOnly, seen: false, asked: false })
    ).toBeFalsy();
  });
});

describe(stopBeside, () => {
  it("steps on and back between stops", () => {
    expect(stopBeside(0, 1, 5)).toBe(1);
    expect(stopBeside(3, -1, 5)).toBe(2);
  });

  it("stays on the first stop going back from it", () => {
    expect(stopBeside(0, -1, 5)).toBe(0);
  });

  it("ends the tour going on from the last stop", () => {
    expect(stopBeside(4, 1, 5)).toBe("end");
  });
});
