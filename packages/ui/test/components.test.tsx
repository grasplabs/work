import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ChartContainer,
  ChartTooltipContent,
} from "../src/components/chart.tsx";
import { Slider } from "../src/components/slider.tsx";

// What the kit's wrappers hand on to Base UI and recharts, read from what
// they render. Behaviour that needs a browser, such as arrow keys following
// a group's orientation, is in e2e/catalog.e2e.ts.

const thumbs = (markup: string): number =>
  markup.split('data-slot="slider-thumb"').length - 1;

describe("the slider", () => {
  it("has one thumb for a single value and two for a range", () => {
    expect(thumbs(renderToStaticMarkup(<Slider defaultValue={40} />))).toBe(1);
    expect(thumbs(renderToStaticMarkup(<Slider value={40} />))).toBe(1);
    expect(
      thumbs(renderToStaticMarkup(<Slider defaultValue={[20, 80]} />))
    ).toBe(2);
    expect(thumbs(renderToStaticMarkup(<Slider />))).toBe(2);
  });
});

// Rendered in a chart's container, as recharts renders it, with a prop
// recharts hands its content that isn't HTML (`separator`).
const tooltip = (
  props: Partial<ComponentProps<typeof ChartTooltipContent>>
): string =>
  renderToStaticMarkup(
    <ChartContainer config={{ visits: { label: "Visits", color: "chart-1" } }}>
      <ChartTooltipContent
        active
        payload={[
          {
            name: "visits",
            dataKey: "visits",
            value: 186,
            graphicalItemId: "bar",
          },
        ]}
        separator=" is "
        {...props}
      />
    </ChartContainer>
  );

describe("the chart tooltip", () => {
  it("shows a numeric label, such as a year", () => {
    expect(tooltip({ label: 2024 })).toContain(">2024<");
  });

  it("hands HTML props on to its element, and nothing else", () => {
    const markup = tooltip({ id: "visits-tooltip", "aria-live": "polite" });
    expect(markup).toContain('id="visits-tooltip"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain("separator");
  });
});
