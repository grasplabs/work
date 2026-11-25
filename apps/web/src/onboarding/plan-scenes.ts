import type { PlanDay } from "./plan.ts";

// The pictures of the plan's story (plan-story.tsx), drawn as light on
// night: what the Appearance page's scenes are made from, a photograph's
// light, before the scene's shader (chat/backdrop/shader.ts) dithers it into
// the brand's greens. Each is composed over the window's upper part, so the
// words below it stand on its dark ground.
//
// A picture is alive: its lights (a window, a screen, a row of mail) come
// on one after another while its part of the story is told. So a picture
// is three layers in one image: red is the picture with every light off,
// green when each light comes on (0 for none, else 1 to 255 in its order),
// blue each light once on. plan-pictures.tsx turns them on as the words
// go, and blooms the light round each one that is on.
//
// road (you): a road to a rising sun, a lantern along it for each of the
//   fourteen days, coming on from today to the last;
// office (first): three people at their desks, seen from behind, their
//   screens coming on one by one as each starts talking to Stephen;
// city (everyone, close): the company as a city at night, its windows
//   coming on one by one as more people talk, until every one is lit;
// report (learned): the conversations lighting up as he reads them, then
//   the report, theme by theme, each bar filling;
// inbox (finding): morning through the window, someone at their desk, the
//   mail filling their screen row by row and still coming;
// gathering (rest): small lights rising out of the dark and gathering
//   into one.

/** The parts of the story, in its order. */
export type Scene =
  | "you"
  | "first"
  | "everyone"
  | "close"
  | "learned"
  | "finding"
  | "rest";

/** The pictures the story is told over. */
export type Picture =
  | "road"
  | "office"
  | "city"
  | "report"
  | "inbox"
  | "gathering";

/** What a part of the story is told over: its picture, and how far its lights come on, from and to. */
export interface Look {
  picture: Picture;
  from: number;
  to: number;
}

/** Each part's look: the city's two parts are one picture, its windows going on lighting through both. */
export const looks: Record<Scene, Look> = {
  you: { picture: "road", from: 0, to: 1 },
  first: { picture: "office", from: 0, to: 1 },
  everyone: { picture: "city", from: 0, to: 0.55 },
  close: { picture: "city", from: 0.55, to: 1 },
  learned: { picture: "report", from: 0, to: 1 },
  finding: { picture: "inbox", from: 0, to: 1 },
  rest: { picture: "gathering", from: 0, to: 1 },
};

/** A picture's size, in its own pixels: about a third of a wide window's, as a scene's cells are. */
export const pictureWidth = 960;
export const pictureHeight = 600;

const W = pictureWidth;
const H = pictureHeight;

type Ctx = CanvasRenderingContext2D;

/** The picture with every light off, when each comes on, and each once on. */
interface Layers {
  base: Ctx;
  order: Ctx;
  lit: Ctx;
}

const hash = (n: number): number => {
  const s = Math.sin(n * 127.1 + 311.7) * 43_758.5453;
  return s - Math.floor(s);
};

/** A grey of light `l`, 0 to 1, with alpha `a`. */
const grey = (l: number, a = 1): string => {
  const v = Math.round(Math.min(1, Math.max(0, l)) * 255);
  return `rgba(${v},${v},${v},${a})`;
};

/** When a light comes on, `at` 0 to 1 of the picture's lights, as its green: 1 to 255, 0 being none. */
const orderOf = (at: number): string => {
  const v = 1 + Math.round(Math.min(1, Math.max(0, at)) * 254);
  return `rgb(${v},${v},${v})`;
};

/** A light coming on at `at`, as bright as `level` once on: `paint` draws its shape in the fill it is given. */
const lamp = (
  layers: Layers,
  at: number,
  level: number,
  paint: (c: Ctx) => void
): void => {
  for (const [c, fill] of [
    [layers.order, orderOf(at)],
    [layers.lit, grey(level)],
  ] as const) {
    c.save();
    c.fillStyle = fill;
    c.strokeStyle = fill;
    paint(c);
    c.restore();
  }
};

/** Something in front of the lights: `paint`'s shape keeps no light, whatever comes on behind it. */
const before = (layers: Layers, paint: (c: Ctx) => void): void => {
  layers.order.save();
  layers.order.fillStyle = "rgb(0,0,0)";
  paint(layers.order);
  layers.order.restore();
};

