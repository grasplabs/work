import { wait } from "../../core.ts";
import { readTones } from "../campaign/pixels.ts";
import type { Flag } from "../flags.ts";
import { FRAGMENT, VERTEX } from "./shader.ts";

// What drives Stephen's field (shader.ts): the two canvases' sizes, the
// page's colours, the pointer, what he attends to, where he rests on this
// screen, and the carry from one screen to the next. One loop, a frame at a
// time; under reduced motion it draws him once, still, and a carry is only
// the page turning.

/** A cell's side in CSS pixels: Damsko's own pixel, half a flag's, so he is a fine grain beside them. */
const CELL = 2;

/** Where he rests on a screen and how he moves there, so each screen has its own. */
export interface Pose {
  /** The middle of his light, as parts of the window: 0 to 1 across and down. */
  at: readonly [number, number];
  /** How far it reaches, as parts of the window's width and height. */
  reach: readonly [number, number];
  /** Which silk: any number, another look. */
  seed: number;
  /** How fast he moves: 1 is calm. */
  tempo: number;
  /** How much of him shows at rest: 0 to 1. */
  strength: number;
}

/** A picture he takes from what was pressed and shows first: a flag. */
export type Picture = Flag | null;

type Rgb = readonly [number, number, number];
type Box = [number, number, number, number];

/** The picture's front runs this long; his own starts a moment after it and runs a little longer. */
const SPREAD_MS = 520;
const CHASE_MS = 150;
const CHASE_SPREAD_MS = 600;
const DRAIN_MS = 760;
/** How far a front wanders and how wide its dithered edge is, in CSS pixels: what it must clear. */
const FRONT_SLACK = 260;
/** He stays with the new title this long after the carry. */
const LINGER_MS = 1100;

const UNIFORMS = [
  "u_cells",
  "u_cell",
  "u_time",
  "u_layer",
  "u_amb[0]",
  "u_palette[0]",
  "u_tones",
  "u_rest",
  "u_mood",
  "u_pointer",
  "u_attend",
  "u_attendOn",
  "u_attendKind",
  "u_attendRadius",
  "u_phase",
  "u_from",
  "u_toward",
  "u_fronts",
  "u_flag[0]",
  "u_flagShape",
  "u_flagOn",
] as const;
type Uniform = (typeof UNIFORMS)[number];

interface Layer {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  at: Map<Uniform, WebGLUniformLocation | null>;
}

const compile = (
  gl: WebGLRenderingContext,
  type: number,
  source: string
): WebGLShader | null => {
  const shader = gl.createShader(type);
  if (shader === null) {
    return null;
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) === true
    ? shader
    : null;
};

/** A canvas ready to draw the field, or none where WebGL can't run. */
const layerOf = (canvas: HTMLCanvasElement): Layer | null => {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: false,
    premultipliedAlpha: true,
  });
  if (gl === null) {
    return null;
  }
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (vertex === null || fragment === null || program === null) {
    return null;
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    return null;
  }
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW
  );
  const position = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const at = new Map(
    UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)])
  );
  return { canvas, gl, at };
};

const mix = (from: Rgb, to: Rgb, part: number): Rgb => [
  from[0] + (to[0] - from[0]) * part,
  from[1] + (to[1] - from[1]) * part,
  from[2] + (to[2] - from[2]) * part,
];

const hexRgb = (hex: string): Rgb => [
  Number.parseInt(hex.slice(1, 3), 16) / 255,
  Number.parseInt(hex.slice(3, 5), 16) / 255,
  Number.parseInt(hex.slice(5, 7), 16) / 255,
];

/** The page's colours as the shader takes them, read from the tokens as the page resolves them. */
const coloursOf = (canvas: HTMLCanvasElement) => {
  const tones = readTones(canvas);
  const probe = document.createElement("canvas");
  probe.width = 1;
  probe.height = 1;
  const context = probe.getContext("2d", { willReadFrequently: true });
  const rgb = (colour: string): Rgb => {
    if (context === null) {
      return [0, 0, 0];
    }
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = colour;
    context.fillRect(0, 0, 1, 1);
    const [red = 0, green = 0, blue = 0] = context.getImageData(
      0,
      0,
      1,
      1
    ).data;
    return [red / 255, green / 255, blue / 255];
  };
  const ground = rgb(tones.background);
  const night = rgb(tones.night);
  const ink = rgb(tones.ink);
  const pine = rgb(tones.pine);
  const mint = rgb(tones.mint);
  const sea = rgb(tones.sea);
  const lime = rgb(tones.lime);
  const paper = rgb(tones.paper);
  const dark = ground[0] + ground[1] + ground[2] < 1.5;
  return {
    // At rest he is close to the page's own ground; only where he gathers does he light up.
    amb: dark
      ? [
          mix(ground, pine, 0.3),
          mix(ground, pine, 0.62),
          mix(pine, mint, 0.35),
          mix(pine, mint, 0.85),
        ]
      : [
          mix(ground, sea, 0.32),
          mix(ground, sea, 0.7),
          mix(sea, mint, 0.45),
          mint,
        ],
    palette: [night, ink, pine, mint, sea, lime, paper],
    // On a dark page he covers it from night to lime; on a light one from mint to paper.
    tones: dark ? ([0.06, 0.8] as const) : ([0.46, 1] as const),
  };
};

