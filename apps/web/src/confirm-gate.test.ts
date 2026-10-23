import { describe, expect, it } from "vite-plus/test";

import { confirmGate } from "./confirm-gate.ts";

// When Grasp's own dialog lets a confirmation count: never for a click or
// key already on its way, nor for a press begun before the button was.

describe("a confirmation's gate", () => {
  it("enables the button only once a whole delay passed with no input", () => {
    const gate = confirmGate(0, 1000);
    gate.input(600);
    gate.input(1500);
    expect(gate.enabledFrom()).toBe(2500);
  });

  it("is no longer moved by input once the button is enabled", () => {
    const gate = confirmGate(0, 1000);
    gate.input(1200);
    expect(gate.enabledFrom()).toBe(1000);
  });

  it("counts only a press that began once the button was enabled", () => {
    const early = confirmGate(0, 1000);
    early.press(900);
    const late = confirmGate(0, 1000);
    late.press(1000);
    const none = confirmGate(0, 1000);
    expect([early.accepts(), late.accepts(), none.accepts()]).toStrictEqual([
      false,
      true,
      false,
    ]);
  });

  it("counts no press begun before a restart moved the delay on", () => {
    const gate = confirmGate(0, 1000);
    gate.input(950);
    gate.press(1100);
    expect(gate.accepts()).toBeFalsy();
  });

  it("counts a click with no press of its own, as assistive technology sends, only once the button is enabled", () => {
    const early = confirmGate(0, 1000);
    const late = confirmGate(0, 1000);
    const pressedEarly = confirmGate(0, 1000);
    pressedEarly.press(900);
    expect([
      early.accepts(900),
      late.accepts(1000),
      // A press begun too early still decides, whatever click follows.
      pressedEarly.accepts(1200),
    ]).toStrictEqual([false, true, false]);
  });
});
