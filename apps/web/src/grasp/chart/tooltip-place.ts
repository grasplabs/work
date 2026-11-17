// Where a chart's tooltip stands up and down, so it hides as little as it can: above the highest
// hovered mark when there is room, else below the lowest, else in the taller of the two rooms
// beside them. Across, it stands a clear gap off the crosshair (Recharts' offset). Pure, so it is
// tested (scripts/chart-layout.test.ts). Positions are the drawing's own, in CSS pixels.

/**
 * The tooltip's top: `marks` are the hovered points' heights, `plot` the plot's top and height,
 * `height` the tooltip's own, and `gap` the clear room it keeps from every mark.
 */
export const tooltipTop = (
  marks: readonly number[],
  plot: { y: number; height: number },
  height: number,
  gap: number
): number | undefined => {
  if (marks.length === 0) {
    return undefined;
  }
  const highest = Math.min(...marks);
  const lowest = Math.max(...marks);
  const floor = plot.y + plot.height;
  const above = highest - gap - height;
  if (above >= plot.y) {
    return above;
  }
  const below = lowest + gap;
  if (below + height <= floor) {
    return below;
  }
  // No room clear of every mark: the taller side, held inside the plot.
  const up = highest - plot.y;
  const down = floor - lowest;
  return up >= down ? Math.max(plot.y, above) : Math.min(floor - height, below);
};

/**
 * Where a tooltip over bars stands across: centred above its bar when it stands above it, else
 * beside the bar's band (`band` wide round `x`), `gap` off it, on the side with room.
 */
export const barTooltipLeft = (
  x: number,
  band: number,
  width: number,
  plot: { x: number; width: number },
  gap: number,
  above: boolean
): number => {
  if (above) {
    return Math.min(
      Math.max(plot.x, x - width / 2),
      plot.x + plot.width - width
    );
  }
  const right = x + band / 2 + gap;
  return right + width <= plot.x + plot.width
    ? right
    : x - band / 2 - gap - width;
};
