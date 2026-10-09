import { describe, expect, it } from "vite-plus/test";

import { isFileGone, isPageFault } from "./error-reports.ts";

// A page's script file that a new release took away, as each browser says
// it, loads Grasp anew (route-error.tsx); anything else is not that. The
// e2e test (e2e/page-recovery.e2e.ts) runs it in Chromium.

const gone = [
  // Chromium
  new TypeError(
    "Failed to fetch dynamically imported module: https://grasp.example/assets/page-1a2b.js"
  ),
  // Firefox
  new TypeError(
    "error loading dynamically imported module: https://grasp.example/assets/page-1a2b.js"
  ),
  // Safari
  new TypeError("Importing a module script failed."),
];

describe("a page's file gone after a release", () => {
  it("is told apart in every browser, and isn't a fault to report", () => {
    expect(
      gone.map((error) => [isFileGone(error), isPageFault(error)])
    ).toStrictEqual([
      [true, false],
      [true, false],
      [true, false],
    ]);
  });

  it("is no other error", () => {
    const other = new TypeError("Cannot read properties of undefined");
    expect([isFileGone(other), isPageFault(other)]).toStrictEqual([
      false,
      true,
    ]);
  });
});
