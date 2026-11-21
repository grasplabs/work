// The level slider's halftone: a field of dots across the track, one on every level-slider-pitch,
// each with a size drawn from its own seed, so the field reads as printed light rather than a grid.
//
// Up to the thumb the dots are lit: the ink and its deeper green, larger and denser further along,
// so more effort reads as more ink. The last few columns before the thumb glow warm, the light's
// leading edge. Past the thumb the dots rest: small, faint grey, still showing the field. When the
// level changes the lit edge pours to its new place in level-slider-snap (ease-out). The top level
// is its own state: every lit dot takes the working light's colours, fuller, and a wave of light
// runs along the track. With reduced motion the wave stands still.
//
// Every dot lands on whole device pixels: the canvas is the track's size times the display's
// ratio. It draws on change only, plus the breathing at the top level while it is in view.

/** What the field shows. */
export interface LevelFieldState {
  /** Where the lit part ends, 0 to 1 along the track. */
  fill: number;
  /** The top level is chosen and carries the light: the dots breathe. */
  top: boolean;
}

/** A field being drawn. */
export interface LevelField {
  set: (state: LevelFieldState) => void;
  stop: () => void;
}

/** How many columns before the thumb's body may glow warm, and how many warm dots at most. */
const WARM_COLUMNS = 2;
const MAX_WARM = 5;
/** How long the lit edge takes to reach a new place, in ms. Matches level-slider-snap. */
const POUR = 160;
/** One pass of the top level's wave along the track, in seconds: slow, so it never draws the eye. */
const BREATH = 4.8;

/** The fraction after the point. */
const fract = (value: number) => value - Math.floor(value);

/** A dot's seed, 0 to 1, the same every frame: its size and its colour come from it. */
const seed = (column: number, row: number) => {
  // Two passes of the classic sine hash, the second fed by the first, so no stripes show.
  const first = fract(Math.sin(column * 12.9898 + row * 78.233) * 43_758.5453);
  return fract(
    Math.sin(first * 91.3458 + column * 0.371 + row * 1.137) * 47_453.5453
  );
};

/** One dot as it is drawn: its size, colour and strength; or nothing, a hole in the field. */
interface Dot {
  radius: number;
  colour: string;
  alpha: number;
}

/** How a lit dot below the top level looks: the ink or its deeper green, or one of the warm few. */
const litDot = (
  n: number,
  biggest: number,
  grow: number,
  palette: Palette,
  glows: boolean
): Dot => {
  const ink = n > 0.55 ? palette.ink : palette.deep;
  // An even halftone with a gentle change: sizes in a narrow spread.
  return {
    radius: biggest * (0.62 + 0.38 * n) * grow,
    colour: glows ? palette.warm : ink,
    alpha: 1,
  };
};

/** How a lit dot at the top level looks: the working light, its lighter stop carried by the wave. */
const topDot = (
  n: number,
  biggest: number,
  palette: Palette,
  wave: number
): Dot => {
  const [base, crest, other] = palette.light;
  let colour = base;
  if (wave > 0.6) {
    colour = crest;
  } else if (n > 0.7) {
    colour = other;
  }
  return {
    radius: biggest * (0.7 + 0.3 * n),
    colour: colour ?? palette.ink,
    alpha: 1,
  };
};

/** How a resting dot looks, past the thumb: small and faint. */
const restDot = (n: number, biggest: number, palette: Palette): Dot => ({
  radius: biggest * (0.4 + 0.3 * n),
  colour: palette.rest,
  alpha: palette.restAlpha + 0.12 * n,
});

/** How likely a dot is to glow warm: in the two columns just before the thumb's body, most in the nearer. */
const warmChanceOf = (before: number) => {
  if (before <= 0 || before > WARM_COLUMNS) {
    return 0;
  }
  return before <= 1 ? 0.4 : 0.15;
};

/** The colours the field takes, as the page's tokens resolve here. */
interface Palette {
  /** The working light's stops, for the top level. */
  light: string[];
  deep: string;
  ink: string;
  warm: string;
  rest: string;
  restAlpha: number;
}

const paletteOf = (canvas: HTMLCanvasElement): Palette => {
  const style = getComputedStyle(canvas);
  // A token resolved by the browser (light-dark() and all), read back as a plain colour.
  const token = (name: string) => {
    canvas.style.outlineColor = `var(--grasp-${name})`;
    const resolved = getComputedStyle(canvas).outlineColor;
    canvas.style.outlineColor = "";
    return resolved;
  };
  // The canvas's colour is the ink: light ink means a dark page. Painted once to read it as sRGB,
  // whatever form the colour is written in.
  let dark = false;
  const probe = document.createElement("canvas").getContext("2d");
  if (probe !== null) {
    probe.fillStyle = style.color;
    probe.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
    dark = r + g + b > 384;
  }
  return dark
    ? {
        light: [token("light-mint"), token("light-lime"), token("light-sea")],
        deep: token("light-mint"),
        ink: token("light-lime"),
        warm: token("level-slider-warm"),
        rest: token("light-paper"),
        restAlpha: 0.2,
      }
    : {
        light: [token("mint-deep"), token("light-mint"), token("light-pine")],
        deep: token("light-pine"),
        ink: token("light-ink"),
        warm: token("level-slider-warm"),
        rest: token("light-ink"),
        restAlpha: 0.16,
      };
};

