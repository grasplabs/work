import type { PlanDay } from "./plan.ts";

// The pictures of the plan's story (plan-story.tsx), one for each part of
// it, drawn as light on night: what the Appearance page's scenes are made
// from, a photograph's light, before the scene's shader (chat/backdrop/
// shader.ts) dithers it into the brand's greens. Each is a picture of its
// own, soft as a photograph, composed over the window's upper part so the
// words below it stand on its dark ground:
//
// you: a road to a rising sun, fourteen posts along it, one for each day;
// first: three people against a bright window, the ones who know the work;
// everyone: a city at night, a light on in some of its windows;
// close: the same city with every window lit, the whole company heard;
// learned: four beams of light rising from the dark, team by team;
// finding: morning in the window, an inbox on the laptop, mail rising out of it;
// rest: a sky of small lights, gathering into one.

/** The pictures of the story, in its order. */
export type Scene =
  | "you"
  | "first"
  | "everyone"
  | "close"
  | "learned"
  | "finding"
  | "rest";

/** A picture's size, in its own pixels: about a third of a wide window's, as a scene's cells are. */
export const pictureWidth = 960;
export const pictureHeight = 600;

const W = pictureWidth;
const H = pictureHeight;

type Ctx = CanvasRenderingContext2D;

const hash = (n: number): number => {
  const s = Math.sin(n * 127.1 + 311.7) * 43_758.5453;
  return s - Math.floor(s);
};

