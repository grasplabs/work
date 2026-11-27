// The guide's mark (guide.tsx): an even, dotted outline round the one
// control Stephen is telling about, on a canvas over the whole window that
// never catches a press. Square dots of the system's pixel, evenly spaced
// along the control's own rounded shape a little apart from it, so its
// corners are as clean as its sides. No glow, no fill: the control stays as
// it is. Aimed at the next control, the outline there fades in where it is
// while the one before fades out: it never travels across the screen (the
// owner's ask, 2026-11-27). With reduced motion it simply shows. Read from
// the page at each frame (where the control is, in what colour), never
// through React.

/** A dot, and the distance from one dot to the next along the outline, in px. */
const DOT = 2;
const SPACING = 6;
/** The clear gap kept round the control, in px. */
const GAP = 5;
/** How quickly an outline fades in or out: a time constant, in ms. */
const FADE_MS = 140;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const boxOf = (element: Element): Box | null => {
  const rect = element.getBoundingClientRect();
  return rect.width === 0 && rect.height === 0
    ? null
    : { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
};

const approach = (from: number, to: number, step: number): number =>
  from + (to - from) * step;

/** The point `at` px along a rounded box's edge, clockwise from its top left corner's end. */
const pointOn = (box: Box, radius: number, at: number): [number, number] => {
  const straightW = box.w - 2 * radius;
  const straightH = box.h - 2 * radius;
  const arc = (Math.PI / 2) * radius;
  const corner = (
    cx: number,
    cy: number,
    from: number,
    along: number
  ): [number, number] => {
    const angle = from + (along / Math.max(arc, 0.001)) * (Math.PI / 2);
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  };
  let left = at;
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  if (left < straightW) {
    return [box.x + radius + left, box.y];
  }
  left -= straightW;
  if (left < arc) {
    return corner(right - radius, box.y + radius, -Math.PI / 2, left);
  }
  left -= arc;
  if (left < straightH) {
    return [right, box.y + radius + left];
  }
  left -= straightH;
  if (left < arc) {
    return corner(right - radius, bottom - radius, 0, left);
  }
  left -= arc;
  if (left < straightW) {
    return [right - radius - left, bottom];
  }
  left -= straightW;
  if (left < arc) {
    return corner(box.x + radius, bottom - radius, Math.PI / 2, left);
  }
  left -= arc;
  if (left < straightH) {
    return [box.x, bottom - radius - left];
  }
  left -= straightH;
  return corner(box.x + radius, box.y + radius, Math.PI, left);
};

/** A control's corner radius as it is drawn, in px. */
const radiusOf = (element: Element): number =>
  Number(
    /^[\d.]+/u.exec(getComputedStyle(element).borderTopLeftRadius)?.[0] ?? 0
  );

/** An outline: round which control, how its corner is drawn, how much it shows. */
interface Mark {
  target: Element;
  radius: number;
  box: Box | null;
  alpha: number;
}

export interface Light {
  /** Where the outline goes: a control, or nowhere (it fades). */
  aim: (target: Element | null) => void;
  stop: () => void;
}

/**
 * Outlines, on `canvas` (fixed over the window), the control it is aimed
 * at, in the colour `colour` reads, until stopped; `still` under reduced
 * motion.
 */
export const startLight = (
  canvas: HTMLCanvasElement,
  colour: () => string,
  still: boolean
): Light => {
  const context = canvas.getContext("2d");
  /** The outline aimed at now, and those fading out. */
  let current: Mark | null = null;
  let leaving: Mark[] = [];
  let last = performance.now();
  let frame = 0;
  let paint = "";
  let paintAt = -Infinity;
  let drawn = "";

  const fit = (): number => {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(window.innerWidth * ratio);
    const height = Math.round(window.innerHeight * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      drawn = "";
    }
    return ratio;
  };

  /** Its dots, evenly along the control's shape, `GAP` out from it. */
  const paintMark = (mark: Mark, ratio: number): void => {
    if (context === null || mark.box === null || mark.alpha < 0.01) {
      return;
    }
    const box = {
      x: mark.box.x - GAP,
      y: mark.box.y - GAP,
      w: mark.box.w + 2 * GAP,
      h: mark.box.h + 2 * GAP,
    };
    const radius = Math.min(mark.radius + GAP, box.w / 2, box.h / 2);
    const length =
      2 * (box.w - 2 * radius) +
      2 * (box.h - 2 * radius) +
      2 * Math.PI * radius;
    const count = Math.max(4, Math.round(length / SPACING));
    context.globalAlpha = mark.alpha;
    context.fillStyle = paint;
    for (let dot = 0; dot < count; dot += 1) {
      const [x, y] = pointOn(box, radius, (dot * length) / count);
      // On whole device pixels: every dot as crisp as the next.
      const px = Math.round((x - DOT / 2) * ratio) / ratio;
      const py = Math.round((y - DOT / 2) * ratio) / ratio;
      context.fillRect(px, py, DOT, DOT);
    }
    context.globalAlpha = 1;
  };

  const draw = (now: number): void => {
    frame = requestAnimationFrame(draw);
    if (context === null) {
      return;
    }
    const ratio = fit();
    const dt = Math.min(80, now - last);
    last = now;
    const step = still ? 1 : 1 - Math.exp(-dt / FADE_MS);
    // Each stays round its control as it is now: a layout that moves takes it along.
    for (const mark of [...leaving, ...(current === null ? [] : [current])]) {
      mark.box = boxOf(mark.target) ?? mark.box;
    }
    if (current !== null) {
      current.alpha = approach(current.alpha, 1, step);
    }
    for (const mark of leaving) {
      mark.alpha = approach(mark.alpha, 0, step);
    }
    leaving = leaving.filter((mark) => mark.alpha >= 0.01);
    if (now - paintAt > 400) {
      paint = colour();
      paintAt = now;
    }
    const marks = [...leaving, ...(current === null ? [] : [current])];
    const key = `${paint}|${marks
      .map(({ box, alpha }) =>
        box === null
          ? "-"
          : `${box.x.toFixed(1)},${box.y.toFixed(1)},${box.w.toFixed(1)},${box.h.toFixed(1)},${alpha.toFixed(3)}`
      )
      .join(";")}`;
    // Nothing moved: nothing to draw again.
    if (key === drawn) {
      return;
    }
    drawn = key;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (const mark of marks) {
      paintMark(mark, ratio);
    }
  };

  frame = requestAnimationFrame(draw);
  return {
    aim: (next) => {
      if (next === current?.target) {
        return;
      }
      if (current !== null) {
        leaving = [...leaving, current];
      }
      current =
        next === null
          ? null
          : {
              target: next,
              radius: radiusOf(next),
              box: boxOf(next),
              alpha: 0,
            };
    },
    stop: () => {
      cancelAnimationFrame(frame);
    },
  };
};
