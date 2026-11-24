import { readTones } from "../campaign/pixels.ts";
import { drawMarks } from "./marks.ts";
import { FRAGMENT, VERTEX } from "./shader.ts";

// What drives Stephen's field (shader.ts): the canvas's size, the page's
// colours, the pointer, what he holds, and where he rests on this screen.
// One loop, a frame at a time; under reduced motion it draws him once,
// still.

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

type Rgb = readonly [number, number, number];
type Box = [number, number, number, number];

const UNIFORMS = [
  "u_cells",
  "u_cell",
  "u_time",
  "u_amb[0]",
  "u_palette[0]",
  "u_rest",
  "u_mood",
  "u_pointer",
  "u_holds[0]",
  "u_holdLooks[0]",
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
    // At rest he is close to the page's own ground; only where he gathers does he light up. On a
    // light page the palest greens would vanish into it: there he is mint, deepening toward pine.
    amb: dark
      ? [
          mix(ground, pine, 0.3),
          mix(ground, pine, 0.62),
          mix(pine, mint, 0.35),
          mix(pine, mint, 0.85),
        ]
      : [
          mix(ground, mint, 0.34),
          mix(ground, mint, 0.6),
          mix(mint, pine, 0.18),
          mix(mint, pine, 0.42),
        ],
    palette: [night, ink, pine, mint, sea, lime, paper],
  };
};

type Colours = ReturnType<typeof coloursOf>;

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

/** One thing he holds: its light builds up while he is on it and fades there once he leaves. */
interface Hold {
  element: Element;
  box: Box;
  /** How much of his light is there, 0 to 1. */
  on: number;
  /** He is on it now. */
  held: boolean;
  /** Its corner, read from the page: his line follows it. */
  radius: number;
}

/** How many things he lights at once: the one he is on, and those still fading. */
const HOLDS = 4;

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
  /** What he holds now and what he still lets go of: each its own light, in its own place. */
  holds: Hold[];
}

const him: Him = {
  pose: null,
  rest: { x: 0.5, y: 0, w: 0.8, h: 0.4, strength: 0 },
  clock: 0,
  pointer: { x: 0, y: 0, tx: 0, ty: 0, on: 0, there: false },
  holds: [],
};

/** What stops the drawing on the canvas he is drawn on now; none between two screens. */
let stopDrawing: (() => void) | null = null;

const draw = (layer: Layer, colours: Colours) => {
  const { gl, at, canvas } = layer;
  const { pose, rest, pointer } = him;
  const u = (name: Uniform) => at.get(name) ?? null;
  const width = window.innerWidth;
  const height = window.innerHeight;
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.uniform2f(u("u_cells"), canvas.width, canvas.height);
  gl.uniform1f(u("u_cell"), CELL);
  gl.uniform1f(u("u_time"), him.clock);
  gl.uniform3fv(u("u_amb[0]"), colours.amb.flat());
  gl.uniform3fv(u("u_palette[0]"), colours.palette.flat());
  gl.uniform4f(
    u("u_rest"),
    rest.x * width,
    rest.y * height,
    rest.w * width,
    rest.h * height
  );
  gl.uniform3f(u("u_mood"), pose?.seed ?? 0, pose?.tempo ?? 1, rest.strength);
  gl.uniform3f(u("u_pointer"), pointer.x, pointer.y, pointer.on);
  const holds = Array.from({ length: HOLDS }, (_, slot) => him.holds[slot]);
  gl.uniform4fv(
    u("u_holds[0]"),
    holds.flatMap((hold) => hold?.box ?? [0, 0, 0, 0])
  );
  gl.uniform3fv(
    u("u_holdLooks[0]"),
    holds.flatMap((hold) =>
      hold === undefined ? [0, 0, 0] : [hold.on, 0, hold.radius]
    )
  );
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
};

/** Him a moment later: on his way to his pose, behind the pointer, round what he attends to. */
const settle = (elapsed: number) => {
  const { pose, rest, pointer } = him;
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
  // Each thing he holds stays where it is; his light builds up there, or fades there.
  for (const hold of him.holds) {
    if (hold.element.isConnected) {
      hold.box = boxOf(hold.element);
    }
    const on = hold.held && hold.element.isConnected;
    hold.on = toward(hold.on, on ? 1 : 0, elapsed, on ? 130 : 90);
  }
  him.holds = him.holds.filter((hold) => hold.held || hold.on > 0.004);
};

/**
 * Each ring on the edge of a thing he holds, as much there as his light
 * is: it builds up and fades with it, in place. A ring not in use is gone.
 */
