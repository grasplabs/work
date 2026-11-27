// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";

import { draggable, NAME_HANDLE } from "./floating.ts";

// Where a press on a floating panel's head may start a drag: the head's
// ground and its own move control, and the panel's name, which is a
// control only for its keys and its menu; never another control in the
// head, which keeps its press.

/** A head listening for presses, holding `inner`. */
const head = (inner: string, marked = false): HTMLElement => {
  const element = document.createElement("span");
  if (marked) {
    element.setAttribute(NAME_HANDLE, "");
  }
  element.innerHTML = inner;
  return element;
};

/** A main-button press on `target`, heard on `listener`. */
const press = (listener: HTMLElement, target: Element) =>
  draggable({ button: 0, target, currentTarget: listener });

describe("a press on a floating panel's head", () => {
  it("drags from the head's ground, and from the panel's name though its name is a button", () => {
    const ground = head("<span>words</span>");
    const name = head(
      '<button type="button"><span>Leave</span></button>',
      true
    );
    const words = name.querySelector("span span");
    const other = head('<button type="button">Close</button>');
    const close = other.querySelector("button");
    if (words === null || close === null) {
      throw new Error("No elements");
    }

    expect({
      ground: press(ground, ground.firstElementChild ?? ground),
      name: press(name, words),
      otherControl: press(other, close),
      secondButton: draggable({
        button: 2,
        target: words,
        currentTarget: name,
      }),
    }).toStrictEqual({
      ground: true,
      name: true,
      otherControl: false,
      secondButton: false,
    });
  });
});
