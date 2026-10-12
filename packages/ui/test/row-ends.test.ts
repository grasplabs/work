import { endsOf, moveToShow } from "@grasp-os/ui/lib/row-ends";
import { describe, expect, it } from "vite-plus/test";

describe(endsOf, () => {
  it("marks no end of a row that shows all of itself", () => {
    expect(
      endsOf({ scrollLeft: 0, scrollWidth: 400, clientWidth: 400 })
    ).toStrictEqual({ start: false, end: false });
  });

  it("marks the far end of a row that starts at its first item", () => {
    expect(
      endsOf({ scrollLeft: 0, scrollWidth: 640, clientWidth: 400 })
    ).toStrictEqual({ start: false, end: true });
  });

  it("marks both ends in the middle", () => {
    expect(
      endsOf({ scrollLeft: 120, scrollWidth: 640, clientWidth: 400 })
    ).toStrictEqual({ start: true, end: true });
  });

  it("marks only the start once the row is moved to its end", () => {
    expect(
      endsOf({ scrollLeft: 240, scrollWidth: 640, clientWidth: 400 })
    ).toStrictEqual({ start: true, end: false });
  });

  it("takes a pixel of rounding for nothing: a zoomed page never ends exactly", () => {
    expect(
      endsOf({ scrollLeft: 0.6, scrollWidth: 400.8, clientWidth: 400 })
    ).toStrictEqual({ start: false, end: false });
    expect(
      endsOf({ scrollLeft: 239.4, scrollWidth: 640, clientWidth: 400 })
    ).toStrictEqual({ start: true, end: false });
  });
});

describe(moveToShow, () => {
  const row = { left: 24, right: 424 };

  it("leaves an item that is wholly in view where it is", () => {
    expect(moveToShow(row, { left: 100, right: 180 }, 24)).toBe(0);
  });

  it("moves the row on for an item cut at the far end, clear of the fade", () => {
    expect(moveToShow(row, { left: 400, right: 460 }, 24)).toBe(60);
  });

  it("moves the row back for an item cut at the start", () => {
    expect(moveToShow(row, { left: -30, right: 40 }, 24)).toBe(-78);
  });

  it("counts an item under the fade as cut, though all of it is inside the row", () => {
    expect(moveToShow(row, { left: 370, right: 420 }, 24)).toBe(20);
    expect(moveToShow(row, { left: 370, right: 420 }, 0)).toBe(0);
  });

  it("shows the start of an item the row has no room for", () => {
    expect(moveToShow(row, { left: 10, right: 600 }, 24)).toBe(-38);
  });

  it("shows the start of an item the row has no room for, though its start is in view", () => {
    expect(moveToShow(row, { left: 100, right: 700 }, 24)).toBe(52);
  });
});