/** A grey of light `l`, 0 to 1, with alpha `a`. */
const grey = (l: number, a = 1): string => {
  const v = Math.round(Math.min(1, Math.max(0, l)) * 255);
  return `rgba(${v},${v},${v},${a})`;
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
    const v = Math.min(255, Math.max(0, (data[i] ?? 0) + n));
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
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

// you: the road ahead, to a sun coming up, a post along it for each of the fourteen days.
const drawYou = (ctx: Ctx, days: readonly PlanDay[]): void => {
  const horizon = H * 0.5;
  sky(ctx, 0.04, 0.5, horizon);
  stars(ctx, 90, horizon * 0.6, 11);
  glow(ctx, W * 0.5, horizon, W * 0.42, 0.55);
  glow(ctx, W * 0.5, horizon, 70, 1);
  // Its rays, faint.
  soft(ctx, 6, (c) => {
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
  soft(ctx, 1.5, (c) => {
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
  const land = ctx.createLinearGradient(0, horizon, 0, H);
  land.addColorStop(0, grey(0.12));
  land.addColorStop(1, grey(0.02));
  ctx.fillStyle = land;
  ctx.fillRect(0, horizon + 2, W, H - horizon);
  soft(ctx, 2, (c) => {
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
  // The fourteen posts, near to far, taller on a day with more talks.
  const most = Math.max(1, ...days.map((day) => day.count));
  soft(ctx, 0.8, (c) => {
    for (const [i, day] of days.entries()) {
      const far = 1 - i / days.length;
      const depth = 0.06 + 0.94 * far ** 2.2;
      const y = horizon + 4 + (H - horizon) * depth;
      const side = i % 2 === 0 ? -1 : 1;
      const x = W * 0.5 + side * W * (0.04 + 0.33 * depth);
      const tall =
        (10 + (day.count / most) * 26 + (day.kind === "quiet" ? 0 : 8)) *
        (0.25 + depth * 1.6);
      const wide = Math.max(2, 7 * depth);
      c.fillStyle = grey(day.kind === "quiet" ? 0.3 : 0.75);
      c.fillRect(x - wide / 2, y - tall, wide, tall);
    }
  });
};

/** A person, from the waist up, seen against the light: their head, their shoulders. */
const person = (c: Ctx, x: number, foot: number, size: number): void => {
  const head = size * 0.24;
  const shoulders = size * 0.5;
  const neck = foot - size;
  c.beginPath();
  c.arc(x, neck - head * 0.9, head, 0, Math.PI * 2);
  c.fill();
  c.beginPath();
  c.moveTo(x - shoulders, foot);
  c.bezierCurveTo(
    x - shoulders,
    neck + size * 0.12,
    x - shoulders * 0.7,
    neck,
    x,
    neck
  );
  c.bezierCurveTo(
    x + shoulders * 0.7,
    neck,
    x + shoulders,
    neck + size * 0.12,
    x + shoulders,
    foot
  );
  c.closePath();
  c.fill();
};

// first: the few who know the work best, three of them against a bright window, a table's edge.
const drawFirst = (ctx: Ctx): void => {
  ctx.fillStyle = grey(0.05);
  ctx.fillRect(0, 0, W, H);
  // The window: tall, bright, its frame dark.
  soft(ctx, 10, (c) => {
    c.fillStyle = grey(0.9);
    c.fillRect(W * 0.26, H * 0.06, W * 0.48, H * 0.6);
  });
  glow(ctx, W * 0.5, H * 0.36, W * 0.45, 0.4);
  soft(ctx, 1.5, (c) => {
    c.fillStyle = grey(0.06);
    c.fillRect(W * 0.497, H * 0.04, 8, H * 0.64);
    c.fillRect(W * 0.24, H * 0.35, W * 0.52, 7);
  });
  // The three, each lit at their edge, the one in the middle nearest.
  const three = [
    { x: W * 0.36, size: 150 },
    { x: W * 0.64, size: 155 },
    { x: W * 0.5, size: 185 },
  ];
  const foot = H * 0.66;
  soft(ctx, 5, (c) => {
    c.fillStyle = grey(1);
    for (const one of three) {
      person(c, one.x, foot + 6, one.size + 8);
    }
  });
  soft(ctx, 1.2, (c) => {
    c.fillStyle = grey(0.02);
    for (const one of three) {
      person(c, one.x, foot, one.size);
    }
  });
  // The table they stand at, its edge catching the window.
  soft(ctx, 2, (c) => {
    const top = c.createLinearGradient(0, foot, 0, H);
    top.addColorStop(0, grey(0.5));
    top.addColorStop(0.08, grey(0.16));
    top.addColorStop(1, grey(0.03));
    c.fillStyle = top;
    c.fillRect(0, foot, W, H - foot);
  });
};

/** The city's buildings, the same every time it is drawn: their place, height and windows. */
const buildings = (() => {
  const all: { x: number; w: number; top: number }[] = [];
  let x = -20;
  let i = 0;
  while (x < W + 20) {
    const w = 46 + hash(i * 2.3) * 70;
    const near = 1 - Math.abs(x + w / 2 - W / 2) / (W / 2);
    const top =
      H * (0.62 - 0.1 * hash(i * 4.1) - 0.32 * near * hash(i * 9.7 + 1));
    all.push({ x, w, top });
    x += w + 2 + hash(i * 6.1) * 6;
    i += 1;
  }
  return all;
})();

// everyone and close: the company as a city at night, a light in a window for each person; in close
// every one of them lit, and the sky behind beginning to pale.
const drawCity = (ctx: Ctx, lit: number): void => {
  const ground = H * 0.62;
  sky(ctx, 0.03, 0.14 + lit * 0.2, ground);
  stars(ctx, 70, ground * 0.5, 23);
  glow(ctx, W * 0.82, H * 0.13, 120, 0.3);
  glow(ctx, W * 0.82, H * 0.13, 22, 1);
  glow(ctx, W * 0.5, ground, W * 0.5, 0.08 + lit * 0.18);
  soft(ctx, 0.8, (c) => {
    for (const [i, b] of buildings.entries()) {
      c.fillStyle = grey(0.06 + hash(i * 3.3) * 0.05);
      c.fillRect(b.x, b.top, b.w, ground - b.top);
    }
  });
  // Their windows, a light on in some: whole cells, sharp, each with a little glow round it.
  for (const [i, b] of buildings.entries()) {
    const across = Math.floor((b.w - 10) / 18);
    for (let row = 0, y = b.top + 12; y < ground - 16; row += 1, y += 20) {
      for (let k = 0; k < across; k += 1) {
        const pick = hash(i * 13.37 + row * 7.31 + k * 3.17);
        if (pick < lit) {
          const x = b.x + 8 + k * 18;
          ctx.fillStyle = grey(0.75 + hash(pick * 91) * 0.25);
          ctx.fillRect(x, y, 9, 11);
          glow(ctx, x + 4.5, y + 5.5, 16, 0.12);
        }
      }
    }
  }
  // Their glow in the air.
  soft(
    ctx,
    14,
    (c) => {
      c.globalCompositeOperation = "lighter";
      for (const b of buildings) {
        c.fillStyle = grey(0.06 * lit);
        c.fillRect(b.x, b.top, b.w, ground - b.top);
      }
    },
    true
  );
  // The water below, the city's lights running down it.
  ctx.fillStyle = grey(0.03);
  ctx.fillRect(0, ground, W, H - ground);
  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.filter = "blur(3px)";
  ctx.translate(0, ground * 2);
  ctx.scale(1, -0.9);
  ctx.drawImage(ctx.canvas, 0, 0, W, ground, 0, ground * 0.11, W, ground);
  ctx.restore();
};

// learned: four beams of light rising from the dark land, one for each team, as the findings come.
const drawLearned = (ctx: Ctx): void => {
  const ground = H * 0.66;
  sky(ctx, 0.02, 0.1, ground);
  stars(ctx, 120, ground * 0.9, 41);
  const beams = [
    { x: 0.2, lean: -0.05, width: 30, l: 0.55 },
    { x: 0.4, lean: -0.015, width: 40, l: 0.8 },
    { x: 0.6, lean: 0.02, width: 36, l: 0.7 },
    { x: 0.8, lean: 0.05, width: 28, l: 0.5 },
  ];
  soft(ctx, 9, (c) => {
    c.globalCompositeOperation = "lighter";
    for (const beam of beams) {
      const x = W * beam.x;
      const g = c.createLinearGradient(0, ground, 0, 0);
      g.addColorStop(0, grey(beam.l));
      g.addColorStop(1, grey(beam.l * 0.15));
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(x - beam.width * 0.3, ground);
      c.lineTo(x + beam.width * 0.3, ground);
      c.lineTo(x + beam.lean * W + beam.width * 1.6, 0);
      c.lineTo(x + beam.lean * W - beam.width * 1.6, 0);
      c.closePath();
      c.fill();
    }
  });
  for (const beam of beams) {
    glow(ctx, W * beam.x, ground, 90, beam.l * 0.9);
  }
  soft(ctx, 1.5, (c) => {
    c.fillStyle = grey(0.04);
    c.beginPath();
    c.moveTo(0, ground);
    for (let x = 0; x <= W; x += 12) {
      c.lineTo(
        x,
        ground - 6 - Math.sin(x * 0.01) * 6 - Math.sin(x * 0.031) * 3
      );
    }
    c.lineTo(W, H);
    c.lineTo(0, H);
    c.closePath();
    c.fill();
  });
};

// finding: the first hours of a day, lost to email: morning coming up in the window behind, and on
// the desk in front of it a laptop, its screen one long inbox, the mail still coming out of it.
const drawFinding = (ctx: Ctx): void => {
  ctx.fillStyle = grey(0.03);
  ctx.fillRect(0, 0, W, H);
  const desk = H * 0.64;
  // The window behind, the sun just up in it.
  const pane = { x: W * 0.06, y: H * 0.07, w: W * 0.25, h: H * 0.46 };
  soft(ctx, 2, (c) => {
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
    // Its frame, across it.
    c.fillStyle = grey(0.04);
    c.fillRect(pane.x + pane.w / 2 - 5, pane.y, 10, pane.h);
    c.fillRect(pane.x, pane.y + pane.h * 0.42, pane.w, 10);
  });
  // The morning's light on the wall around it.
  glow(ctx, pane.x + pane.w * 0.55, pane.y + pane.h * 0.8, W * 0.3, 0.16);
  const left = W * 0.4;
  const right = W * 0.8;
  const top = H * 0.17;
  const bottom = desk - 8;
  // The screen's light, on the wall and the desk.
  glow(ctx, (left + right) / 2, (top + bottom) / 2, W * 0.34, 0.3);
  soft(ctx, 1, (c) => {
    // The lid and its bezel.
    c.fillStyle = grey(0.12);
    c.beginPath();
    c.roundRect(left - 10, top - 10, right - left + 20, bottom - top + 14, 10);
    c.fill();
    c.fillStyle = grey(0.9);
    c.fillRect(left, top, right - left, bottom - top - 4);
    // The inbox: a bar along its top, then mail, row under row, most of it not read yet.
    c.fillStyle = grey(0.55);
    c.fillRect(left, top, right - left, 22);
    const rows = 8;
    const rowHeight = (bottom - top - 30) / rows;
    for (let row = 0; row < rows; row += 1) {
      const y = top + 26 + row * rowHeight;
      const unread = hash(row * 4.3 + 1) > 0.25;
      if (unread) {
        c.fillStyle = grey(0.15);
        c.beginPath();
        c.arc(left + 16, y + rowHeight / 2, 5, 0, Math.PI * 2);
        c.fill();
      }
      c.fillStyle = grey(unread ? 0.2 : 0.5);
      c.fillRect(left + 30, y + rowHeight * 0.28, 70 + hash(row) * 40, 7);
      c.fillStyle = grey(unread ? 0.38 : 0.62);
      c.fillRect(
        left + 30,
        y + rowHeight * 0.58,
        (right - left) * (0.45 + hash(row * 2.1) * 0.35),
        5
      );
      c.fillStyle = grey(0.75);
      c.fillRect(left + 8, y + rowHeight - 1, right - left - 16, 2);
    }
  });
  // The mail still coming: envelopes rising out of the screen, smaller and fainter as they go.
  soft(ctx, 1.2, (c) => {
    for (let i = 0; i < 7; i += 1) {
      const t = (i + 0.5) / 7;
      const x = right - 150 + t * 250 + (hash(i * 3.7) - 0.5) * 30;
      const y = top - 30 - t * H * 0.09 + (hash(i * 5.3) - 0.5) * 26;
      const w = 58 * (1 - t * 0.45);
      const h = w * 0.64;
      const l = 0.95 - t * 0.5;
      c.save();
      c.translate(x, y);
      c.rotate((hash(i * 9.1) - 0.5) * 0.6);
      c.fillStyle = grey(l);
      c.fillRect(-w / 2, -h / 2, w, h);
      c.strokeStyle = grey(l * 0.3);
      c.lineWidth = Math.max(2, w * 0.05);
      c.beginPath();
      c.moveTo(-w / 2, -h / 2);
      c.lineTo(0, h * 0.08);
      c.lineTo(w / 2, -h / 2);
      c.stroke();
      c.restore();
    }
  });
  // The desk, lit near the screen and the window.
  soft(ctx, 3, (c) => {
    const g = c.createLinearGradient(0, desk, 0, H);
    g.addColorStop(0, grey(0.3));
    g.addColorStop(0.3, grey(0.09));
    g.addColorStop(1, grey(0.02));
    c.fillStyle = g;
    c.fillRect(0, desk, W, H - desk);
  });
  // The base and its keys, in perspective towards us.
  soft(ctx, 1, (c) => {
    c.fillStyle = grey(0.2);
    c.beginPath();
    c.moveTo(left - 10, bottom + 4);
    c.lineTo(right + 10, bottom + 4);
    c.lineTo(right + 70, desk + 60);
    c.lineTo(left - 70, desk + 60);
    c.closePath();
    c.fill();
    const middle = (left + right) / 2;
    for (let row = 0; row < 4; row += 1) {
      const t = (row + 0.6) / 5;
      const y = bottom + 8 + t * (desk + 44 - bottom);
      const half = (right - left) / 2 + 10 + 60 * t - 30;
      for (let k = 0; k < 12; k += 1) {
        c.fillStyle = grey(0.36);
        const x = middle - half + ((k + 0.15) / 12) * half * 2;
        c.fillRect(x, y, (half * 2) / 12 - 4, 4 + t * 4);
      }
    }
  });
  glow(ctx, (left + right) / 2, desk + 10, W * 0.3, 0.12);
};

// rest: small things, many small lights, rising from the dark and gathering into one bright one.
const drawRest = (ctx: Ctx): void => {
  const ground = H * 0.7;
  sky(ctx, 0.02, 0.12, ground);
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
    const l = 0.3 + toward * 0.7;
    ctx.fillStyle = grey(l);
    const s = 2 + Math.round(hash(i * 6.6) * 2);
    ctx.fillRect(x, y, s, s);
  }
  glow(ctx, centre.x, centre.y, W * 0.3, 0.5);
  glow(ctx, centre.x, centre.y, 60, 1);
  soft(ctx, 1.5, (c) => {
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

/** The picture of `scene`, drawn as light on night on a canvas of its own. */
export const drawScene = (
  scene: Scene,
  days: readonly PlanDay[]
): HTMLCanvasElement => {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx === null) {
    return canvas;
  }
  ctx.fillStyle = grey(0);
  ctx.fillRect(0, 0, W, H);
  const draw: Record<Scene, () => void> = {
    you: () => {
      drawYou(ctx, days);
    },
    first: () => {
      drawFirst(ctx);
    },
    everyone: () => {
      drawCity(ctx, 0.3);
    },
    close: () => {
      drawCity(ctx, 0.96);
    },
    learned: () => {
      drawLearned(ctx);
    },
    finding: () => {
      drawFinding(ctx);
    },
    rest: () => {
      drawRest(ctx);
    },
  };
  draw[scene]();
  grain(ctx, 0.06);
  return canvas;
};
