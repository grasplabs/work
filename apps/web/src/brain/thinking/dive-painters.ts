import { LIGHT } from "../atlas-map.ts";
import { rgb } from "../dot-ink.ts";
import { brainCloud } from "../dot-shapes.ts";
import { seeded } from "../reveal-motion.ts";
import { focal } from "./dive-scene.ts";
import type { Plane, Pose, Vec3 } from "./dive-scene.ts";

// What draws the dive (grasplabs/prototype
// `components/knowledge/dive-painters.ts`): in WebGL, the brain's surface the
// camera flies through and the print, one draw call each a frame; where
// WebGL 2 won't start, a 2D canvas that draws only the print, still, as the
// camera at rest sees it. The print comes in the dive's own pixels
// (dive-print.ts), so both draw the same dots, in the brain's own colours
// from the stylesheet.

/** A printed dot, as the painters read it: where (pixels), how large, how bold, how warm, and whether in the attention colour. */
export const DOT_FLOATS = 6;
/** The most printed dots drawn at once. */
export const MOST_DOTS = 60_000;
/** The share of the brain's surface dots drawn, seen from outside: few, so the brain reads light. */
const SURFACE_KEEP = 0.34;

/** What a frame paints: the camera, how far inside it is, the plane the print stands on, and how many dots it has. */
export interface DiveFrame {
  matrix: Float32Array;
  pose: Pose;
  inside: number;
  plane: Plane;
  dots: number;
}

/** A painter: the dots to fill, how to paint them, and whether it is the 2D canvas, which has no flight. */
export interface DivePainter {
  flat: boolean;
  dots: Float32Array;
  paint: (frame: DiveFrame) => void;
  dispose: () => void;
}

/** The dive's colours, 0 to 1: the brain's ink, its warmth, and the attention colour for what is open. */
interface Inks {
  ink: Vec3;
  warm: Vec3;
  open: Vec3;
}

const inksOf = (element: HTMLElement): Inks => {
  const read = (name: string, fallback: string): Vec3 => {
    const [r, g, b] = rgb(
      getComputedStyle(element).getPropertyValue(name).trim() || fallback
    );
    return [r / 255, g / 255, b / 255];
  };
  return {
    ink: read("--brain-ink", "#1a1a19"),
    warm: read("--brain-heat", "#e5572b"),
    open: read("--status-attention", "#d0561c"),
  };
};

/** The colours as they are now, read again when the theme changes. */
const watchedInks = (holder: HTMLElement): { now: Inks; stop: () => void } => {
  const state = { now: inksOf(holder) };
  const themes = new MutationObserver(() => {
    state.now = inksOf(holder);
  });
  themes.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  return {
    get now() {
      return state.now;
    },
    stop: () => {
      themes.disconnect();
    },
  };
};

// ---- WebGL ----

/** A dot drawn: its size on screen from its size in the world, soft and faint right in front of the lens. */
const COMMON = `#version 300 es
precision highp float;
uniform mat4 uVP;
uniform vec3 uCam;
uniform vec3 uLight;
uniform float uPx;
out float vAlpha;
out float vHeat;
out float vTone;
out float vSize;
void hide() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = 1.0;
  vAlpha = 0.0;
}
void place(vec3 p, float radius, float alpha, float heat) {
  gl_Position = uVP * vec4(p, 1.0);
  float depth = gl_Position.w;
  if (depth < 0.004) { hide(); return; }
  float size = 2.0 * radius * uPx / depth;
  float soft = clamp(pow(22.0 / max(size, 22.0), 1.5), 0.0, 1.0);
  vSize = clamp(size, 1.0, 72.0);
  vAlpha = alpha * soft * smoothstep(0.02, 0.14, depth) * clamp(size, 0.35, 1.0);
  if (vAlpha < 0.004) { hide(); return; }
  gl_PointSize = vSize;
  vHeat = heat;
  vTone = 0.0;
}
`;

/** A round dot, crisp as print: the brain's ink, its warmth where Grasp reads, the attention colour where something is open. */
const DISC = `#version 300 es
precision mediump float;
in float vAlpha;
in float vHeat;
in float vTone;
in float vSize;
uniform vec3 uInk;
uniform vec3 uHot;
uniform vec3 uOpen;
out vec4 colour;
void main() {
  float d = length(gl_PointCoord * 2.0 - 1.0);
  float radius = vSize * 0.5;
  float edge = mix(1.0, radius * 0.75, clamp((vSize - 20.0) / 70.0, 0.0, 1.0));
  float a = clamp(0.5 + (1.0 - d) * radius / edge, 0.0, 1.0) * vAlpha;
  if (a < 0.003) discard;
  vec3 c = mix(mix(uInk, uHot, clamp(vHeat * 1.25, 0.0, 1.0)), uOpen, vTone);
  colour = vec4(c * a, a);
}
`;

