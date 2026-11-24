import type { Body, FigureShape, FigureState, Lean } from "./body";
import {
  CODES,
  bodyOf,
  hash,
  paintBody,
  paintStill,
  setPose,
  stepBody,
  thresholdAt,
} from "./body";

/** The grid a figure of `size` CSS pixels gets: 2px cells from 120px up, 1px below. */
export const gridFor = (size: number): { n: number; pitch: number } => {
  const pitch = size >= 120 ? 2 : 1;
  return { n: Math.floor(size / pitch), pitch };
};

interface Instance {
  step: (dt: number) => void;
  shown: boolean;
}

const instances = new Set<Instance>();
let frame = 0;
let last = 0;

const loop = (ms: number) => {
  frame = requestAnimationFrame(loop);
  const dt = last === 0 ? 1 / 60 : Math.min(0.1, (ms - last) / 1000);
  last = ms;
  for (const instance of instances) {
    if (instance.shown) {
      instance.step(dt);
    }
  }
};

const wake = () => {
  const any = [...instances].some((instance) => instance.shown);
  const visible = document.visibilityState === "visible";
  if (any && visible && frame === 0) {
    last = 0;
    frame = requestAnimationFrame(loop);
  } else if ((!any || !visible) && frame !== 0) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
};

/**
 * Where the page's attention is: the pointer, the last touch, or the control the keyboard has just
 * focused. Kept by passive listeners shared by every figure; read in the loop, never measured there.
 */
const pointer = { x: 0, y: 0, seen: false, at: 0, rest: 3500 };
let watching = false;
const attend = (x: number, y: number, at: number, rest: number) => {
  pointer.x = x;
  pointer.y = y;
  pointer.seen = true;
  pointer.at = at;
  pointer.rest = rest;
};
const watchPage = () => {
  if (watching) {
    return;
  }
  watching = true;
  const passive = { passive: true };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener(
    "pointermove",
    (event) => {
      attend(
        event.clientX,
        event.clientY,
        event.timeStamp,
        event.pointerType === "touch" ? 1500 : 3500
      );
    },
    passive
  );
  // A touch is looked at for a moment, then the eye comes back to the person.
  window.addEventListener(
    "pointerdown",
    (event) => {
      attend(
        event.clientX,
        event.clientY,
        event.timeStamp,
        event.pointerType === "touch" ? 1500 : 3500
      );
    },
    passive
  );
  // The pointer leaving the window: back to looking out.
  document.documentElement.addEventListener(
    "pointerleave",
    () => {
      pointer.seen = false;
    },
    passive
  );
  // The keyboard: it looks toward the control just focused (measured once, here, not in the loop).
  document.addEventListener(
    "focusin",
    (event) => {
      const { target } = event;
      if (target instanceof Element && target.matches(":focus-visible")) {
        const box = target.getBoundingClientRect();
        attend(
          box.left + box.width / 2,
          box.top + box.height / 2,
          event.timeStamp,
          4000
        );
      }
    },
    passive
  );
};

/** Where the attention is, seen from a figure's box: -1 to 1 each way, or straight out once it rests. */
const attentionFrom = (
  box: DOMRect,
  reach: number,
  now: number
): { x: number; y: number } => {
  if (!pointer.seen || now - pointer.at > pointer.rest) {
    return { x: 0, y: 0 };
  }
  const dx =
    (pointer.x - (box.left + box.width / 2)) / Math.max(reach, box.width * 1.6);
  const dy =
    -(pointer.y - (box.top + box.height / 2)) /
    Math.max(reach, box.height * 1.6);
  return { x: Math.max(-1, Math.min(1, dx)), y: Math.max(-1, Math.min(1, dy)) };
};