type Colours = ReturnType<typeof coloursOf>;

const smoother = (part: number): number => {
  const t = Math.min(1, Math.max(0, part));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/** Halfway toward `to` every `halfLife` milliseconds. */
const toward = (
  from: number,
  to: number,
  elapsed: number,
  halfLife: number
): number => to + (from - to) * 0.5 ** (elapsed / halfLife);

const boxOf = (element: Element): Box => {
  const { x, y, width, height } = element.getBoundingClientRect();
  return [x, y, width, height];
};

/** How far the window's farthest corner is from a box. */
const farthest = (box: Box): number => {
  const [x, y, width, height] = box;
  const across = Math.max(x, window.innerWidth - (x + width));
  const down = Math.max(y, window.innerHeight - (y + height));
  return Math.hypot(Math.max(across, 0), Math.max(down, 0));
};

/** Once the next frame is drawn. */
const nextFrame = async (): Promise<void> => {
  // The frame's own time is what it resolves with.
  const { promise, resolve } = Promise.withResolvers<number>();
  requestAnimationFrame(resolve);
  await promise;
};

interface Carry {
  phase: 1 | 2 | 3;
  since: number;
  from: Box;
  toward: Box;
  picture: Picture;
}

const flagShape = (picture: Picture): Rgb => {
  if (picture === null || picture.shape.kind === "across") {
    const [first, second] =
      picture?.shape.kind === "across" ? picture.shape.split : [1 / 3, 2 / 3];
    return [0, first, second];
  }
  return picture.shape.kind === "upright" ? [1, 1 / 3, 2 / 3] : [2, 0, 0];
};

/** Everything about him that outlives a canvas: a screen drawn anew finds him as he was. */
interface Him {
  pose: Pose | null;
  /** Where he rests now, on his way to the pose: centre, reach, strength. */
  rest: { x: number; y: number; w: number; h: number; strength: number };
  clock: number;
  pointer: {
    x: number;
    y: number;
    tx: number;
    ty: number;
    on: number;
    there: boolean;
  };
  attention: {
    element: Element | null;
    box: Box;
    on: number;
    behind: boolean;
    radius: number;
  };
  carry: Carry | null;
  /** Told while he covers the page: nothing under him can be pressed then. */
  onCovering: ((covering: boolean) => void) | null;
}

const him: Him = {
  pose: null,
  rest: { x: 0.5, y: 0, w: 0.8, h: 0.4, strength: 0 },
  clock: 0,
  pointer: { x: 0, y: 0, tx: 0, ty: 0, on: 0, there: false },
  attention: {
    element: null,
    box: [0, 0, 0, 0],
    on: 0,
    behind: false,
    radius: 0,
  },
  carry: null,
  onCovering: null,
};

/** The canvases he is drawn on now, with what stops the drawing; none between two screens. */
let stage: { layers: readonly [Layer, Layer]; stop: () => void } | null = null;

const fronts = (now: number): Rgb => {
  const { carry } = him;
  if (carry === null) {
    return [0, 0, 0];
  }
  const elapsed = now - carry.since;
  if (carry.phase === 3) {
    const reach = farthest(carry.toward) + FRONT_SLACK;
    return [0, 0, reach - (reach + FRONT_SLACK) * smoother(elapsed / DRAIN_MS)];
  }
  // Nothing of a front shows at first; a frame later it is all over what was pressed.
  const start = -(Math.min(carry.from[2], carry.from[3]) / 2 + FRONT_SLACK / 3);
  const reach = farthest(carry.from) + FRONT_SLACK;
  const along = (part: number) => start + (reach - start) * part;
  return [
    // The picture bursts out and slows; he wells up after it and sweeps.
    along(1 - (1 - Math.min(1, Math.max(0, elapsed / SPREAD_MS))) ** 2.4),
    along(smoother((elapsed - CHASE_MS) / CHASE_SPREAD_MS)),
    0,
  ];
};

const draw = (layer: Layer, index: number, now: number, colours: Colours) => {
  const { gl, at, canvas } = layer;
  const { pose, rest, pointer, attention, carry } = him;
  const u = (name: Uniform) => at.get(name) ?? null;
  const width = window.innerWidth;
  const height = window.innerHeight;
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.uniform2f(u("u_cells"), canvas.width, canvas.height);
  gl.uniform1f(u("u_cell"), CELL);
  gl.uniform1f(u("u_time"), him.clock);
  gl.uniform1f(u("u_layer"), index);
  gl.uniform3fv(u("u_amb[0]"), colours.amb.flat());
  gl.uniform3fv(u("u_palette[0]"), colours.palette.flat());
  gl.uniform2f(u("u_tones"), colours.tones[0], colours.tones[1]);
  gl.uniform4f(
    u("u_rest"),
    rest.x * width,
    rest.y * height,
    rest.w * width,
    rest.h * height
  );
  gl.uniform3f(u("u_mood"), pose?.seed ?? 0, pose?.tempo ?? 1, rest.strength);
  gl.uniform3f(u("u_pointer"), pointer.x, pointer.y, pointer.on);
  gl.uniform4f(u("u_attend"), ...attention.box);
  gl.uniform1f(u("u_attendOn"), attention.on);
  gl.uniform1f(u("u_attendKind"), attention.behind ? 1 : 0);
  gl.uniform1f(u("u_attendRadius"), attention.radius);
  gl.uniform1f(u("u_phase"), carry?.phase ?? 0);
  gl.uniform4f(u("u_from"), ...(carry?.from ?? [0, 0, 0, 0]));
  gl.uniform4f(u("u_toward"), ...(carry?.toward ?? [0, 0, 0, 0]));
  gl.uniform3f(u("u_fronts"), ...fronts(now));
  const picture = carry?.picture ?? null;
  gl.uniform3fv(
    u("u_flag[0]"),
    (picture?.real ?? ["#000000", "#000000", "#000000"]).flatMap((hex) => [
      ...hexRgb(hex),
    ])
  );
  gl.uniform3f(u("u_flagShape"), ...flagShape(picture));
  gl.uniform1f(u("u_flagOn"), picture === null ? 0 : 1);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
};

/** Him a moment later: on his way to his pose, behind the pointer, round what he attends to. */
const settle = (elapsed: number) => {
  const { pose, rest, pointer, attention } = him;
  if (pose !== null) {
    rest.x = toward(rest.x, pose.at[0], elapsed, 260);
    rest.y = toward(rest.y, pose.at[1], elapsed, 260);
    rest.w = toward(rest.w, pose.reach[0], elapsed, 260);
    rest.h = toward(rest.h, pose.reach[1], elapsed, 260);
    rest.strength = toward(rest.strength, pose.strength, elapsed, 320);
  }
  pointer.x = toward(pointer.x, pointer.tx, elapsed, 110);
  pointer.y = toward(pointer.y, pointer.ty, elapsed, 110);
  pointer.on = toward(pointer.on, pointer.there ? 1 : 0, elapsed, 180);
  const { element } = attention;
  const held = element !== null && element.isConnected;
  if (held) {
    const box = boxOf(element);
    // From nothing he is there at once; from one thing to the next he glides.
    const arrived = attention.on < 0.05;
    const glide = (from: number, to: number) =>
      arrived ? to : toward(from, to, elapsed, 70);
    const [x, y, width, height] = attention.box;
    attention.box = [
      glide(x, box[0]),
      glide(y, box[1]),
      glide(width, box[2]),
      glide(height, box[3]),
    ];
  }
  attention.on = toward(attention.on, held ? 1 : 0, elapsed, held ? 90 : 160);
};

/** Him at rest where this screen has him, nothing gathered: what reduced motion shows. */
const rested = () => {
  const { pose, rest, pointer, attention } = him;
  if (pose !== null) {
    [rest.x, rest.y] = pose.at;
    [rest.w, rest.h] = pose.reach;
    rest.strength = pose.strength;
  }
  pointer.on = 0;
  attention.on = 0;
};

/**
 * He is drawn on these two canvases from now on, one under the page and
 * one over it, as he is: a carry under way goes on, on the screen drawn
 * anew. Gives what stops it; nothing where WebGL can't run.
 */
export const attachField = (
  under: HTMLCanvasElement,
  over: HTMLCanvasElement,
  onCovering: (covering: boolean) => void
): (() => void) | null => {
  const ground = layerOf(under);
  const cover = layerOf(over);
  if (ground === null || cover === null) {
    return null;
  }
  stage?.stop();
  const layers = [ground, cover] as const;
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  let colours = coloursOf(under);
  let frame = 0;
  let last = performance.now();
  let coverDrawn = false;

  const size = () => {
    for (const { canvas, gl } of layers) {
      canvas.width = Math.ceil(window.innerWidth / CELL);
      canvas.height = Math.ceil(window.innerHeight / CELL);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
  };
  const paint = (now: number) => {
    draw(ground, 0, now, colours);
    if (him.carry !== null) {
      draw(cover, 1, now, colours);
      coverDrawn = true;
    } else if (coverDrawn) {
      cover.gl.clearColor(0, 0, 0, 0);
      cover.gl.clear(cover.gl.COLOR_BUFFER_BIT);
      coverDrawn = false;
    }
  };
  const loop = (now: number) => {
    const elapsed = Math.min(Math.max(now - last, 0), 64);
    last = now;
    him.clock += elapsed / 1000;
    settle(elapsed);
    paint(now);
    frame = requestAnimationFrame(loop);
  };
  const run = () => {
    cancelAnimationFrame(frame);
    if (still.matches) {
      rested();
      paint(performance.now());
      return;
    }
    last = performance.now();
    // Drawn at once, before the page is next shown: a carry under way never blinks.
    paint(last);
    frame = requestAnimationFrame(loop);
  };
  const onResize = () => {
    size();
    if (still.matches) {
      paint(performance.now());
    }
  };
  const onMove = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") {
      return;
    }
    const { pointer } = him;
    pointer.tx = event.clientX;
    pointer.ty = event.clientY;
    if (!pointer.there) {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
    }
    pointer.there = true;
  };
  const onLeave = () => {
    him.pointer.there = false;
  };
  const onColours = () => {
    colours = coloursOf(under);
    if (still.matches) {
      paint(performance.now());
    }
  };

  size();
  window.addEventListener("resize", onResize);
  window.addEventListener("pointermove", onMove);
  document.documentElement.addEventListener("pointerleave", onLeave);
  still.addEventListener("change", run);
  const modes = new MutationObserver(onColours);
  modes.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-mode"],
  });
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", onColours);
  him.onCovering = onCovering;
  onCovering(him.carry !== null);

  const stop = () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("pointermove", onMove);
    document.documentElement.removeEventListener("pointerleave", onLeave);
    still.removeEventListener("change", run);
    modes.disconnect();
    scheme.removeEventListener("change", onColours);
    if (stage?.layers === layers) {
      stage = null;
    }
    if (him.onCovering === onCovering) {
      him.onCovering = null;
    }
  };
  stage = { layers, stop };
  run();
  return stop;
};