/** The brain's surface, a share of its dots: lit where it faces the light; from inside, a faint dome. */
const SHELL = `${COMMON}
in vec3 aPos;
in vec3 aNor;
in float aGrain;
uniform float uInside;
uniform float uKeep;
void main() {
  if (fract(aGrain * 97.31) > mix(uKeep, uKeep * 0.22, uInside)) { hide(); return; }
  vec3 view = normalize(uCam - aPos);
  float facing = dot(aNor, view);
  float front = smoothstep(-0.05, 0.25, facing);
  float light = max(dot(aNor, uLight), 0.0);
  float outside = (0.14 + 0.86 * pow(light, 0.9)) * (0.4 + 0.6 * sqrt(max(facing, 0.0)));
  float within = 0.15 + 0.4 * pow(max(-facing, 0.0), 0.7);
  float behind = (1.0 - front) * uInside;
  float lit = mix(outside, within, behind);
  float there = front * (1.0 - 0.6 * uInside) + behind * 0.24;
  float away = length(uCam - aPos);
  float alpha = (0.16 + 0.5 * lit) * there * smoothstep(0.2, 0.75, away);
  float near = mix(1.0, 0.6 * clamp(away / 1.6, 0.2, 1.0), uInside);
  float radius = 0.028 * (0.62 + 0.76 * aGrain) * (0.075 + 0.3 * lit) * near;
  place(aPos, radius, alpha, 0.0);
}
`;

/** The print: each dot where the dive's pixels put it on the plane in front of the camera at rest. */
const PRINT = `${COMMON}
in vec2 aAt;
in vec4 aLook;
uniform vec3 uOrigin;
uniform vec3 uAcross;
uniform vec3 uDown;
uniform float uPixel;
void main() {
  place(uOrigin + uAcross * aAt.x + uDown * aAt.y, aLook.x * uPixel, aLook.y, aLook.z);
  vTone = aLook.w;
}
`;

