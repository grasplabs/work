// How a spoken word gets from the composer to the page (heard.tsx): a
// handful of small squares, the same pixels as the dither the voice is
// drawn in, leave the composer's field one after another, bend the same
// way as one stream, and close in on the word's place. Each comes out of
// nothing as it leaves, shrinks on the way, and is gone as it lands, which
// is when the word's letters fade in (heard.tsx), so nothing is ever left
// lying on the text. Drawn on one canvas that lies over the words and the
// composer; it draws only while something is in the air. Free of React.

/** A place on the canvas, in its own pixels from its top left corner. */
export interface Place {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The flight, started on a canvas. */
export interface Flight {
  /** Sends a word's squares from `from` to `to`, leaving after `delay` ms. */
  fly: (from: Place, to: Place, delay: number) => void;
  stop: () => void;
}

/** How long one square is in the air, in ms; the letters start to show at `landsAt` of it. */
export const flightMs = 620;
export const landsAt = 0.62;
/** Over how long a word's squares leave, in ms: one after another, a stream and not a burst. */
const spreadMs = 220;
/** How far behind a square its two echoes follow, as a share of the way. */
const echo = 0.045;

interface Square {
  x0: number;
  y0: number;
  bx: number;
  by: number;
  x1: number;
  y1: number;
  at: number;
  time: number;
  side: number;
  colour: number;
}

/** A number from 0 to 1, always the same for the same three numbers. */
const hash = (a: number, b: number, c: number): number => {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43_758.5453;
  return s - Math.floor(s);
};

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

/** Slow to leave, slow to land, with no corner anywhere between. */
const ease = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** A point of a square's way, `t` of the way along its bend. */
const along = (square: Square, t: number): [number, number] => {
  const u = 1 - t;
  return [
    u * u * square.x0 + 2 * u * t * square.bx + t * t * square.x1,
    u * u * square.y0 + 2 * u * t * square.by + t * t * square.y1,
  ];
};

/** How much of a square shows `t` of the way: out of nothing, whole, and gone as it lands. */
const shows = (t: number): number =>
  clamp(t / 0.12) * clamp((1 - t) / 0.3) ** 1.5;

/** The brand's two inks a square is drawn in, read from the page. */
const inksOf = (canvas: HTMLCanvasElement): string[] => {
  const style = getComputedStyle(canvas);
  const inks = ["pine", "mint"]
    .map((name) => style.getPropertyValue(`--damsko-brand-${name}`).trim())
    .filter((ink) => ink !== "");
  return inks.length === 0 ? [style.color] : inks;
};

/** Draws every square in the air at `now`, and gives back those still flying. */
const drawAll = (
  context: CanvasRenderingContext2D,
  squares: Square[],
  inks: string[],
  now: number
): Square[] => {
  const left: Square[] = [];
  for (const square of squares) {
    const since = now - square.at;
    if (since < square.time) {
      left.push(square);
      if (since >= 0) {
        const t = ease(since / square.time);
        context.fillStyle = inks[square.colour % inks.length] ?? "#000";
        // Two echoes behind it, each fainter and finer, then the square itself.
        for (let back = 2; back >= 0; back -= 1) {
          const at = Math.max(0, t - back * echo);
          const [x, y] = along(square, at);
          const side = square.side * (1 - 0.45 * t) * (1 - back * 0.22);
          context.globalAlpha = shows(t) * (1 - back * 0.38);
          context.fillRect(x - side / 2, y - side / 2, side, side);
        }
      }
    }
  }
  context.globalAlpha = 1;
  return left;
};

/** A word's squares: how many, where each leaves and lands, and when. */
const squaresFor = (from: Place, to: Place, leaves: number): Square[] => {
  const seed = Math.floor(leaves * 7 + to.x * 13 + to.y) % 10_007;
  const count = Math.round(Math.min(20, Math.max(7, to.width / 3.5)));
  // One stream: every square of a word bends the same way, a little apart.
  const side = to.x + to.width / 2 < from.x + from.width / 2 ? 1 : -1;
  const bend = 0.16 + hash(seed, 2, 17) * 0.12;
  // The stream's root: one spot of the field, its squares close around it.
  const root = from.x + from.width * (0.3 + hash(seed, 3, 17) * 0.4);
  return Array.from({ length: count }, (_, index) => {
    const order = index / Math.max(1, count - 1);
    const x0 = root + (hash(seed, index, 47) - 0.5) * 36;
    // Out of the hill's body: the lower half of the field.
    const y0 = from.y + from.height * (0.55 + hash(seed, index, 53) * 0.3);
    // They land along the word from its start to its end, as it is written.
    const x1 = to.x + to.width * (0.08 + 0.84 * order);
    const y1 = to.y + to.height * (0.38 + hash(seed, index, 23) * 0.3);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const off = bend + (hash(seed, index, 29) - 0.5) * 0.06;
    return {
      x0,
      y0,
      bx: (x0 + x1) / 2 + dy * off * side,
      by: (y0 + y1) / 2 - Math.abs(dx) * off * 0.5,
      x1,
      y1,
      at: leaves + order * spreadMs,
      time: flightMs * (0.9 + hash(seed, index, 37) * 0.2),
      side: 2.5 + hash(seed, index, 41) * 1.5,
      colour: hash(seed, index, 43) < 0.7 ? 0 : 1,
    };
  });
};

/** The flight on `canvas`, which lies over the words and the composer. */
export const startFlight = (canvas: HTMLCanvasElement): Flight => {
  const context = canvas.getContext("2d");
  let squares: Square[] = [];
  let inks: string[] = [];
  let frame = 0;
  let stopped = false;
  let width = 0;
  let height = 0;

  const fit = () => {
    const box = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    ({ width, height } = box);
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    context?.setTransform(ratio, 0, 0, ratio, 0, 0);
  };
  const watcher = new ResizeObserver(fit);
  watcher.observe(canvas);
  fit();

  const draw = (now: number) => {
    frame = 0;
    if (stopped || context === null) {
      return;
    }
    context.clearRect(0, 0, width, height);
    squares = drawAll(context, squares, inks, now);
    if (squares.length > 0) {
      frame = requestAnimationFrame(draw);
    }
  };

  return {
    fly: (from, to, delay) => {
      if (stopped) {
        return;
      }
      if (squares.length === 0) {
        inks = inksOf(canvas);
      }
      squares.push(...squaresFor(from, to, performance.now() + delay));
      if (frame === 0) {
        frame = requestAnimationFrame(draw);
      }
    },
    stop: () => {
      stopped = true;
      watcher.disconnect();
      cancelAnimationFrame(frame);
    },
  };
};
