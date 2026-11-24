import { describe, expect, it } from "vite-plus/test";

import { stageOf } from "./chat-stage.ts";

// What of Grasp's chat shows on a page: the chat as it was laid out, or
// its idle bar where the page has one; floating only where there is room.

const laid = {
  available: true,
  open: true,
  placement: "floating",
  roomBeside: true,
  barHere: true,
} as const;

describe(stageOf, () => {
  it("shows the chat where it was put, and no bar", () => {
    expect(stageOf(laid)).toStrictEqual({
      bar: false,
      card: true,
      placement: "floating",
    });
  });

  it("docks it where there is no room beside the page to float over", () => {
    expect(stageOf({ ...laid, roomBeside: false }).placement).toBe("docked");
  });

  it("shows the bar while the chat is closed, where the page has one", () => {
    expect(stageOf({ ...laid, open: false })).toMatchObject({
      bar: true,
      card: false,
    });
    expect(stageOf({ ...laid, open: false, barHere: false }).bar).toBeFalsy();
  });

  it("shows nothing on a page the chat isn't on", () => {
    expect(stageOf({ ...laid, available: false })).toMatchObject({
      bar: false,
      card: false,
    });
  });
});
