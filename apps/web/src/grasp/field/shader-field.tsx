import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";

import { ditherPatterns, ditherTones, isScene } from "./look.ts";
import type {
  DitherKind,
  DitherPattern,
  DitherTone,
  SceneKind,
} from "./look.ts";
import auroraUrl from "./scenes/aurora.jpg";
import cliffsUrl from "./scenes/cliffs.jpg";
import fujiUrl from "./scenes/fuji.jpg";
import starryUrl from "./scenes/starry.jpg";
import wandererUrl from "./scenes/wanderer.jpg";
import waveUrl from "./scenes/wave.jpg";

// Shader backdrops: one WebGL fragment shader drawn on one canvas, in the
// glass's seven greens, each cell a crisp square. Two families (look.ts):
//
// - the scenes (cliffs, wave, aurora, starry, fuji, wanderer): a picture,
//   kept as its light alone (scenes/, each from a work in the public
//   domain, named where it is listed below), dithered all over from night
//   to lime: every cell one of two neighbouring greens by Bayer's
//   threshold, so no cell stands out alone. The silk's light drifts
//   through it, and it sways a little.
// - the dithers (dusk, dots, door), from the website's shaders
//   (grasplabs/website, client/lab/shader-card.ts and login-door.ts): the
//   light of broad silk, of finer silk, and of a wave rolling behind
//   reeded glass with the pointer a lamp behind it, drawn as Capy's chat
//   is (Paper's Dithering shader): against Bayer's threshold, in a pattern
//   (whole 3px cells, a grid of dots, or the two together) and a colour,
//   on the page's own ground; a mask thins it towards what stands on the
//   page, so it blends in rather than covering it.
//
// Drawn about thirty times a second, and only while the page is seen.
// With less motion it is one still picture. Where WebGL can't run,
// nothing is drawn. Decorative only.

/** How a shader is dithered: its pattern and its colour. */
export interface Dither {
  pattern: DitherPattern;
  tone: DitherTone;
}