const placeRings = (rings: readonly HTMLElement[]) => {
  for (const [slot, ring] of rings.entries()) {
    const hold = him.holds[slot];
    if (hold === undefined) {
      ring.style.opacity = "0";
      continue;
    }
    const [x, y, width, height] = hold.box;
    ring.style.opacity = String(hold.on);
    ring.style.transform = `translate(${x}px, ${y}px)`;
    ring.style.width = `${width}px`;
    ring.style.height = `${height}px`;
    ring.style.borderRadius = `${hold.radius}px`;
  }
};

/** Him at rest where this screen has him, nothing gathered: what reduced motion shows. */
const rested = () => {
  const { pose, rest, pointer } = him;
  if (pose !== null) {
    [rest.x, rest.y] = pose.at;
    [rest.w, rest.h] = pose.reach;
    rest.strength = pose.strength;
  }
  pointer.on = 0;
  him.holds = [];
};

/**
 * He is drawn on this canvas, under the page, from now on, as he is: a
 * screen drawn anew finds him where he was. Each thing he holds also gets
 * one of `rings`: a crisp line on its edge, drawn by the page so it follows
 * the element's own corner, and its own picture drawn large in his dither
 * on `marks`, a canvas over the page (marks.ts). Gives what stops it; nothing where WebGL can't
 * run.
 */
export const attachField = (
  canvas: HTMLCanvasElement,
  rings: readonly HTMLElement[],
  marks: HTMLCanvasElement
): (() => void) | null => {
  const layer = layerOf(canvas);
  if (layer === null) {
    return null;
  }
  stopDrawing?.();
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  let colours = coloursOf(canvas);
  // The light's own colour, as the page resolves it: the colour of the marks he draws.
  let { mint } = readTones(canvas);
  let frame = 0;
  let last = performance.now();

  const size = () => {
    canvas.width = Math.ceil(window.innerWidth / CELL);
    canvas.height = Math.ceil(window.innerHeight / CELL);
    layer.gl.viewport(0, 0, canvas.width, canvas.height);
  };
  const loop = (now: number) => {
    const elapsed = Math.min(Math.max(now - last, 0), 64);
    last = now;
    him.clock += elapsed / 1000;
    settle(elapsed);
    draw(layer, colours);
    placeRings(rings);
    drawMarks(marks, him.holds, mint, him.clock);
    frame = requestAnimationFrame(loop);
  };
  const run = () => {
    cancelAnimationFrame(frame);
    if (still.matches) {
      rested();
      draw(layer, colours);
      return;
    }
    last = performance.now();
    draw(layer, colours);
    frame = requestAnimationFrame(loop);
  };
  const onResize = () => {
    size();
    if (still.matches) {
      draw(layer, colours);
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
    colours = coloursOf(canvas);
    ({ mint } = readTones(canvas));
    if (still.matches) {
      draw(layer, colours);
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

  const stop = () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("pointermove", onMove);
    document.documentElement.removeEventListener("pointerleave", onLeave);
    still.removeEventListener("change", run);
    modes.disconnect();
    scheme.removeEventListener("change", onColours);
    if (stopDrawing === stop) {
      stopDrawing = null;
    }
    for (const ring of rings) {
      ring.style.opacity = "0";
    }
    drawMarks(marks, [], mint, 0);
  };
  stopDrawing = stop;
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

/** He takes hold of an element (and lets go of the one before, which fades where it is). */
const hold = (element: Element | null) => {
  for (const each of him.holds) {
    each.held = false;
  }
  if (element === null) {
    return;
  }
  const kept = him.holds.find((each) => each.element === element);
  if (kept !== undefined) {
    kept.held = true;
    return;
  }
  // His line follows the element's own corner, read from the page.
  const corner = Number(
    getComputedStyle(element).borderTopLeftRadius.replace("px", "")
  );
  him.holds.push({
    element,
    box: boxOf(element),
    on: 0,
    held: true,
    radius: Number.isFinite(corner) ? corner : 0,
  });
  // The faintest that is fading makes room: never more than he can draw.
  while (him.holds.length > HOLDS) {
    const [faintest] = him.holds
      .filter((each) => !each.held)
      .toSorted((a, b) => a.on - b.on);
    him.holds = him.holds.filter((each) => each !== faintest);
  }
};

/** He gathers round an element, a thing to press; `null` lets go. */
export const attendField = (element: Element | null) => {
  hold(element);
};

/** He lets go of this element, if he is on it; one he has moved on to keeps its light. */
export const releaseField = (element: Element) => {
  const held = him.holds.find((each) => each.element === element);
  if (held !== undefined) {
    held.held = false;
  }
};
