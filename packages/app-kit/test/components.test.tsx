import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Slider } from "../src/components/slider.tsx";

// The kit's changes to the registry's components that a render shows
// (packages/app-kit/local-changes.json). Those that need a browser are in
// kit.browser.test.tsx.

const thumbs = (markup: string): number =>
  markup.split('data-slot="slider-thumb"').length - 1;

describe("the slider", () => {
  // Upstream counts only arrays, so a single number got two thumbs.
  it("has one thumb for a single value and two for a range", () => {
    expect(thumbs(renderToStaticMarkup(<Slider defaultValue={40} />))).toBe(1);
    expect(thumbs(renderToStaticMarkup(<Slider value={40} />))).toBe(1);
    expect(
      thumbs(renderToStaticMarkup(<Slider defaultValue={[20, 80]} />))
    ).toBe(2);
    expect(thumbs(renderToStaticMarkup(<Slider />))).toBe(2);
  });
});