/** A soft round light at (x, y), adding to what is there. */
const glow = (ctx: Ctx, x: number, y: number, r: number, l: number): void => {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, grey(l));
  g.addColorStop(0.35, grey(l * 0.45));
  g.addColorStop(1, grey(0));
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.restore();
};

/** The sky from `top` light at the top to `low` light at `horizon`. */
const sky = (ctx: Ctx, top: number, low: number, horizon: number): void => {
  const g = ctx.createLinearGradient(0, 0, 0, horizon);
  g.addColorStop(0, grey(top));
  g.addColorStop(1, grey(low));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, horizon);
};

/** Stars: small lights, more of them high up. */
const stars = (ctx: Ctx, count: number, below: number, seed: number): void => {
  for (let i = 0; i < count; i += 1) {
    const x = hash(seed + i * 3.1) * W;
    const y = hash(seed + i * 7.7) ** 1.6 * below;
    const l = 0.35 + hash(seed + i * 1.3) * 0.65;
    ctx.fillStyle = grey(l);
    const s = hash(seed + i * 5.9) > 0.9 ? 3 : 2;
    ctx.fillRect(x, y, s, s);
  }
};

/** The grain of a photograph over all of it, so its light is never flat. */
const grain = (ctx: Ctx, amount: number): void => {
  const image = ctx.getImageData(0, 0, W, H);
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    const n = (hash(i * 0.013) - 0.5) * amount * 255;
    data[i] = Math.min(255, Math.max(0, (data[i] ?? 0) + n));
  }
  ctx.putImageData(image, 0, 0);
};

/** A layer drawn soft, as a lens sees it: drawn on its own, then laid on blurred by `blur` pixels. */
const soft = (
  ctx: Ctx,
  blur: number,
  paint: (layer: Ctx) => void,
  adding = false
): void => {
  const layer = document.createElement("canvas");
  layer.width = W;
  layer.height = H;
  const c = layer.getContext("2d");
  if (c === null) {
    return;
  }
  paint(c);
  ctx.save();
  ctx.filter = `blur(${blur}px)`;
  if (adding) {
    ctx.globalCompositeOperation = "lighter";
  }
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
};

