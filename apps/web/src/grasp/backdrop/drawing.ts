// What Backdrop and its two drawers share: how a drawing is started, run, held and stopped. The
// drawers themselves (sand.ts, shader.ts) are loaded only when a backdrop first comes into view.

/** A backdrop being drawn on its canvas. */
export interface Drawing {
  /** Draw on (true) or hold the last picture (false): off while it is out of view or the tab is hidden. */
  run: (on: boolean) => void;
  /** Stop for good and let go of what it holds. */
  stop: () => void;
}

/** What a drawer is given besides its canvas. */
export interface DrawOptions {
  /** Where what stands on the backdrop is, in the page's coordinates; undefined for nothing. */
  clear: () => DOMRect | undefined;
  /** Reduced motion: one settled picture, no loop. */
  still: boolean;
  /** How far the page has gone, 0 to 1, read at each picture (Backdrop's `progress`; 0 without it). */
  progress: () => number;
}

/** Counts a picture drawn on `canvas`, as `data-drawn`, so a check can see it draw and stop. */
export const drawn = (canvas: HTMLCanvasElement): void => {
  canvas.dataset.drawn = String(Number(canvas.dataset.drawn ?? "0") + 1);
};

/** A drawing with nothing to draw: what a drawer gives when its canvas has no context. */
export const nothingDrawn: Drawing = {
  run: () => {
    // Nothing to draw.
  },
  stop: () => {
    // Nothing held.
  },
};
