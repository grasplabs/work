import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Slider } from "../src/components/slider.tsx";

// What the kit's wrappers hand on to Base UI, read from what Base UI
// renders. Behaviour that needs a browser, such as arrow keys following a
// group's orientation, is in e2e/catalog.e2e.ts.

const thumbs = (markup: string): number =>
  markup.split('data-slot="slider-thumb"').length - 1;

describe("the slider", () => {
  it("has one thumb for a single value and two for a range", () => {
    expect(
      thumbs(renderToStaticMarkup(createElement(Slider, { defaultValue: 40 })))
    ).toBe(1);
    expect(
      thumbs(renderToStaticMarkup(createElement(Slider, { value: 40 })))
    ).toBe(1);
    expect(
      thumbs(
        renderToStaticMarkup(createElement(Slider, { defaultValue: [20, 80] }))
      )
    ).toBe(2);
    expect(thumbs(renderToStaticMarkup(createElement(Slider)))).toBe(2);
  });
});