/** A pool of light coming on at `at`, round (x, y), `rx` wide and `ry` deep, fading out from `level`. */
const pool = (
  layers: Layers,
  at: number,
  spot: { x: number; y: number; rx: number; ry: number },
  level: number
): void => {
  const { x, y, rx, ry } = spot;
  for (const c of [layers.order, layers.lit]) {
    c.save();
    c.translate(x, y);
    c.scale(1, ry / rx);
    if (c === layers.order) {
      c.fillStyle = orderOf(at);
    } else {
      const light = c.createRadialGradient(0, 0, 0, 0, 0, rx);
      light.addColorStop(0, grey(level));
      light.addColorStop(1, grey(0));
      c.fillStyle = light;
      c.globalCompositeOperation = "lighter";
    }
    c.beginPath();
    c.arc(0, 0, rx, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }
};

/** The outline of someone seated, seen from behind: their head, their shoulders and back, down out of the picture. */
const seatedShape = (c: Ctx, x: number, headY: number, r: number): void => {
  c.beginPath();
  c.arc(x, headY, r, 0, Math.PI * 2);
  c.rect(x - r * 0.42, headY + r * 0.6, r * 0.84, r * 0.8);
  const neck = headY + r * 1.25;
  const wide = r * 2.6;
  c.moveTo(x - wide * 0.86, H);
  c.lineTo(x - wide, neck + r * 0.9);
  c.bezierCurveTo(x - wide, neck + r * 0.2, x - wide * 0.55, neck, x, neck);
  c.bezierCurveTo(
    x + wide * 0.55,
    neck,
    x + wide,
    neck + r * 0.2,
    x + wide,
    neck + r * 0.9
  );
  c.lineTo(x + wide * 0.86, H);
  c.closePath();
};

/** Someone seated, seen from behind, dark against what is behind them: no light comes on where they are. */
const seated = (layers: Layers, x: number, headY: number, r: number): void => {
  layers.base.fillStyle = grey(0.015);
  seatedShape(layers.base, x, headY, r);
  layers.base.fill();
  before(layers, (c) => {
    seatedShape(c, x, headY, r);
    c.fill();
  });
};

// road: the road ahead, to a sun coming up, a lantern along it for each of the fourteen days.
const drawRoad = (layers: Layers, days: readonly PlanDay[]): void => {
  const { base } = layers;
  const horizon = H * 0.5;
  sky(base, 0.04, 0.5, horizon);
  stars(base, 90, horizon * 0.6, 11);
  glow(base, W * 0.5, horizon, W * 0.42, 0.55);
  glow(base, W * 0.5, horizon, 70, 1);
  // Its rays, faint.
  soft(base, 6, (c) => {
    c.globalCompositeOperation = "lighter";
    for (let i = 0; i < 9; i += 1) {
      const a = Math.PI + (Math.PI * (i + 0.5)) / 9;
      c.fillStyle = grey(0.06);
      c.beginPath();
      c.moveTo(W * 0.5, horizon);
      c.lineTo(
        W * 0.5 + Math.cos(a - 0.03) * W,
        horizon + Math.sin(a - 0.03) * W
      );
      c.lineTo(
        W * 0.5 + Math.cos(a + 0.03) * W,
        horizon + Math.sin(a + 0.03) * W
      );
      c.closePath();
      c.fill();
    }
  });
  // Hills along the horizon, dark against the light.
  soft(base, 1.5, (c) => {
    c.fillStyle = grey(0.07);
    c.beginPath();
    c.moveTo(0, horizon + 4);
    for (let x = 0; x <= W; x += 16) {
      const rise =
        Math.sin(x * 0.006 + 1.2) * 18 +
        Math.sin(x * 0.017) * 7 +
        (Math.abs(x - W * 0.5) / W) * 50;
      c.lineTo(x, horizon - Math.max(0, rise));
    }
    c.lineTo(W, H);
    c.lineTo(0, H);
    c.closePath();
    c.fill();
  });
  // The land, dark, and the road across it catching the light.
  const land = base.createLinearGradient(0, horizon, 0, H);
  land.addColorStop(0, grey(0.12));
  land.addColorStop(1, grey(0.02));
  base.fillStyle = land;
  base.fillRect(0, horizon + 2, W, H - horizon);
  soft(base, 2, (c) => {
    const road = c.createLinearGradient(0, horizon, 0, H);
    road.addColorStop(0, grey(0.85));
    road.addColorStop(0.5, grey(0.32));
    road.addColorStop(1, grey(0.1));
    c.fillStyle = road;
    c.beginPath();
    c.moveTo(W * 0.495, horizon + 2);
    c.lineTo(W * 0.505, horizon + 2);
    c.lineTo(W * 0.78, H);
    c.lineTo(W * 0.22, H);
    c.closePath();
    c.fill();
  });
  // The fourteen posts, today nearest, each with its lantern: lit from today on, day by day, a
  // quiet day's dimmer.
  for (const [i, day] of days.entries()) {
    const far = i / days.length;
    const depth = 0.06 + 0.94 * (1 - far) ** 2.2;
    const y = horizon + 4 + (H - horizon) * depth;
    const side = i % 2 === 0 ? -1 : 1;
    const x = W * 0.5 + side * W * (0.04 + 0.33 * depth);
    const tall = (30 + 24 * depth) * (0.3 + depth * 1.5);
    const wide = Math.max(2, 6 * depth);
    base.fillStyle = grey(0.3);
    base.fillRect(x - wide / 2, y - tall, wide, tall);
    const head = Math.max(4, 24 * depth);
    const at = 0.04 + far * 0.92;
    const level = day.kind === "quiet" ? 0.6 : 1;
    pool(
      layers,
      at,
      { x, y, rx: 20 + 120 * depth, ry: 6 + 34 * depth },
      level * 0.5
    );
    base.fillStyle = grey(0.35);
    base.fillRect(x - head / 2, y - tall - head, head, head);
    lamp(layers, at, level, (c) => {
      c.fillRect(x - head / 2, y - tall - head, head, head);
    });
  }
};

// office: three people at their desks in the dark, seen from behind, the city in the windows
// beyond them; their screens come on one by one, each with Stephen's voice on it, and light them.
const drawOffice = (layers: Layers): void => {
  const { base, lit } = layers;
  base.fillStyle = grey(0.1);
  base.fillRect(0, 0, W, H);
  // The windows along the back wall, the city at night in them.
  const top = H * 0.04;
  const bottom = H * 0.36;
  soft(base, 1.2, (c) => {
    const night = c.createLinearGradient(0, top, 0, bottom);
    night.addColorStop(0, grey(0.2));
    night.addColorStop(1, grey(0.34));
    c.fillStyle = night;
    c.fillRect(W * 0.02, top, W * 0.96, bottom - top);
    for (let i = 0; i < 46; i += 1) {
      const x = W * 0.02 + hash(i * 3.3) * W * 0.96;
      const w = 14 + hash(i * 1.7) * 30;
      const t = bottom - (0.2 + hash(i * 5.1) * 0.6) * (bottom - top);
      c.fillStyle = grey(0.15);
      c.fillRect(x, t, w, bottom - t);
    }
    for (let i = 0; i < 170; i += 1) {
      const x = W * 0.02 + hash(i * 7.9 + 3) * W * 0.96;
      const y = bottom - hash(i * 2.9 + 1) ** 0.7 * (bottom - top) * 0.75;
      c.fillStyle = grey(0.42 + hash(i * 4.4) * 0.3);
      c.fillRect(x, y, 3, 3);
    }
    c.fillStyle = grey(0.07);
    for (let k = 0; k <= 6; k += 1) {
      c.fillRect(W * 0.02 + (k * W * 0.96) / 6 - 6, top, 12, bottom - top);
    }
    c.fillRect(W * 0.02, bottom - 4, W * 0.96, 8);
  });
  // The far row of desks, their screens dark.
  soft(base, 1, (c) => {
    for (let k = 0; k < 9; k += 1) {
      const x = W * (0.07 + k * 0.108);
      c.fillStyle = grey(0.05);
      c.fillRect(x - 26, H * 0.39, 52, 32);
      c.fillRect(x - 3, H * 0.39 + 32, 6, 10);
      c.fillStyle = grey(0.16);
      c.fillRect(x - 46, H * 0.39 + 42, 92, 5);
    }
  });
  // The near desks: one long top, catching what light there is, and on it three screens, each
  // coming on in its turn.
  const desk = H * 0.555;
  base.fillStyle = grey(0.2);
  base.fillRect(0, desk, W, H * 0.022);
  base.fillStyle = grey(0.08);
  base.fillRect(0, desk + H * 0.022, W, H);
  const seats = [
    { x: W * 0.18, size: 0.9, at: 0.08 },
    { x: W * 0.5, size: 1.08, at: 0.38 },
    { x: W * 0.82, size: 0.9, at: 0.68 },
  ];
  for (const seat of seats) {
    const w = 240 * seat.size;
    const h = 146 * seat.size;
    const left = seat.x - w / 2;
    const screenTop = H * 0.3 - h / 2;
    // Its light on the wall and the desk round it, once on.
    pool(
      layers,
      seat.at,
      { x: seat.x, y: desk, rx: w * 0.9, ry: w * 0.16 },
      0.4
    );
    base.fillStyle = grey(0.04);
    base.fillRect(left - 7, screenTop - 7, w + 14, h + 14);
    base.fillRect(seat.x - 6, screenTop + h + 7, 12, desk - screenTop - h - 7);
    base.fillStyle = grey(0.07);
    base.fillRect(left, screenTop, w, h);
    lamp(layers, seat.at, 0.82, (c) => {
      c.fillRect(left, screenTop, w, h);
    });
    // On it, once on: Stephen, and his voice as he talks with them.
    lit.fillStyle = grey(0.22);
    lit.beginPath();
    lit.arc(seat.x, screenTop + h * 0.27, h * 0.12, 0, Math.PI * 2);
    lit.fill();
    for (let bar = 0; bar < 13; bar += 1) {
      const tall = h * (0.08 + 0.26 * hash(bar * 3.1 + seat.x) ** 1.4);
      lit.fillRect(
        seat.x - w * 0.32 + bar * w * 0.052,
        screenTop + h * 0.6 - tall / 2,
        w * 0.03,
        tall
      );
    }
  }
  // The three, in front of their screens: dark, their own screen's light on their head and
  // shoulders, as far down as the desk.
  for (const seat of seats) {
    const r = 34 * seat.size;
    const headY = H * 0.42;
    const x = seat.x + (seat.x < W / 2 ? 16 : -16) * seat.size;
    lamp(layers, seat.at, 0.6, (c) => {
      c.beginPath();
      c.rect(0, 0, W, desk);
      c.clip();
      c.lineWidth = 5;
      seatedShape(c, x, headY, r);
      c.stroke();
    });
    seated(layers, x, headY, r);
  }
};

/** The city's buildings, the same every time it is drawn: their place, height and windows. */
const buildings = (() => {
  const all: { x: number; w: number; top: number }[] = [];
  let x = -20;
  let i = 0;
  while (x < W + 20) {
    const w = 56 + hash(i * 2.3) * 80;
    const near = 1 - Math.abs(x + w / 2 - W / 2) / (W / 2);
    const top =
      H * (0.54 - 0.14 * hash(i * 4.1) - 0.3 * near * hash(i * 9.7 + 1));
    all.push({ x, w, top });
    x += w + 2 + hash(i * 6.1) * 6;
    i += 1;
  }
  return all;
})();

/** The picture above `ground` laid upside down below it, as still water shows it: `alpha` faint. */
const mirror = (
  ctx: Ctx,
  ground: number,
  alpha: number,
  blur: number
): void => {
  ctx.save();
  ctx.globalAlpha = alpha;
  // Sharp, the order of the lights is kept as it is, never blended with its neighbours'.
  ctx.imageSmoothingEnabled = blur > 0;
  if (blur > 0) {
    ctx.filter = `blur(${blur}px)`;
  }
  ctx.translate(0, ground * 2);
  ctx.scale(1, -0.9);
  ctx.drawImage(ctx.canvas, 0, 0, W, ground, 0, ground * 0.11, W, ground);
  ctx.restore();
};

// city: the company as a city at night, a window for each person, coming on one by one as each
// talks with Stephen, their lights running down the water below.
const drawCity = (layers: Layers): void => {
  const { base } = layers;
  const ground = H * 0.62;
  sky(base, 0.03, 0.2, ground);
  stars(base, 70, ground * 0.5, 23);
  glow(base, W * 0.82, H * 0.13, 120, 0.3);
  glow(base, W * 0.82, H * 0.13, 22, 1);
  glow(base, W * 0.5, ground, W * 0.5, 0.12);
  soft(base, 0.8, (c) => {
    for (const [i, b] of buildings.entries()) {
      c.fillStyle = grey(0.06 + hash(i * 3.3) * 0.05);
      c.fillRect(b.x, b.top, b.w, ground - b.top);
    }
  });
  for (const [i, b] of buildings.entries()) {
    const across = Math.floor((b.w - 12) / 21);
    const margin = (b.w - across * 21 + 9) / 2;
    for (let row = 0, y = b.top + 14; y < ground - 20; row += 1, y += 24) {
      for (let k = 0; k < across; k += 1) {
        const x = Math.round(b.x + margin + k * 21);
        const pick = hash(i * 13.37 + row * 7.31 + k * 3.17);
        base.fillStyle = grey(0.1);
        base.fillRect(x, Math.round(y), 12, 14);
        lamp(layers, 0.02 + pick * 0.96, 0.78 + hash(pick * 91) * 0.22, (c) => {
          c.fillRect(x, Math.round(y), 12, 14);
        });
      }
    }
  }
  base.fillStyle = grey(0.03);
  base.fillRect(0, ground, W, H - ground);
  mirror(base, ground, 0.45, 3);
  mirror(layers.order, ground, 1, 0);
  mirror(layers.lit, ground, 0.4, 3);
};

/** A speech bubble, its tail down at one side. */
const bubble = (
  c: Ctx,
  x: number,
  y: number,
  w: number,
  left: boolean
): void => {
  const h = w * 0.56;
  c.beginPath();
  c.roundRect(x, y, w, h, h * 0.3);
  c.fill();
  const tail = left ? x + w * 0.22 : x + w * 0.78;
  c.beginPath();
  c.moveTo(tail - w * 0.08, y + h - 2);
  c.lineTo(tail + (left ? -w * 0.12 : w * 0.12), y + h + w * 0.16);
  c.lineTo(tail + w * 0.08, y + h - 2);
  c.closePath();
  c.fill();
};

// report: every conversation, lighting up as he reads it, round the report it becomes, which
// comes in theme by theme: a heading, a line or two, and a bar for how many it touches.
const drawReport = (layers: Layers): void => {
  const { base, lit } = layers;
  base.fillStyle = grey(0.03);
  base.fillRect(0, 0, W, H);
  glow(base, W * 0.5, H * 0.34, W * 0.42, 0.2);
  stars(base, 60, H * 0.6, 57);
  // The conversations, either side, nearer the report the later they are read.
  const talks = 24;
  for (let i = 0; i < talks; i += 1) {
    const left = i % 2 === 0;
    const t = hash(i * 4.7 + 2);
    const w = 34 + t * 34;
    const x = left ? W * (0.03 + t * 0.2) : W * (0.97 - t * 0.2) - w;
    const y = H * (0.06 + hash(i * 8.3) * 0.44);
    base.fillStyle = grey(0.1);
    bubble(base, x, y, w, left);
    lamp(layers, 0.02 + (i / talks) * 0.3, 0.55, (c) => {
      bubble(c, x, y, w, left);
    });
    lit.fillStyle = grey(0.25);
    lit.fillRect(x + w * 0.18, y + w * 0.17, w * 0.64, Math.max(2, w * 0.06));
    lit.fillRect(x + w * 0.18, y + w * 0.3, w * 0.4, Math.max(2, w * 0.06));
  }
  // The report.
  const x0 = W * 0.32;
  const x1 = W * 0.68;
  const y0 = H * 0.06;
  const y1 = H * 0.63;
  soft(base, 1, (c) => {
    c.fillStyle = grey(0.1);
    c.beginPath();
    c.roundRect(x0, y0, x1 - x0, y1 - y0, 12);
    c.fill();
    c.strokeStyle = grey(0.26);
    c.lineWidth = 3;
    c.stroke();
    c.fillStyle = grey(0.5);
    c.fillRect(x0 + 26, y0 + 24, 150, 13);
    c.fillStyle = grey(0.24);
    c.fillRect(x0 + 26, y0 + 46, 90, 6);
  });
  const shares = [0.86, 0.66, 0.48, 0.32];
  const inner = x1 - x0 - 52;
  const step = (y1 - y0 - 76) / shares.length;
  for (const [i, share] of shares.entries()) {
    const y = y0 + 72 + i * step;
    const at = 0.36 + i * 0.16;
    lamp(layers, at, 0.95, (c) => {
      c.fillRect(x0 + 26, y, 120 + hash(i * 5.5) * 70, 11);
    });
    lamp(layers, at + 0.02, 0.5, (c) => {
      c.fillRect(x0 + 26, y + 20, inner * 0.86, 5);
      c.fillRect(x0 + 26, y + 30, inner * 0.6, 5);
    });
    base.fillStyle = grey(0.15);
    base.fillRect(x0 + 26, y + 44, inner, 9);
    const pieces = 12;
    for (let k = 0; k < pieces; k += 1) {
      const from = x0 + 26 + (k / pieces) * inner * share;
      lamp(layers, at + 0.03 + (k / pieces) * 0.1, 0.88, (c) => {
        c.fillRect(from, y + 44, (inner * share) / pieces + 1, 9);
      });
    }
  }
};

// inbox: the first hours of a day, lost to email: morning coming up in the window, and someone at
// their desk in front of it, the mail filling their screen row by row and still coming in.
const drawInbox = (layers: Layers): void => {
  const { base, lit } = layers;
  base.fillStyle = grey(0.03);
  base.fillRect(0, 0, W, H);
  const desk = H * 0.6;
  // The window, the sun just up in it.
  const pane = { x: W * 0.04, y: H * 0.07, w: W * 0.24, h: H * 0.44 };
  soft(base, 2, (c) => {
    c.save();
    c.beginPath();
    c.rect(pane.x, pane.y, pane.w, pane.h);
    c.clip();
    const morning = c.createLinearGradient(0, pane.y, 0, pane.y + pane.h);
    morning.addColorStop(0, grey(0.14));
    morning.addColorStop(1, grey(0.5));
    c.fillStyle = morning;
    c.fillRect(pane.x, pane.y, pane.w, pane.h);
    const sx = pane.x + pane.w * 0.58;
    const sy = pane.y + pane.h * 0.86;
    const sun = c.createRadialGradient(sx, sy, 0, sx, sy, pane.w * 0.7);
    sun.addColorStop(0, grey(1));
    sun.addColorStop(0.12, grey(0.95));
    sun.addColorStop(0.3, grey(0.45));
    sun.addColorStop(1, grey(0, 0));
    c.fillStyle = sun;
    c.fillRect(pane.x, pane.y, pane.w, pane.h);
    c.restore();
    c.fillStyle = grey(0.04);
    c.fillRect(pane.x + pane.w / 2 - 5, pane.y, 10, pane.h);
    c.fillRect(pane.x, pane.y + pane.h * 0.42, pane.w, 10);
  });
  glow(base, pane.x + pane.w * 0.55, pane.y + pane.h * 0.8, W * 0.3, 0.16);
  // The desk, and on it a cup going cold.
  base.fillStyle = grey(0.09);
  base.fillRect(0, desk, W, H * 0.025);
  base.fillStyle = grey(0.04);
  base.fillRect(0, desk + H * 0.025, W, H);
  soft(base, 1, (c) => {
    c.fillStyle = grey(0.16);
    c.beginPath();
    c.roundRect(W * 0.86, desk - 52, 40, 52, 5);
    c.fill();
    c.strokeStyle = grey(0.16);
    c.lineWidth = 6;
    c.beginPath();
    c.arc(W * 0.86 + 44, desk - 30, 11, -Math.PI / 2, Math.PI / 2);
    c.stroke();
  });
  // The screen: on, dark, its inbox filling row by row, the newest still coming.
  const left = W * 0.38;
  const right = W * 0.8;
  const top = H * 0.17;
  const bottom = H * 0.53;
  glow(base, (left + right) / 2, (top + bottom) / 2, W * 0.3, 0.18);
  base.fillStyle = grey(0.12);
  base.fillRect(left - 9, top - 9, right - left + 18, bottom - top + 18);
  base.fillStyle = grey(0.26);
  base.fillRect(left, top, right - left, bottom - top);
  base.fillStyle = grey(0.38);
  base.fillRect(left, top, right - left, 20);
  base.fillStyle = grey(0.12);
  base.fillRect((left + right) / 2 - 8, bottom + 9, 16, desk - bottom - 9);
  const rows = 9;
  const rowHeight = (bottom - top - 26) / rows;
  for (let row = 0; row < rows; row += 1) {
    const y = top + 24 + row * rowHeight;
    const at = 0.04 + (row / rows) * 0.7;
    lamp(layers, at, 0.52, (c) => {
      c.fillRect(left + 4, y, right - left - 8, rowHeight - 3);
    });
    lit.fillStyle = grey(1);
    lit.beginPath();
    lit.arc(left + 18, y + rowHeight / 2, 4.5, 0, Math.PI * 2);
    lit.fill();
    lit.fillStyle = grey(0.95);
    lit.fillRect(left + 32, y + rowHeight * 0.24, 60 + hash(row) * 46, 6);
    lit.fillStyle = grey(0.32);
    lit.fillRect(
      left + 32,
      y + rowHeight * 0.58,
      (right - left) * (0.42 + hash(row * 2.1) * 0.36),
      4
    );
  }
  // The mail still coming: envelopes rising out of the screen, one after another.
  for (let i = 0; i < 7; i += 1) {
    const t = (i + 0.5) / 7;
    const x = right - 150 + t * 250 + (hash(i * 3.7) - 0.5) * 30;
    const y = top - 24 - t * H * 0.08 + (hash(i * 5.3) - 0.5) * 18;
    const w = 50 * (1 - t * 0.45);
    const h = w * 0.64;
    const tilt = (hash(i * 9.1) - 0.5) * 0.6;
    const envelope = (c: Ctx): void => {
      c.save();
      c.translate(x, y);
      c.rotate(tilt);
      c.fillRect(-w / 2, -h / 2, w, h);
      c.restore();
    };
    lamp(layers, 0.3 + t * 0.66, 0.95 - t * 0.35, envelope);
    lit.save();
    lit.translate(x, y);
    lit.rotate(tilt);
    lit.strokeStyle = grey(0.3);
    lit.lineWidth = Math.max(2, w * 0.05);
    lit.beginPath();
    lit.moveTo(-w / 2, -h / 2);
    lit.lineTo(0, h * 0.08);
    lit.lineTo(w / 2, -h / 2);
    lit.stroke();
    lit.restore();
  }
  // Them, at the desk in front of it.
  const headY = H * 0.45;
  const r = 44;
  const x = W * 0.56;
  lamp(layers, 0.04, 0.5, (c) => {
    c.beginPath();
    c.rect(0, 0, W, desk);
    c.clip();
    c.lineWidth = 5;
    seatedShape(c, x, headY, r);
    c.stroke();
  });
  seated(layers, x, headY, r);
};

// gathering: small things, many small lights, rising out of the dark one after another and
// gathering into one bright one, last.
const drawGathering = (layers: Layers): void => {
  const { base } = layers;
  const ground = H * 0.7;
  sky(base, 0.02, 0.12, ground);
  const centre = { x: W * 0.5, y: H * 0.3 };
  for (let i = 0; i < 520; i += 1) {
    const toward = hash(i * 1.7) ** 0.6;
    const fromX = hash(i * 3.3) * W;
    const fromY = ground - hash(i * 4.9) * 40;
    const x =
      fromX +
      (centre.x - fromX) * toward +
      (hash(i * 8.1) - 0.5) * 30 * (1 - toward);
    const y =
      fromY +
      (centre.y - fromY) * toward +
      (hash(i * 2.9) - 0.5) * 30 * (1 - toward);
    const s = 2 + Math.round(hash(i * 6.6) * 2);
    lamp(layers, 0.02 + toward * 0.72, 0.3 + toward * 0.7, (c) => {
      c.fillRect(x, y, s, s);
    });
  }
  lamp(layers, 0.86, 1, (c) => {
    c.beginPath();
    c.arc(centre.x, centre.y, 26, 0, Math.PI * 2);
    c.fill();
  });
  glow(base, centre.x, centre.y, W * 0.3, 0.16);
  soft(base, 1.5, (c) => {
    c.fillStyle = grey(0.04);
    c.beginPath();
    c.moveTo(0, ground);
    for (let x = 0; x <= W; x += 12) {
      c.lineTo(
        x,
        ground - 10 - Math.sin(x * 0.008 + 2) * 16 - Math.sin(x * 0.027) * 5
      );
    }
    c.lineTo(W, H);
    c.lineTo(0, H);
    c.closePath();
    c.fill();
  });
};

/** A canvas of the picture's size, filled with night, and its pen. */
const blank = (): Ctx | null => {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx !== null) {
    ctx.fillStyle = "rgb(0,0,0)";
    ctx.fillRect(0, 0, W, H);
  }
  return ctx;
};

/** `picture`, drawn: its light with every light off in red, when each comes on in green, each once on in blue. */
export const drawPicture = (
  picture: Picture,
  days: readonly PlanDay[]
): HTMLCanvasElement => {
  const base = blank();
  const order = blank();
  const lit = blank();
  if (base === null || order === null || lit === null) {
    return document.createElement("canvas");
  }
  const layers = { base, order, lit };
  const draw: Record<Picture, () => void> = {
    road: () => {
      drawRoad(layers, days);
    },
    office: () => {
      drawOffice(layers);
    },
    city: () => {
      drawCity(layers);
    },
    report: () => {
      drawReport(layers);
    },
    inbox: () => {
      drawInbox(layers);
    },
    gathering: () => {
      drawGathering(layers);
    },
  };
  draw[picture]();
  grain(base, 0.06);
  const image = base.getImageData(0, 0, W, H);
  const when = order.getImageData(0, 0, W, H).data;
  const on = lit.getImageData(0, 0, W, H).data;
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    data[i + 1] = when[i] ?? 0;
    data[i + 2] = on[i] ?? 0;
    data[i + 3] = 255;
  }
  base.putImageData(image, 0, 0);
  return base.canvas;
};