/** The palette's colours as bytes (RGBA), code by code: nothing, then the palette's own. */
const resolve = (
  host: HTMLElement,
  colours: readonly string[]
): Uint8ClampedArray => {
  const probe = document.createElement("span");
  host.append(probe);
  const paint = document.createElement("canvas").getContext("2d", {
    willReadFrequently: true,
  });
  const rgba = new Uint8ClampedArray(CODES * 4);
  for (const [index, colour] of colours.entries()) {
    probe.style.color = colour;
    const resolved = getComputedStyle(probe).color;
    if (paint !== null) {
      paint.clearRect(0, 0, 1, 1);
      paint.fillStyle = resolved;
      paint.fillRect(0, 0, 1, 1);
      rgba.set(paint.getImageData(0, 0, 1, 1).data, (index + 1) * 4);
    }
  }
  probe.remove();
  return rgba;
};

/** Paints `out`'s codes on `canvas`, `columns` by `rows` cells, in `colours`. */
const painter = (canvas: HTMLCanvasElement, columns: number, rows: number) => {
  const ctx = canvas.getContext("2d");
  const small = document.createElement("canvas");
  small.width = columns;
  small.height = rows;
  const smallCtx = small.getContext("2d");
  const image = smallCtx?.createImageData(columns, rows);
  const drawn = new Uint8Array(columns * rows).fill(255);
  return {
    forget: () => {
      drawn.fill(255);
    },
    paint: (out: Uint8Array, colours: Uint8ClampedArray) => {
      if (ctx === null || smallCtx === null || image === undefined) {
        return;
      }
      const { data } = image;
      let changed = false;
      for (let cell = 0; cell < out.length; cell += 1) {
        const value = out[cell] ?? 0;
        if (value !== drawn[cell]) {
          changed = true;
          drawn[cell] = value;
          for (let channel = 0; channel < 4; channel += 1) {
            data[cell * 4 + channel] = colours[value * 4 + channel] ?? 0;
          }
        }
      }
      if (!changed) {
        return;
      }
      smallCtx.putImageData(image, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
    },
  };
};

/** Starts `instance` while `canvas` is in view, and repaints on a change of theme. */
const run = (
  canvas: HTMLCanvasElement,
  instance: Instance,
  recolour: () => void
) => {
  watchPage();
  instances.add(instance);
  const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      instance.shown = entry.isIntersecting;
    }
    wake();
  });
  seen.observe(canvas);
  const themeWatch = new MutationObserver(recolour);
  themeWatch.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class", "style"],
  });
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", recolour);
  return () => {
    instances.delete(instance);
    seen.disconnect();
    themeWatch.disconnect();
    scheme.removeEventListener("change", recolour);
    wake();
  };
};

/** Repaints on a change of theme, and nothing else: a still figure never joins the frame loop. */
const watchTheme = (recolour: () => void) => {
  const themeWatch = new MutationObserver(recolour);
  themeWatch.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class", "style"],
  });
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", recolour);
  return () => {
    themeWatch.disconnect();
    scheme.removeEventListener("change", recolour);
  };
};

const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;
const ratioOf = () => Math.max(1, Math.round(window.devicePixelRatio || 1));

/** A figure, live on `canvas`. */
export interface LiveFigure {
  pose: (state: FigureState, shape: FigureShape, eye?: boolean) => void;
  recolour: (colours: readonly string[]) => void;
  stop: () => void;
}