/** Where he rests on this screen and how he moves there. */
export const poseField = (pose: Pose) => {
  if (him.pose === null) {
    // His first screen: he is there, not on his way.
    [him.rest.x, him.rest.y] = pose.at;
    [him.rest.w, him.rest.h] = pose.reach;
  }
  him.pose = pose;
};

/** He gathers round an element, a thing to press; `null` lets go. */
export const attendField = (element: Element | null) => {
  him.attention.element = element;
  if (element !== null) {
    him.attention.behind = false;
    // His line follows the element's own corner, read from the page.
    const corner = Number(
      getComputedStyle(element).borderTopLeftRadius.replace("px", "")
    );
    him.attention.radius = Number.isFinite(corner) ? corner : 0;
  }
};

/**
 * He carries the page on: spreads from `from` (showing `picture` first,
 * where there is one), covers the window, lets the page `turn` under him
 * (`turn` is over once the new screen is there), and drains away toward
 * the new screen's title. Where he isn't drawn, or may not move, it is
 * only the page turning.
 */
export const carryField = async (
  from: Element,
  picture: Picture,
  turn: () => Promise<void>
): Promise<void> => {
  const moving = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (stage === null || !moving || him.carry !== null) {
    await turn();
    return;
  }
  const origin = boxOf(from);
  const carry: Carry = {
    phase: 1,
    since: performance.now(),
    from: origin,
    toward: origin,
    picture,
  };
  him.carry = carry;
  him.onCovering?.(true);
  await wait(CHASE_MS + CHASE_SPREAD_MS);
  carry.phase = 2;
  try {
    await turn();
  } finally {
    // The new screen is drawn a frame or two after the page turns.
    await nextFrame();
    await nextFrame();
    const title = document.querySelector("main h1");
    carry.toward =
      title === null
        ? [window.innerWidth / 2, window.innerHeight / 3, 0, 0]
        : boxOf(title);
    carry.phase = 3;
    carry.since = performance.now();
    // He stays behind the new title a moment, a faint light, then lets go.
    him.attention.element = title;
    him.attention.behind = true;
    him.attention.radius = 0;
    him.attention.on = 0;
    await wait(DRAIN_MS);
    him.carry = null;
    him.onCovering?.(false);
    void (async () => {
      await wait(LINGER_MS);
      if (him.attention.element === title) {
        him.attention.element = null;
      }
    })();
  }
};