const VERTEX = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// Noise, the silk field, and the palette from night to paper.
const COMMON = `
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform vec2 u_lamp;
// How many CSS pixels one of the canvas's pixels is.
uniform float u_cell;
// The dither's pattern (0 for none) and tone.
uniform float u_pattern;
uniform float u_tone;
// A scene's picture: its light, its size, the part of it kept when it is
// cropped to fill the field, and its grade (gamma, gain, sway, drift).
uniform sampler2D u_image;
uniform vec2 u_imageRes;
uniform vec2 u_focus;
uniform vec4 u_grade;
// 1 where the picture is drawn as its negative.
uniform float u_invert;
varying vec2 v_uv;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}
float silk(vec2 p, float t) {
  vec2 q = vec2(fbm(p + vec2(0.0, t * 0.05)), fbm(p + vec2(5.2, 1.3) - t * 0.04));
  vec2 r = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2) + t * 0.06),
                fbm(p + 3.0 * q + vec2(8.3, 2.8) - t * 0.05));
  return fbm(p + 3.0 * r);
}
vec3 palette(float t) {
  vec3 c0 = vec3(0.012, 0.078, 0.055);
  vec3 c1 = vec3(0.024, 0.176, 0.133);
  vec3 c2 = vec3(0.043, 0.369, 0.306);
  vec3 c3 = vec3(0.129, 0.871, 0.643);
  vec3 c4 = vec3(0.624, 0.925, 0.769);
  vec3 c5 = vec3(0.851, 0.976, 0.678);
  vec3 c6 = vec3(0.953, 0.984, 0.925);
  t = clamp(t, 0.0, 1.0) * 6.0;
  vec3 c = mix(c0, c1, clamp(t, 0.0, 1.0));
  c = mix(c, c2, clamp(t - 1.0, 0.0, 1.0));
  c = mix(c, c3, clamp(t - 2.0, 0.0, 1.0));
  c = mix(c, c4, clamp(t - 3.0, 0.0, 1.0));
  c = mix(c, c5, clamp(t - 4.0, 0.0, 1.0));
  return mix(c, c6, clamp(t - 5.0, 0.0, 1.0));
}
// The ordered dither's threshold for a cell, 0 to 1: Bayer's 8 by 8.
float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2.0 + a.y * a.y * 0.75);
}
float bayer4(vec2 a) {
  return bayer2(0.5 * a) * 0.25 + bayer2(a);
}
float bayer8(vec2 a) {
  return bayer4(0.5 * a) * 0.25 + bayer2(a);
}
// How much of a cell at "fc" is ink, 0 or 1, for the dither's pattern
// where the kind's light is "t" (0 to 1): the light against Bayer's
// threshold for the cell, as Capy's chat does it (Paper's Dithering
// shader), so where the light is full the cells stand shoulder to
// shoulder, where there is none the page is bare, and between them the
// dither shows. In CSS pixels, as the canvas is.
float shapeOf(vec2 fc, float t) {
  // Bayer: whole 3px cells.
  if (u_pattern < 1.5) {
    return step(bayer8(floor(fc / 3.0)) + 0.002, t);
  }
  // Grid: 2px dots on a 4px grid.
  if (u_pattern < 2.5) {
    vec2 p = fract(fc / 4.0) * 4.0;
    float mark = step(p.x, 2.0) * step(p.y, 2.0);
    return mark * step(bayer8(floor(fc / 4.0)) + 0.002, t);
  }
  // Both: 2px dots in the 3px cells, a pixel apart.
  vec2 p = fract(fc / 3.0) * 3.0;
  float mark = step(p.x, 2.0) * step(p.y, 2.0);
  return mark * step(bayer8(floor(fc / 3.0)) + 0.002, t);
}
// The ink's colour and how strong it is laid. One flat colour, faint, so
// a full field reads as a tint (sea, pine, mint, lime or evergreen); or a
// run of the glass's greens, laid at full strength, as a northern light:
// never darker than pine, so it stays green and never greys. The run is
// the palette's, a sixth apart: pine at 0.33, mint, sea, lime at 0.83.
// Dark edge: pine at the window's edge to lime by the middle. Light edge:
// lime at the edge to pine inside, as the glass ran. Aurora: by the kind's
// own light, pine where it is fullest to lime at its fringes, a little
// deeper towards the edge.
vec4 toneOf(float light) {
  if (u_tone < 0.5) {
    return vec4(0.624, 0.925, 0.769, 0.5);
  }
  if (u_tone < 1.5) {
    return vec4(0.043, 0.369, 0.306, 0.3);
  }
  if (u_tone < 2.5) {
    return vec4(0.129, 0.871, 0.643, 0.28);
  }
  if (u_tone < 3.5) {
    return vec4(0.64, 0.9, 0.36, 0.34);
  }
  if (u_tone < 4.5) {
    return vec4(0.024, 0.176, 0.133, 0.16);
  }
  // How far out the cell is, along the canvas's own mask (styles.dithered):
  // 0 where the dither starts to show, 1 where it shows whole.
  float r = length(vec2((v_uv.x - 0.5) / 1.5, (v_uv.y + 0.1) / 1.35));
  float out_ = smoothstep(0.46, 0.9, r);
  if (u_tone < 5.5) {
    return vec4(palette(mix(0.8, 0.34, out_)), 0.9);
  }
  if (u_tone < 6.5) {
    return vec4(palette(mix(0.36, 0.84, out_)), 0.9);
  }
  return vec4(palette(clamp(mix(0.86, 0.4, light) - out_ * 0.08, 0.34, 0.86)), 0.9);
}
// What a dither draws: its light as ink in the pattern and colour, clear
// elsewhere so the page's own ground shows. It covers the whole field and
// runs on behind what stands on the page; how it thins towards the middle
// is the canvas's mask (styles.dithered), in strength, never in how many
// cells there are.
vec4 finish(float light) {
  float lit = clamp(light, 0.0, 1.0);
  vec4 tone = toneOf(lit);
  float on = shapeOf(gl_FragCoord.xy, lit);
  float alpha = on * tone.a;
  vec3 colour = tone.rgb * alpha;
  // The runs stand on green, as the glass's deep greens stood by its
  // lighter ones: between their cells, where the kind has any light,
  // lies the same colour drawn towards mint, so a thin field of deep cells
  // reads as green, not as grey on the page.
  if (u_tone > 4.5) {
    vec3 under = mix(tone.rgb, vec3(0.129, 0.871, 0.643), 0.72);
    float underAlpha = (1.0 - on) * smoothstep(0.02, 0.4, lit) * 0.45;
    colour += under * underAlpha;
    alpha += underAlpha;
  }
  return vec4(colour, alpha);
}
vec2 field() {
  return (v_uv - 0.5) * vec2(u_res.x / u_res.y, 1.0);
}
`;

/** A scene's picture and how it is graded. */
interface Picture {
  src: string;
  /** The part kept when it is cropped to fill the field, 0 to 1 each way, from the top left. */
  focus: readonly [number, number];
  /** Over 1 deepens its darks, under 1 lifts them. */
  gamma: number;
  gain: number;
  /** Drawn as its negative: for a picture of a light sky, which is to be night. */
  invert: boolean;
  /** How far it sways, as a part of its width. */
  sway: number;
  /** How much the silk's light takes from it and gives to it, 0 to 1. */
  drift: number;
}