export const mountFigure = (
  canvas: HTMLCanvasElement,
  options: {
    size: number;
    state: FigureState;
    shape: FigureShape;
    colours: readonly string[];
    follow: boolean;
    seed: number;
    /** One picture of its pose, never stepped: a list of many figures. */
    still?: boolean;
    /** The main agent's eye, on its orb. */
    eye?: boolean;
  }
): LiveFigure => {
  const { n, pitch } = gridFor(options.size);
  const reduced = reducedMotion() || options.still === true;
  const ratio = ratioOf();
  canvas.width = n * pitch * ratio;
  canvas.height = n * pitch * ratio;
  const host = canvas.parentElement ?? canvas;
  const cells = painter(canvas, n, n);
  let given = options.colours;
  let colours = resolve(host, given);
  const out = new Uint8Array(n * n);
  const lean: Lean = { x: 0, y: 0 };
  // The figure's box, measured on scroll and resize (passive), never in the loop.
  let box = canvas.getBoundingClientRect();
  const measure = () => {
    box = canvas.getBoundingClientRect();
  };
  if (options.follow && !reduced) {
    window.addEventListener("scroll", measure, {
      passive: true,
      capture: true,
    });
    window.addEventListener("resize", measure, { passive: true });
  }
  const body: Body = bodyOf(
    options.state,
    options.shape,
    options.seed,
    options.eye === true
  );
  const draw = () => {
    if (reduced) {
      paintStill(body.state, body.shape, n, out, body.eye);
    } else {
      paintBody(body, lean, n, out);
    }
    cells.paint(out, colours);
  };
  const instance: Instance = {
    shown: false,
    step: (dt) => {
      if (reduced) {
        return;
      }
      // The one that follows: its eye (if it has one) looks where the attention is, on its own
      // spring, and its light leans after it, eased (only a little, under an eye).
      if (options.follow) {
        const seen = attentionFrom(
          box,
          body.eye ? 260 : 200,
          performance.now()
        );
        body.look = seen;
        const ease = 1 - Math.exp(-dt / 0.4);
        const give = body.eye ? 0.35 : 1;
        lean.x += (seen.x * give - lean.x) * ease;
        lean.y += (seen.y * give - lean.y) * ease;
      }
      stepBody(body, dt);
      draw();
    },
  };
  const repaint = () => {
    colours = resolve(host, given);
    cells.forget();
    draw();
  };
  const stopRun =
    options.still === true
      ? watchTheme(repaint)
      : run(canvas, instance, repaint);
  const stop = () => {
    window.removeEventListener("scroll", measure, { capture: true });
    window.removeEventListener("resize", measure);
    stopRun();
  };
  draw();
  return {
    pose: (state, shape, eye = body.eye) => {
      setPose(body, state, shape);
      body.eye = eye;
      if (reduced) {
        draw();
      }
    },
    recolour: (next) => {
      given = next;
      repaint();
    },
    stop,
  };
};

/** An aura's cells: Damsko's fine dither, a 1px dot on a 3px pitch (`grasp/dither`'s dots). */
const AURA_PITCH = 3;

/**
 * The aura: the palette's own night behind a figure, clean, with a soft light behind where it
 * stands and a few points of light that come and go, in the palette's darker steps only, so the
 * figure is the brightest thing on it. Dithered on Bayer's thresholds as the figure is, drawn as
 * Damsko's fine dots on the night.
 */
