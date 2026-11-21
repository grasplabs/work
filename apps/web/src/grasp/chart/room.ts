// The room a chart keeps around its drawing, on its own without recharts:
// a chart's waiting frame (page-skeleton-dashboard) comes with the app and
// stands its lines in the same places.

/** The drawing's own inset, px, before any room for names: a waiting frame stands its lines inside it too. */
export const chartInset = { top: 8, right: 8 } as const;

/**
 * The room the axes take, px: the x axis's names under the drawing, the y axis's values before it.
 * A chart's waiting frame (page-skeleton-dashboard) stands its lines in the same places.
 */
export const chartAxisRoom = { x: 30, y: 36 } as const;