/** A program from a vertex shader and the disc; none when it doesn't build. */
const programOf = (
  gl: WebGL2RenderingContext,
  vertexSource: string
): WebGLProgram | null => {
  const compile = (type: number, source: string): WebGLShader | null => {
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
  const vertex = compile(gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl.FRAGMENT_SHADER, DISC);
  const made = gl.createProgram();
  if (vertex === null || fragment === null || made === null) {
    return null;
  }
  gl.attachShader(made, vertex);
  gl.attachShader(made, fragment);
  gl.linkProgram(made);
  return gl.getProgramParameter(made, gl.LINK_STATUS) === true ? made : null;
};

/** The brain's surface as buffers: where each dot is, its normal and its grain. */
const surfaceOf = (): {
  count: number;
  position: Float32Array;
  normal: Float32Array;
  grain: Float32Array;
} => {
  const cloud = brainCloud();
  const random = seeded(1801);
  const position = new Float32Array(cloud.count * 3);
  const normal = new Float32Array(cloud.count * 3);
  const grain = new Float32Array(cloud.count);
  for (let at = 0; at < cloud.count; at += 1) {
    position.set(
      [cloud.x[at] ?? 0, cloud.y[at] ?? 0, cloud.z[at] ?? 0],
      at * 3
    );
    normal.set(
      [cloud.nx[at] ?? 0, cloud.ny[at] ?? 0, cloud.nz[at] ?? 0],
      at * 3
    );
    grain[at] = random();
  }
  return { count: cloud.count, position, normal, grain };
};

/** The scene on the GPU: the brain's surface and the print; none when WebGL 2 won't start. */
const glPainter = (
  element: HTMLCanvasElement,
  holder: HTMLElement
): DivePainter | null => {
  const gl = element.getContext("webgl2", {
    antialias: false,
    premultipliedAlpha: true,
    alpha: true,
  });
  if (gl === null) {
    return null;
  }
  const shell = programOf(gl, SHELL);
  const print = programOf(gl, PRINT);
  if (shell === null || print === null) {
    return null;
  }
  const surface = surfaceOf();
  const buffers: (WebGLBuffer | null)[] = [];
  const attribute = (
    made: WebGLProgram,
    name: string,
    data: Float32Array,
    size: number
  ): void => {
    const buffer = gl.createBuffer();
    buffers.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const location = gl.getAttribLocation(made, name);
    if (location >= 0) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    }
  };
  const shellVao = gl.createVertexArray();
  gl.bindVertexArray(shellVao);
  attribute(shell, "aPos", surface.position, 3);
  attribute(shell, "aNor", surface.normal, 3);
  attribute(shell, "aGrain", surface.grain, 1);

  const dots = new Float32Array(MOST_DOTS * DOT_FLOATS);
  const printVao = gl.createVertexArray();
  gl.bindVertexArray(printVao);
  const printBuffer = gl.createBuffer();
  buffers.push(printBuffer);
  gl.bindBuffer(gl.ARRAY_BUFFER, printBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, dots.byteLength, gl.DYNAMIC_DRAW);
  const placeAt = gl.getAttribLocation(print, "aAt");
  const look = gl.getAttribLocation(print, "aLook");
  gl.enableVertexAttribArray(placeAt);
  gl.vertexAttribPointer(placeAt, 2, gl.FLOAT, false, DOT_FLOATS * 4, 0);
  gl.enableVertexAttribArray(look);
  gl.vertexAttribPointer(look, 4, gl.FLOAT, false, DOT_FLOATS * 4, 8);
  gl.bindVertexArray(null);

  const colours = watchedInks(holder);
  const where = (made: WebGLProgram, name: string) =>
    gl.getUniformLocation(made, name);
  const common = (made: WebGLProgram, frame: DiveFrame): void => {
    gl.useProgram(made);
    gl.uniformMatrix4fv(where(made, "uVP"), false, frame.matrix);
    gl.uniform3fv(where(made, "uCam"), frame.pose.eye);
    gl.uniform3fv(where(made, "uLight"), LIGHT);
    gl.uniform1f(where(made, "uPx"), focal(frame.pose.fov, element.height));
    gl.uniform3fv(where(made, "uInk"), colours.now.ink);
    gl.uniform3fv(where(made, "uHot"), colours.now.warm);
    gl.uniform3fv(where(made, "uOpen"), colours.now.open);
  };
  const paint = (frame: DiveFrame): void => {
    gl.viewport(0, 0, element.width, element.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    common(shell, frame);
    gl.uniform1f(where(shell, "uInside"), frame.inside);
    gl.uniform1f(where(shell, "uKeep"), SURFACE_KEEP);
    gl.bindVertexArray(shellVao);
    gl.drawArrays(gl.POINTS, 0, surface.count);
    if (frame.dots > 0) {
      common(print, frame);
      gl.uniform3fv(where(print, "uOrigin"), frame.plane.origin);
      gl.uniform3fv(where(print, "uAcross"), frame.plane.across);
      gl.uniform3fv(where(print, "uDown"), frame.plane.down);
      gl.uniform1f(where(print, "uPixel"), frame.plane.pixel);
      gl.bindVertexArray(printVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, printBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, dots, 0, frame.dots * DOT_FLOATS);
      gl.drawArrays(gl.POINTS, 0, frame.dots);
    }
    gl.bindVertexArray(null);
  };
  const dispose = (): void => {
    colours.stop();
    for (const buffer of buffers) {
      gl.deleteBuffer(buffer);
    }
    gl.deleteVertexArray(shellVao);
    gl.deleteVertexArray(printVao);
    gl.deleteProgram(shell);
    gl.deleteProgram(print);
  };
  return { flat: false, dots, paint, dispose };
};

// ---- A 2D canvas ----

/** How finely a 2D dot's boldness and warmth are told apart: one colour each, made once. */
const SHADES = { alpha: 24, heat: 8 };

const mixed = (one: Vec3, other: Vec3, t: number): number[] =>
  one.map((value, at) =>
    Math.round((value + ((other[at] ?? 0) - value) * t) * 255)
  );

/** The print on a 2D canvas, as the camera at rest sees it: no surface and no flight. */
const flatPainter = (
  element: HTMLCanvasElement,
  holder: HTMLElement
): DivePainter => {
  const context = element.getContext("2d");
  const dots = new Float32Array(MOST_DOTS * DOT_FLOATS);
  const colours = watchedInks(holder);
  const styles = new Map<number, string>();
  let madeFor = colours.now;
  const styleOf = (alpha: number, heat: number, tone: number): string => {
    const a = Math.round(Math.min(1, alpha) * SHADES.alpha);
    const h = Math.round(Math.min(1, heat * 1.25) * SHADES.heat);
    const open = tone > 0.5;
    const key = (open ? 10_000 : 0) + h * 100 + a;
    const known = styles.get(key);
    if (known !== undefined) {
      return known;
    }
    const { ink, warm } = colours.now;
    const [r, g, b] = open
      ? mixed(colours.now.open, colours.now.open, 1)
      : mixed(ink, warm, h / SHADES.heat);
    const style = `rgba(${r ?? 0}, ${g ?? 0}, ${b ?? 0}, ${(a / SHADES.alpha).toFixed(3)})`;
    styles.set(key, style);
    return style;
  };
  const paint = (frame: DiveFrame): void => {
    if (context === null) {
      return;
    }
    if (madeFor !== colours.now) {
      styles.clear();
      madeFor = colours.now;
    }
    const ratio = element.width / Math.max(element.clientWidth, 1);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, element.clientWidth, element.clientHeight);
    for (let at = 0; at < frame.dots * DOT_FLOATS; at += DOT_FLOATS) {
      context.fillStyle = styleOf(
        dots[at + 3] ?? 0,
        dots[at + 4] ?? 0,
        dots[at + 5] ?? 0
      );
      context.beginPath();
      context.arc(
        dots[at] ?? 0,
        dots[at + 1] ?? 0,
        Math.max(dots[at + 2] ?? 0, 0.4),
        0,
        Math.PI * 2
      );
      context.fill();
    }
  };
  return { flat: true, dots, paint, dispose: colours.stop };
};

/** The painter for this browser: WebGL 2, or a 2D canvas where that won't start. */
export const makePainter = (
  element: HTMLCanvasElement,
  holder: HTMLElement
): DivePainter => glPainter(element, holder) ?? flatPainter(element, holder);