// A scene: the picture, filling the field (a little larger, so it can
// sway), its light graded, the silk's light drifting through it, dimmer
// round the middle where the page's words stand, then every cell set to
// one of the two greens its light lies between, by Bayer's threshold. Six
// greens, night to lime: no cell is left bare and none stands alone.
const PICTURE = `
void main() {
  float aspect = u_res.x / u_res.y;
  float imageAspect = u_imageRes.x / u_imageRes.y;
  vec2 crop = aspect > imageAspect
    ? vec2(1.0, imageAspect / aspect)
    : vec2(aspect / imageAspect, 1.0);
  crop *= 0.94;
  vec2 focus = vec2(u_focus.x, 1.0 - u_focus.y);
  vec2 uv = (v_uv - 0.5) * crop + 0.5 + (focus - 0.5) * (1.0 - crop);
  vec2 p = v_uv * vec2(aspect, 1.0);
  vec2 sway = vec2(
    fbm(p * 2.2 + vec2(0.0, u_time * 0.02)),
    fbm(p * 2.2 + vec2(5.2, 1.3) - u_time * 0.017)
  ) - 0.5;
  uv += sway * u_grade.z;
  uv.x += 0.012 * sin(u_time * 0.03);
  float lum = texture2D(u_image, clamp(uv, 0.0, 1.0)).r;
  lum = mix(lum, 1.0 - lum, u_invert);
  float tone = pow(lum, u_grade.x) * u_grade.y;
  float light = silk(p * 1.1, u_time * 0.7);
  tone *= 1.0 + u_grade.w * (smoothstep(0.25, 0.75, light) - 0.5) * 2.0;
  vec2 mid = (v_uv - vec2(0.5, 0.53)) * vec2(min(aspect, 1.8) * 0.8, 1.9);
  tone *= mix(0.42, 1.0, smoothstep(0.12, 0.62, length(mid)));
  const float steps = 5.0;
  float q = floor(clamp(tone, 0.0, 1.0) * steps + bayer8(gl_FragCoord.xy)) / steps;
  gl_FragColor = vec4(palette(q * 0.86), 1.0);
}`;

const sceneOf = (picture: Picture) => ({ picture, source: PICTURE });

const KINDS: Record<
  SceneKind | DitherKind,
  { picture?: Picture; source: string }
> = {
  // The Cosmic Cliffs of the Carina Nebula (NASA, ESA, CSA, STScI; James
  // Webb Space Telescope, 2022): ridges of gas under a field of stars.
  cliffs: sceneOf({
    src: cliffsUrl,
    focus: [0.5, 0.5],
    gamma: 0.85,
    gain: 1.2,
    invert: false,
    sway: 0.014,
    drift: 0.4,
  }),
  // The Great Wave off Kanagawa (Katsushika Hokusai, about 1831), as its
  // negative: the sky is night and the wave's body carries the light.
  wave: sceneOf({
    src: waveUrl,
    focus: [0.35, 0.45],
    gamma: 1.5,
    gain: 1.15,
    invert: true,
    sway: 0.02,
    drift: 0.3,
  }),
  // A northern light from orbit, over Manicouagan's ring (NASA).
  aurora: sceneOf({
    src: auroraUrl,
    focus: [0.5, 0.4],
    gamma: 1.25,
    gain: 1.25,
    invert: false,
    sway: 0.018,
    drift: 0.45,
  }),
  // The Starry Night (Vincent van Gogh, 1889).
  starry: sceneOf({
    src: starryUrl,
    focus: [0.5, 0.35],
    gamma: 1.6,
    gain: 1.3,
    invert: false,
    sway: 0.022,
    drift: 0.3,
  }),
  // Fine Wind, Clear Morning (Katsushika Hokusai, about 1831): Fuji under
  // a mackerel sky.
  fuji: sceneOf({
    src: fujiUrl,
    focus: [0.6, 0.5],
    gamma: 1.7,
    gain: 1.1,
    invert: false,
    sway: 0.012,
    drift: 0.35,
  }),
  // Wanderer above the Sea of Fog (Caspar David Friedrich, about 1818).
  wanderer: sceneOf({
    src: wandererUrl,
    focus: [0.5, 0.42],
    gamma: 1.8,
    gain: 1.1,
    invert: false,
    sway: 0.012,
    drift: 0.45,
  }),
  // Dusk: the far side of the silk's broad folds.
  dusk: {
    source: `
void main() {
  vec2 p = field() * 1.4;
  float broad = smoothstep(0.3, 0.7, silk(p * 0.45 + 4.0, u_time));
  gl_FragColor = finish(1.0 - broad);
}`,
  },
  // Dots: finer folds of the same silk.
  dots: {
    source: `
void main() {
  vec2 p = field() * 1.4;
  gl_FragColor = finish(smoothstep(0.34, 0.7, silk(p * 2.3 + 9.0, u_time)));
}`,
  },
  // Door: the login's glass door. A wave of light rolling behind reeded
  // glass, every flute a lens, the pointer a lamp behind it; dim in the
  // middle, where the page's words stand.
  door: {
    source: `
float waveAt(vec2 p) {
  vec2 a = p / u_res.y;
  float sway = 0.2 * sin(a.y * 2.4 + u_time * 0.35) + 0.12 * (noise(a * 2.0 + u_time * 0.05) - 0.5);
  float u = p.x / u_res.x + sway - u_time * 0.075;
  float crest = 0.5 + 0.5 * cos(6.28318 * u);
  return pow(crest, 5.0) + 0.16 * pow(crest, 1.6);
}
void main() {
  float width = 30.0 / u_cell;
  float px = gl_FragCoord.x;
  float f = fract(px / width);
  float centre = (floor(px / width) + 0.5) * width;
  vec2 seen = vec2(centre + (f - 0.5) * width * 5.0, gl_FragCoord.y);
  float light = waveAt(seen);
  vec2 d = (seen - u_lamp) / u_res.y;
  light += exp(-dot(d, d) / 0.02) * 0.75;
  vec2 g = (v_uv - 0.5) * vec2(u_res.x / u_res.y, 1.0);
  float clear = smoothstep(0.14, 0.6, length(g * vec2(0.72, 1.0)));
  light *= mix(0.16, 1.0, clear);
  gl_FragColor = finish(light);
}`,
  },
};

