import { describe, expect, it } from "vite-plus/test";

import { summaryIn } from "./summary.tsx";

describe(summaryIn, () => {
  it("leaves out the short lead-in and the question he ends on", () => {
    const line =
      "Okay, let me gather my notes. So in your week you mostly plan the routes for the drivers, check the orders that come in overnight, and call customers when a delivery slips. Does that sound like a good summary, or do you have anything to add?";
    const { from, to } = summaryIn(line);
    expect(line.slice(from, to).trim()).toBe(
      "So in your week you mostly plan the routes for the drivers, check the orders that come in overnight, and call customers when a delivery slips."
    );
  });

  it("keeps a line that is the summary alone whole", () => {
    const line =
      "You plan the routes for the drivers and check the orders that come in overnight.";
    expect(summaryIn(line)).toStrictEqual({ from: 0, to: line.length });
  });
});