export const mountAura = (
  canvas: HTMLCanvasElement,
  options: {
    colours: readonly string[];
    seed: number;
    bright: number;
    /** The light rises from the box's end corner, where a card's figure stands, not its middle. */
    corner?: boolean;
  }
): {
  recolour: (colours: readonly string[]) => void;
  brighten: (bright: number) => void;
  stop: () => void;
} => {
  let { bright } = options;
  const reduced = reducedMotion();
  const host = canvas.parentElement ?? canvas;
  const ctx = canvas.getContext("2d");
  const small = document.createElement("canvas");
  const smallCtx = small.getContext("2d");
  let image: ImageData | undefined;
  let given = options.colours;
  let colours = resolve(host, given);
  let columns = 0;
  let rows = 0;
  let seconds = options.seed * 13.7;
  let since = 1;
  // What stands still on the aura, worked out once per size: each cell's light behind the figure,
  // and the few points of light that come and go (all that a tick redraws).
  let behind = new Float64Array(0);
  let twinkling: number[] = [];
  let levels = new Uint8Array(0);
  const levelAt = (cell: number) => {
    const column = cell % columns;
    const row = Math.floor(cell / columns);
    const chance = hash(column * 1.31, row * 2.17);
    const near = behind[cell] ?? 0;
    // From a corner, points of light come only where its light reaches, never over the words.
    const reach = options.corner === true ? Math.min(1, near * 2.5) : 1;
    const twinkle =
      chance > 0.985
        ? reach *
          (0.5 + 0.5 * Math.sin(seconds * (0.6 + chance * 1.4) + chance * 40))
        : 0;
    const light = bright * (0.62 * near + 0.9 * twinkle);
    return Math.max(
      0,
      Math.min(3, Math.floor(light * 3 + thresholdAt(column, row) - 0.5))
    );
  };
  const measureLight = () => {
    behind = new Float64Array(columns * rows);
    twinkling = [];
    levels = new Uint8Array(columns * rows);
    const aspect = columns / Math.max(1, rows);
    // Where the light rises: the middle, or the block end's inline end corner (the left one when
    // the text runs right to left).
    const fromCorner = options.corner === true;
    const end = getComputedStyle(canvas).direction === "rtl" ? -1 : 1;
    const origin = fromCorner ? { x: end, y: 1 } : { x: 0, y: 0 };
    // From a corner it falls off faster, so the card's top, where its words stand, stays dark.
    const spread = fromCorner ? 0.4 : 0.55;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const x = ((column + 0.5) / columns) * 2 - 1;
        const y = ((row + 0.5) / rows) * 2 - 1;
        // A soft light behind where the figure stands.
        const dx = (x - origin.x) * aspect * 0.62;
        const dy = (y - origin.y) * (fromCorner ? 0.62 : 1);
        behind[row * columns + column] = Math.exp(
          -(dx * dx + dy * dy) / spread
        );
        // A few points of light, each coming and going at its own pace.
        if (hash(column * 1.31, row * 2.17) > 0.985) {
          twinkling.push(row * columns + column);
        }
      }
    }
  };
  const size = () => {
    const box = canvas.getBoundingClientRect();
    const ratio = ratioOf();
    columns = Math.max(1, Math.ceil(box.width / AURA_PITCH));
    rows = Math.max(1, Math.ceil(box.height / AURA_PITCH));
    small.width = columns * AURA_PITCH;
    small.height = rows * AURA_PITCH;
    canvas.width = small.width * ratio;
    canvas.height = small.height * ratio;
    image = smallCtx?.createImageData(small.width, small.height);
    measureLight();
  };
  /** Sets a cell's dot to its level's light. */
  const dot = (data: Uint8ClampedArray, cell: number, level: number) => {
    const at =
      (Math.floor(cell / columns) * AURA_PITCH * columns * AURA_PITCH +
        (cell % columns) * AURA_PITCH) *
      4;
    data.set(colours.subarray((level + 1) * 4, (level + 2) * 4), at);
  };
  const show = () => {
    if (ctx === null || smallCtx === null || image === undefined) {
      return;
    }
    smallCtx.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
  };
  /** The whole aura: on a new size, colour or brightness. */
  const draw = () => {
    if (image === undefined) {
      return;
    }
    const { data } = image;
    const ground = colours.subarray(4, 8);
    for (let at = 0; at < data.length; at += 4) {
      data.set(ground, at);
    }
    for (let cell = 0; cell < levels.length; cell += 1) {
      levels[cell] = levelAt(cell);
      dot(data, cell, levels[cell] ?? 0);
    }
    show();
  };
  /** A tick: only the points of light, shown only if one of them changed. */
  const drift = () => {
    if (image === undefined) {
      return;
    }
    let changed = false;
    for (const cell of twinkling) {
      const level = levelAt(cell);
      if (level !== levels[cell]) {
        changed = true;
        levels[cell] = level;
        dot(image.data, cell, level);
      }
    }
    if (changed) {
      show();
    }
  };
  const instance: Instance = {
    shown: false,
    // It drifts slowly: drawn about twelve times a second, which its pace needs.
    step: (dt) => {
      if (reduced) {
        return;
      }
      seconds += dt;
      since += dt;
      if (since >= 1 / 12) {
        since = 0;
        drift();
      }
    },
  };
  const repaint = () => {
    colours = resolve(host, given);
    draw();
  };
  const stopRun = run(canvas, instance, repaint);
  const resized = new ResizeObserver(() => {
    size();
    draw();
  });
  resized.observe(canvas);
  size();
  draw();
  return {
    recolour: (next) => {
      given = next;
      repaint();
    },
    brighten: (next) => {
      if (next !== bright) {
        bright = next;
        draw();
      }
    },
    stop: () => {
      resized.disconnect();
      stopRun();
    },
  };
};