/** A compiled shader of `type` from `source`; none where it doesn't compile. */
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

/** The linked program of `kind`, with the one quad it draws on; none where WebGL won't. */
const programOf = (
  gl: WebGLRenderingContext,
  kind: SceneKind | DitherKind
): WebGLProgram | null => {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, COMMON + KINDS[kind].source);
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
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW
  );
  const position = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  return program;
};

/** How long a frame is, at most thirty a second. */
const frameMs = 1000 / 30;

/** How large a scene's cell is, in CSS pixels, as Capy's dither's is. */
const sceneCell = 3;

/** How much slower a dither's clock runs than a scene's. */
const ditherPace = 0.3;

/** Where the shader's clock starts, so the first picture is already a settled one. */
const startAt = 8;

/** How fast the door's lamp eases towards the pointer, per second. */
const lampPull = 1.6;

const styles = stylex.create({
  canvas: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
  },
  // A scene: each of its cells a crisp square, over the whole field.
  crisp: {
    imageRendering: "pixelated",
  },
  // Dithered: each cell a crisp square, strongest in the far corners and
  // thinning, in strength, all the way in: a wide ellipse from under the
  // foot, as Capy's mask is, but never clear, so the dither has no edge
  // to stop at. A trace of it runs on under the page's words and box.
  dithered: {
    imageRendering: "pixelated",
    maskImage:
      "radial-gradient(150% 135% at 50% 110%, rgb(0 0 0 / 0.05) 0%, rgb(0 0 0 / 0.07) 40%, rgb(0 0 0 / 0.22) 62%, rgb(0 0 0 / 0.6) 80%, black 96%)",
  },
});

/**
 * The shader backdrop of `kind`, filling what it is placed in (a box with a
 * position of its own): a scene, or a dither in its pattern and colour.
 * Key it by its kind and dither: each on a canvas of its own, which the
 * browser lets go when it leaves.
 */