/** Starts drawing the field on `canvas`, sized to `track`. */
export const startLevelField = (
  canvas: HTMLCanvasElement,
  track: HTMLElement
): LevelField => {
  const ctx = canvas.getContext("2d");
  let state: LevelFieldState = { fill: 0, top: false };
  let shown = 0;
  let pourFrom = 0;
  let pourStart = 0;
  let frame = 0;
  let width = 0;
  let height = 0;
  let ratio = 1;
  let pitch = 4;
  let runInset = 2;
  let thumbInset = 3;
  let palette = paletteOf(canvas);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let inView = true;

  const fit = () => {
    const box = track.getBoundingClientRect();
    ratio = window.devicePixelRatio || 1;
    ({ width, height } = box);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    // The tokens read "4px"; the number before the unit is the length.
    const px = (name: string, fallback: number) =>
      Number(
        getComputedStyle(track)
          .getPropertyValue(`--grasp-level-slider-${name}`)
          .trim()
          .replace("px", "")
      ) || fallback;
    pitch = px("pitch", 4);
    runInset = px("run-inset", 2);
    thumbInset = px("thumb-inset", 3);
  };

  const draw = (now: number) => {
    if (ctx === null || width === 0) {
      return;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const rtl = getComputedStyle(track).direction === "rtl";
    // The dots fill the track's own round shape: right into the round ends, each dot kept only
    // when it lies inside the pill, a little in from its edge, so the field is round as the track is.
    const inset = pitch / 2;
    const cap = height / 2;
    const room = cap - pitch * 1.1;
    const inside = (along: number, y: number) => {
      const centre = Math.min(Math.max(along, cap), width - cap);
      return Math.hypot(along - centre, y - cap) <= room;
    };
    const rows = Math.max(1, Math.floor((height - pitch) / pitch));
    const columns = Math.max(1, Math.floor((width - 2 * inset) / pitch) + 1);
    const top = (height - (rows - 1) * pitch) / 2;
    // The lit part ends at the thumb's centre, which travels between the two round ends, kept
    // a little short of them (level-slider-run-inset) so the thumb's ring stays inside.
    const edge = cap + runInset + shown * (width - height - 2 * runInset);
    // Where the thumb's round body ends, toward the start: the warm dots stand just before it.
    const body = edge - (cap - thumbInset);
    const breath = state.top && !reduced.matches ? now / 1000 / BREATH : 0;
    // No two dots touch: the largest is its cell less a pixel.
    const biggest = (pitch - 1) / 2;
    let warmth = 0;
    for (let column = 0; column < columns; column += 1) {
      const along = inset + column * pitch;
      const x = rtl ? width - along : along;
      const lit = along <= edge + 0.5;
      // Further along, the lit dots grow a touch: more reads as more, quietly.
      const grow = 0.9 + 0.1 * (column / Math.max(1, columns - 1));
      const warmChance =
        lit && !state.top ? warmChanceOf((body - along) / pitch) : 0;
      for (let row = 0; row < rows; row += 1) {
        const n = seed(column, row);
        const y = top + row * pitch;
        // Outside the round shape, or a hole: a few in the lit part, more past the thumb.
        if (!inside(along, y) || n < (lit ? 0.12 : 0.25)) {
          continue;
        }
        let dot: Dot;
        if (!lit) {
          dot = restDot(n, biggest, palette);
        } else if (state.top) {
          // The top level: still with reduced motion, the wave standing where it is.
          dot = topDot(
            n,
            biggest,
            palette,
            Math.sin((along / Math.max(1, width) - breath) * Math.PI * 2 + n)
          );
        } else {
          const glows = warmth < MAX_WARM && seed(row, column) < warmChance;
          warmth += glows ? 1 : 0;
          dot = litDot(n, biggest, grow, palette, glows);
        }
        ctx.globalAlpha = dot.alpha;
        ctx.fillStyle = dot.colour;
        ctx.beginPath();
        ctx.arc(
          Math.round(x * ratio) / ratio,
          Math.round(y * ratio) / ratio,
          Math.max(0.5, dot.radius),
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  };

  const tick = (now: number) => {
    frame = 0;
    const pouring = now - pourStart < POUR && !reduced.matches;
    if (pouring) {
      const t = (now - pourStart) / POUR;
      shown = pourFrom + (state.fill - pourFrom) * (1 - (1 - t) ** 3);
    } else {
      shown = state.fill;
    }
    draw(now);
    if (
      (pouring || (state.top && !reduced.matches)) &&
      inView &&
      document.visibilityState === "visible"
    ) {
      frame = requestAnimationFrame(tick);
    }
  };

  const wake = () => {
    if (frame === 0) {
      frame = requestAnimationFrame(tick);
    }
  };

  const resized = new ResizeObserver(() => {
    fit();
    wake();
  });
  resized.observe(track);
  const seen = new IntersectionObserver((entries) => {
    inView = entries.some((entry) => entry.isIntersecting);
    if (inView) {
      wake();
    }
  });
  seen.observe(track);
  const recolour = () => {
    palette = paletteOf(canvas);
    wake();
  };
  const themeWatch = new MutationObserver(recolour);
  themeWatch.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class", "style"],
  });
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", recolour);
  document.addEventListener("visibilitychange", wake);
  fit();

  return {
    set: (next) => {
      if (next.fill !== state.fill) {
        pourFrom = shown;
        pourStart = performance.now();
      }
      state = next;
      wake();
    },
    stop: () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      seen.disconnect();
      themeWatch.disconnect();
      scheme.removeEventListener("change", recolour);
      document.removeEventListener("visibilitychange", wake);
    },
  };
};
