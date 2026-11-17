import { describe, expect, it } from "vite-plus/test";

import { nextStep, stageOf } from "./chat-stage.ts";
import type { ChatStage } from "./chat-stage.ts";

// How Grasp's chat moves from what shows toward its layout, step by step:
// it always arrives, in the order the person sees it (what goes before what
// comes), and once there it stays, whatever it shows.

/** Each step from `from` until nothing is left to do, as what it shows; at most 10. It always arrives. */
const stepsFrom = (from: ChatStage, to: ChatStage): string[] => {
  const shown: string[] = [];
  let stage = from;
  for (let step = nextStep(stage, to); step !== undefined;) {
    ({ stage } = step);
    shown.push(
      `bar:${stage.bar} room:${stage.room} card:${stage.card} ${stage.placement}`
    );
    if (shown.length > 10) {
      throw new Error(`It never arrives: ${shown.join(" → ")}`);
    }
    step = nextStep(stage, to);
  }
  expect(stage).toStrictEqual(to);
  return shown;
};

const closed = stageOf({
  available: true,
  open: false,
  placement: "docked",
  roomBeside: true,
  barHere: true,
});
const open = (placement: ChatStage["placement"]): ChatStage =>
  stageOf({
    available: true,
    open: true,
    placement,
    roomBeside: true,
    barHere: true,
  });

describe(nextStep, () => {
  it("stays where the layout is, in every place", () => {
    for (const placement of ["docked", "floating"] as const) {
      expect(stepsFrom(open(placement), open(placement))).toStrictEqual([]);
    }
    expect(stepsFrom(closed, closed)).toStrictEqual([]);
  });

  it("opens docked: the bar goes, then the room opens with the card", () => {
    expect(stepsFrom(closed, open("docked"))).toStrictEqual([
      "bar:false room:false card:false docked",
      "bar:false room:true card:true docked",
    ]);
  });

  it("closes docked the same way reversed", () => {
    expect(stepsFrom(open("docked"), closed)).toStrictEqual([
      "bar:false room:false card:false docked",
      "bar:true room:false card:false docked",
    ]);
  });

  it("floats: the card goes with the room, then comes in floating", () => {
    expect(stepsFrom(open("docked"), open("floating"))).toStrictEqual([
      "bar:false room:false card:false docked",
      "bar:false room:false card:true floating",
    ]);
  });

  it("leaves the page with nothing of it on a chat's own page, the room closing after the card", () => {
    const onChatPage = stageOf({
      available: false,
      open: true,
      placement: "docked",
      roomBeside: true,
      barHere: false,
    });
    expect(stepsFrom(open("docked"), onChatPage)).toStrictEqual([
      "bar:false room:false card:false docked",
    ]);
  });
});