export const ShaderField = (
  props: { kind: SceneKind } | { kind: DitherKind; dither: Dither }
) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { kind } = props;
  const { picture } = KINDS[kind];
  const scene = isScene(kind);
  // As the shader numbers them: patterns from 1.
  const pattern =
    "dither" in props ? ditherPatterns.indexOf(props.dither.pattern) + 1 : 0;
  const tone = "dither" in props ? ditherTones.indexOf(props.dither.tone) : 0;
  useEffect(() => {
    const element = canvas.current;
    // Kept between frames: it is drawn only every other frame or so, and a
    // frame it isn't drawn on would otherwise show nothing.
    const gl = element?.getContext("webgl", {
      alpha: !scene,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    if (element === null || gl === null || gl === undefined) {
      return () => {
        // Nothing to draw on.
      };
    }
    const program = programOf(gl, kind);
    if (program === null) {
      return () => {
        // Nothing to draw with.
      };
    }
    const at = (name: string) => gl.getUniformLocation(program, name);
    const res = at("u_res");
    const time = at("u_time");
    const lampAt = at("u_lamp");
    const cellAt = at("u_cell");
    const patternAt = at("u_pattern");
    const toneAt = at("u_tone");
    // A scene's picture: night until it has loaded, then its light.
    const loading = picture === undefined ? undefined : new Image();
    if (picture !== undefined && loading !== undefined) {
      gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.LUMINANCE,
        1,
        1,
        0,
        gl.LUMINANCE,
        gl.UNSIGNED_BYTE,
        new Uint8Array([picture.invert ? 255 : 0])
      );
      for (const side of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) {
        gl.texParameteri(gl.TEXTURE_2D, side, gl.CLAMP_TO_EDGE);
      }
      for (const filter of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) {
        gl.texParameteri(gl.TEXTURE_2D, filter, gl.LINEAR);
      }
      gl.uniform1i(at("u_image"), 0);
      gl.uniform2f(at("u_imageRes"), 1, 1);
      gl.uniform2f(at("u_focus"), picture.focus[0], picture.focus[1]);
      gl.uniform4f(
        at("u_grade"),
        picture.gamma,
        picture.gain,
        picture.sway,
        picture.drift
      );
      gl.uniform1f(at("u_invert"), picture.invert ? 1 : 0);
    }
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    // A scene: one canvas pixel to a cell. A dither: one to a CSS pixel.
    // Both scaled up crisp. A dither's fields are broad, and read fast at
    // the clock's own pace.
    const ratio = scene ? 1 / sceneCell : 1;
    const pace = scene ? 1 : ditherPace;
    const lamp = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
    const begun = performance.now();
    let last = begun;
    let frame = 0;
    const fit = (): void => {
      const box = element.getBoundingClientRect();
      element.width = Math.max(1, Math.round(box.width * ratio));
      element.height = Math.max(1, Math.round(box.height * ratio));
      gl.viewport(0, 0, element.width, element.height);
    };
    const draw = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      lamp.x += (lamp.tx - lamp.x) * Math.min(1, lampPull * dt);
      lamp.y += (lamp.ty - lamp.y) * Math.min(1, lampPull * dt);
      gl.uniform2f(res, element.width, element.height);
      gl.uniform1f(cellAt, 1 / ratio);
      gl.uniform1f(patternAt, pattern);
      gl.uniform1f(toneAt, tone);
      gl.uniform1f(time, startAt + ((now - begun) / 1000) * pace);
      // The lamp in the canvas's pixels, its y from the foot, as WebGL counts.
      gl.uniform2f(
        lampAt,
        lamp.x * element.width,
        (1 - lamp.y) * element.height
      );
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    const loop = (now: number): void => {
      frame = requestAnimationFrame(loop);
      if (now - last >= frameMs && document.visibilityState === "visible") {
        draw(now);
      }
    };
    const point = (event: PointerEvent): void => {
      const box = element.getBoundingClientRect();
      lamp.tx = (event.clientX - box.left) / box.width;
      lamp.ty = (event.clientY - box.top) / box.height;
    };
    // Sizing the canvas clears it: drawn again at once, so no frame is
    // bare while what it fills is resized (the sidebar folding, say).
    const resized = new ResizeObserver(() => {
      fit();
      draw(performance.now());
    });
    resized.observe(element);
    fit();
    if (loading !== undefined && picture !== undefined) {
      loading.addEventListener("load", () => {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.LUMINANCE,
          gl.LUMINANCE,
          gl.UNSIGNED_BYTE,
          loading
        );
        gl.uniform2f(
          at("u_imageRes"),
          loading.naturalWidth,
          loading.naturalHeight
        );
        if (still) {
          draw(performance.now());
        }
      });
      loading.src = picture.src;
    }
    if (still) {
      draw(begun);
    } else {
      frame = requestAnimationFrame(loop);
      window.addEventListener("pointermove", point);
    }
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      window.removeEventListener("pointermove", point);
      // A picture still on its way is let go.
      loading?.removeAttribute("src");
    };
  }, [kind, picture, scene, pattern, tone]);
  return (
    <canvas
      aria-hidden="true"
      ref={canvas}
      {...stylex.props(styles.canvas, scene ? styles.crisp : styles.dithered)}
    />
  );
};
