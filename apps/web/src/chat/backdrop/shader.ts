// Shader backdrops: one WebGL fragment shader drawn on one canvas, each cell a crisp square.
// Ruben's (the product repo, grasp/field/shader-field.tsx), as he made it. Two families (look.ts):
//
// - the scenes (cliffs, wave, aurora, starry, fuji, wanderer): a picture, kept as its light alone
//   (each from a work in the public domain, named where it is listed below, served as
//   `<scenes><kind>.jpg`), dithered all over from night to lime: every cell one of two
//   neighbouring greens by Bayer's threshold, so no cell stands out alone. The silk's light drifts
//   through it, and it sways a little.
// - the dithers (dusk, dots, door), from the website's shaders: the light of broad silk, of finer
//   silk, and of a wave rolling behind reeded glass with the pointer a lamp behind it, drawn
//   against Bayer's threshold, in a pattern and a colour, on the page's own ground; a mask thins it
//   towards what stands on the page.
//
// Damsko's changes, none to the look: the greens are read from the tokens (light-night to
// light-paper, and backdrop-tone-* for the flat tones, which have dark values), not written in;
// under the words on a preview tile a scene is kept dark, so they read at that size (a full scene
// dims softly round the middle, as the product's does); it is run and held by Backdrop, which stops it out of view. Drawn fifteen to twenty times a second. With less motion
// it is one still picture. Where WebGL can't run, nothing is drawn. Decorative only. Loaded only
// when a shader backdrop comes into view.
import type {
  BackdropDither,
  BackdropPattern,
  BackdropScene,
  BackdropTone,
} from "./look.ts";
import { ditherPatterns, ditherTones, isScene } from "./look.ts";

const VERTEX = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

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
// How far the picture has arrived, 0 to 1: it comes up from night as arrive.in fades content in.
uniform float u_arrive;
// How far the page has gone, 0 to 1 (Backdrop's progress): a dither travels through its silk, its
// cells gather closer and its ink lays stronger as it rises. 0 draws as before.
uniform float u_progress;
// The light's seven stops, night to paper, read from the tokens (light-night to light-paper).
uniform vec3 u_palette[7];
// A flat tone's colour and strength, read from its token (backdrop-tone-*), in this scheme.
uniform vec4 u_flat;
// What stands on a scene, in the canvas's pixels from its foot (left, bottom, right, top), and 1
// where there is something: a preview tile's scene is kept dark under it, so its words read.
uniform vec4 u_clear;
uniform float u_hasClear;
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
  t = clamp(t, 0.0, 1.0) * 6.0;
  vec3 c = mix(u_palette[0], u_palette[1], clamp(t, 0.0, 1.0));
  c = mix(c, u_palette[2], clamp(t - 1.0, 0.0, 1.0));
  c = mix(c, u_palette[3], clamp(t - 2.0, 0.0, 1.0));
  c = mix(c, u_palette[4], clamp(t - 3.0, 0.0, 1.0));
  c = mix(c, u_palette[5], clamp(t - 4.0, 0.0, 1.0));
  return mix(c, u_palette[6], clamp(t - 5.0, 0.0, 1.0));
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
// a full field reads as a tint (sea, pine, mint, lime or evergreen: u_flat,
// from the tokens, with a dark value where it needs one); or a
// run of the glass's greens, laid at full strength, as a northern light:
// never darker than pine, so it stays green and never greys. The run is
// the palette's, a sixth apart: pine at 0.33, mint, sea, lime at 0.83.
// Dark edge: pine at the window's edge to lime by the middle. Light edge:
// lime at the edge to pine inside, as the glass ran. Aurora: by the kind's
// own light, pine where it is fullest to lime at its fringes, a little
// deeper towards the edge.
vec4 toneOf(float light) {
  if (u_tone < 4.5) {
    return u_flat;
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
  // Progress gathers the cells (more of them lit) and lays the ink stronger.
  float lit = clamp(light + u_progress * 0.28, 0.0, 1.0);
  vec4 tone = toneOf(lit);
  tone.a = min(1.0, tone.a * (1.0 + u_progress * 1.2));
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
  // Progress travels down through the silk, so the field moves with the page.
  return (v_uv - 0.5 + vec2(0.0, u_progress * 0.9)) * vec2(u_res.x / u_res.y, 1.0);
}
`;

/** A scene's picture and how it is graded. */
export interface Picture {
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

// A scene: the picture, filling the field (a little larger, so it can sway), its light graded, the
// silk's light drifting through it, dimmer round the middle where the page's words stand, then
// every cell set to one of the two greens its light lies between, by Bayer's threshold.
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
  tone *= u_arrive;
  float light = silk(p * 1.1, u_time * 0.7);
  tone *= 1.0 + u_grade.w * (smoothstep(0.25, 0.75, light) - 0.5) * 2.0;
  vec2 mid = (v_uv - vec2(0.5, 0.53)) * vec2(min(aspect, 1.8) * 0.8, 1.9);
  tone *= mix(0.42, 1.0, smoothstep(0.12, 0.62, length(mid)));
  // Under what stands on it the scene stays at most this light (Damsko: so a title over a
  // bright band in a narrow window still reads), easing back to itself a little way off.
  if (u_hasClear > 0.5) {
    vec2 fc = gl_FragCoord.xy;
    vec2 off = max(max(u_clear.xy - fc, fc - u_clear.zw), 0.0);
    float away = smoothstep(0.0, 16.0, length(off));
    tone = mix(min(tone, 0.3), tone, away);
  }
  const float steps = 5.0;
  float q = floor(clamp(tone, 0.0, 1.0) * steps + bayer8(gl_FragCoord.xy)) / steps;
  gl_FragColor = vec4(palette(q * 0.86), 1.0);
}`;

const sceneOf = (picture: Picture) => ({ picture, source: PICTURE });

const KINDS: Record<
  BackdropScene | BackdropDither,
  { picture?: Picture; source: string }
> = {
  // The Cosmic Cliffs of the Carina Nebula (NASA, ESA, CSA, STScI; James
  // Webb Space Telescope, 2022): ridges of gas under a field of stars.
  cliffs: sceneOf({
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
    focus: [0.35, 0.45],
    gamma: 1.5,
    gain: 1.15,
    invert: true,
    sway: 0.02,
    drift: 0.3,
  }),
  // A northern light from orbit, over Manicouagan's ring (NASA).
  aurora: sceneOf({
    focus: [0.5, 0.4],
    gamma: 1.25,
    gain: 1.25,
    invert: false,
    sway: 0.018,
    drift: 0.45,
  }),
  // The Starry Night (Vincent van Gogh, 1889).
  starry: sceneOf({
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
    focus: [0.6, 0.5],
    gamma: 1.7,
    gain: 1.1,
    invert: false,
    sway: 0.012,
    drift: 0.35,
  }),
  // Wanderer above the Sea of Fog (Caspar David Friedrich, about 1818).
  wanderer: sceneOf({
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

/** A shader of `type` from `source`, sent to be compiled; whether it did shows when its program links. */
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
  return shader;
};

/** The program of `kind`, sent to be linked, not yet asked whether it has: asking waits for it. */
const linking = (
  gl: WebGLRenderingContext,
  kind: BackdropScene | BackdropDither
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
  return program;
};

/** `program` once it has linked, with the one quad it draws on; none where it didn't. */
const linked = (
  gl: WebGLRenderingContext,
  program: WebGLProgram | null
): WebGLProgram | null => {
  if (
    program === null ||
    gl.getProgramParameter(program, gl.LINK_STATUS) !== true
  ) {
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

/** How large a scene's cell is, in CSS pixels, as Capy's dither's is. */
const sceneCell = 3;

/** Where the shader's clock starts, so the first picture is already a settled one. */
const startAt = 8;

/** A CSS colour as sRGB, 0 to 1 with its alpha, as a 2D canvas paints it. */
const rgbaOf = (() => {
  const known = new Map<string, readonly [number, number, number, number]>();
  return (colour: string): readonly [number, number, number, number] => {
    const kept = known.get(colour);
    if (kept !== undefined) {
      return kept;
    }
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (ctx === null) {
      return [0, 0, 0, 0];
    }
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data;
    // getImageData gives the channels as they were before the alpha was laid on.
    const found = [r / 255, g / 255, b / 255, a / 255] as const;
    known.set(colour, found);
    return found;
  };
})();

/** Calls `then` once `done` says so, asking again a task later each time, so the page runs on meanwhile. */
const whenDone = (done: () => boolean, then: () => void): void => {
  if (done()) {
    then();
    return;
  }
  setTimeout(() => {
    whenDone(done, then);
  }, 0);
};

/** Hands on a still picture: a PNG data address, or none where it couldn't be drawn. */
type KeepPicture = (picture: string | null) => void;

/** The scenes' pictures, each loaded and decoded once for every still drawn from it. */
const scenePictures = new Map<string, HTMLImageElement | null>();
const withScenePicture = (
  address: string,
  then: (image: HTMLImageElement | null) => void
): void => {
  const kept = scenePictures.get(address);
  if (kept !== undefined) {
    then(kept);
    return;
  }
  const image = new Image();
  image.src = address;
  const load = async () => {
    try {
      await image.decode();
      scenePictures.set(address, image);
      then(image);
    } catch {
      then(null);
    }
  };
  void load();
};

/**
 * The one context the stills are drawn on while any is waiting, with each kind's program; let go once
 * none is. They are drawn into `target`, a framebuffer of its own, so presenting the canvas never
 * clears a picture before it is read back.
 */
interface StillCanvas {
  gl: WebGL2RenderingContext;
  scene: boolean;
  programs: Map<BackdropScene | BackdropDither, WebGLProgram | null>;
  texture: WebGLTexture | null;
  target: WebGLRenderbuffer | null;
}
let stillCanvas: StillCanvas | undefined;
const letStillCanvasGo = (): void => {
  stillCanvas?.gl.getExtension("WEBGL_lose_context")?.loseContext();
  stillCanvas = undefined;
};
const stillCanvasFor = (scene: boolean): StillCanvas | undefined => {
  if (stillCanvas?.scene === scene && !stillCanvas.gl.isContextLost()) {
    return stillCanvas;
  }
  letStillCanvasGo();
  const gl = document
    .createElement("canvas")
    .getContext("webgl2", { alpha: !scene, antialias: false });
  if (gl === null) {
    return undefined;
  }
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  for (const side of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) {
    gl.texParameteri(gl.TEXTURE_2D, side, gl.CLAMP_TO_EDGE);
  }
  for (const filter of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) {
    gl.texParameteri(gl.TEXTURE_2D, filter, gl.LINEAR);
  }
  const target = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, target);
  gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer());
  gl.framebufferRenderbuffer(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.RENDERBUFFER,
    target
  );
  stillCanvas = { gl, scene, programs: new Map(), texture, target };
  return stillCanvas;
};

/**
 * Hands `then` the program of `kind` on `canvas` once it has linked: waited for a task at a time where
 * the browser can say when it has (KHR_parallel_shader_compile), rather than by asking at once.
 */
const withProgram = (
  canvas: StillCanvas,
  kind: BackdropScene | BackdropDither,
  then: (program: WebGLProgram | null) => void
): void => {
  const { gl, programs } = canvas;
  const kept = programs.get(kind);
  if (kept !== undefined) {
    then(kept);
    return;
  }
  const program = linking(gl, kind);
  const parallel = gl.getExtension("KHR_parallel_shader_compile");
  whenDone(
    () =>
      program === null ||
      parallel === null ||
      gl.isContextLost() ||
      gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR) === true,
    () => {
      const ready = linked(gl, program);
      programs.set(kind, ready);
      then(ready);
    }
  );
};

/** What a still picture is of: its look, its colours as the tokens resolve where it stands, and its size in canvas pixels. */
interface Still {
  kind: BackdropScene | BackdropDither;
  dither: { pattern: BackdropPattern; tone: BackdropTone };
  address: string | undefined;
  width: number;
  height: number;
  palette: readonly string[];
  flat: string;
}

/** Sets what `program` draws `still` with, as the running drawing's settled picture has it (Backdrop's `still`). */
const setUniforms = (
  canvas: StillCanvas,
  program: WebGLProgram,
  still: Still,
  image: HTMLImageElement | undefined
): void => {
  const { gl, scene } = canvas;
  const { width, height, dither } = still;
  const { picture } = KINDS[still.kind];
  const uniform = (name: string) => gl.getUniformLocation(program, name);
  gl.uniform3fv(
    uniform("u_palette"),
    still.palette.flatMap((colour) => {
      const [r, g, b] = rgbaOf(colour);
      return [r, g, b];
    })
  );
  const [r, g, b, a] = rgbaOf(still.flat);
  gl.uniform4f(uniform("u_flat"), r, g, b, a);
  gl.uniform1f(uniform("u_hasClear"), 0);
  gl.uniform2f(uniform("u_res"), width, height);
  gl.uniform1f(uniform("u_cell"), scene ? sceneCell : 1);
  gl.uniform1f(
    uniform("u_pattern"),
    scene ? 0 : ditherPatterns.indexOf(dither.pattern) + 1
  );
  gl.uniform1f(uniform("u_tone"), scene ? 0 : ditherTones.indexOf(dither.tone));
  gl.uniform1f(uniform("u_progress"), 0);
  gl.uniform1f(uniform("u_time"), startAt);
  gl.uniform2f(uniform("u_lamp"), width / 2, height / 2);
  if (picture === undefined || image === undefined) {
    return;
  }
  gl.bindTexture(gl.TEXTURE_2D, canvas.texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.LUMINANCE,
    gl.LUMINANCE,
    gl.UNSIGNED_BYTE,
    image
  );
  gl.uniform1i(uniform("u_image"), 0);
  gl.uniform2f(uniform("u_imageRes"), image.naturalWidth, image.naturalHeight);
  gl.uniform2f(uniform("u_focus"), picture.focus[0], picture.focus[1]);
  gl.uniform4f(
    uniform("u_grade"),
    picture.gamma,
    picture.gain,
    picture.sway,
    picture.drift
  );
  gl.uniform1f(uniform("u_invert"), picture.invert ? 1 : 0);
  gl.uniform1f(uniform("u_arrive"), 1);
};

/** The picture on `gl`'s canvas, `width` by `height`, as a PNG data address. */
const pictureOn = (
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  scene: boolean
): string => {
  const row = width * 4;
  const read = new Uint8Array(row * height);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, read);
  // Read from the foot up, as WebGL counts; a picture runs from the top. With alpha (a dither) the
  // channels come back multiplied by it, as a canvas keeps them, and a picture wants them without.
  const pixels = new ImageData(width, height);
  for (let line = 0; line < height; line += 1) {
    pixels.data.set(
      read.subarray((height - 1 - line) * row, (height - line) * row),
      line * row
    );
  }
  if (!scene) {
    for (let pixel = 0; pixel < pixels.data.length; pixel += 4) {
      const alpha = pixels.data[pixel + 3] ?? 255;
      if (alpha > 0 && alpha < 255) {
        for (let channel = pixel; channel < pixel + 3; channel += 1) {
          pixels.data[channel] = Math.round(
            ((pixels.data[channel] ?? 0) * 255) / alpha
          );
        }
      }
    }
  }
  const flat = document.createElement("canvas");
  flat.width = width;
  flat.height = height;
  flat.getContext("2d")?.putImageData(pixels, 0, 0);
  return flat.toDataURL("image/png");
};

/**
 * Draws `still` with the scene's picture `image` (none for a dither), and hands its picture to
 * `keepPicture`, read back only once the GPU has signalled that it has finished: read back at once,
 * the page would wait for the drawing itself, tens of ms where it is drawn in software.
 */
const drawWith = (
  still: Still,
  image: HTMLImageElement | undefined,
  keepPicture: KeepPicture
): void => {
  const canvas = stillCanvasFor(isScene(still.kind));
  if (canvas === undefined) {
    keepPicture(null);
    return;
  }
  withProgram(canvas, still.kind, (program) => {
    const { gl } = canvas;
    if (program === null || gl.isContextLost()) {
      keepPicture(null);
      return;
    }
    gl.useProgram(program);
    const position = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.renderbufferStorage(
      gl.RENDERBUFFER,
      canvas.scene ? gl.RGB8 : gl.RGBA8,
      still.width,
      still.height
    );
    gl.viewport(0, 0, still.width, still.height);
    setUniforms(canvas, program, still, image);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    whenDone(
      () =>
        fence === null ||
        gl.isContextLost() ||
        gl.getSyncParameter(fence, gl.SYNC_STATUS) === gl.SIGNALED,
      () => {
        gl.deleteSync(fence);
        keepPicture(
          gl.isContextLost()
            ? null
            : pictureOn(gl, still.width, still.height, canvas.scene)
        );
      }
    );
  });
};

/** Draws `still` and hands its picture to `keepPicture`; none where WebGL 2 won't draw it. */
const drawStill = (still: Still, keepPicture: KeepPicture): void => {
  if (still.address === undefined) {
    drawWith(still, undefined, keepPicture);
    return;
  }
  withScenePicture(still.address, (image) => {
    if (image === null) {
      keepPicture(null);
      return;
    }
    drawWith(still, image, keepPicture);
  });
};

/** Each still, by what it is of: its picture once drawn, and who waits on it until then. */
const stills = new Map<
  string,
  { picture?: string | null; waiting: KeepPicture[] }
>();
/** The stills still to draw, drawn one after another on the one context. */
const stillLine: { key: string; still: Still }[] = [];
let drawingStill = false;
const drawNextStill = (): void => {
  const next = stillLine.shift();
  drawingStill = next !== undefined;
  if (next === undefined) {
    letStillCanvasGo();
    return;
  }
  const drawStillDone = (picture: string | null) => {
    const entry = stills.get(next.key);
    const waiting = entry?.waiting ?? [];
    stills.set(next.key, { picture, waiting: [] });
    for (const keep of waiting) {
      keep(picture);
    }
    drawNextStill();
  };
  try {
    drawStill(next.still, drawStillDone);
  } catch {
    drawStillDone(null);
  }
};

/**
 * Hands `keepPicture` the settled picture of the shader backdrop `kind` on a box `width` by `height`
 * CSS pixels, in `palette` (the light's seven stops, night to paper) and `flat` (the flat tone's
 * colour), as a PNG data address: drawn the first time it is asked for, the page never waiting on
 * the GPU, and the same address for each box after; none where WebGL 2 won't draw it. Its context is
 * let go once no still waits.
 */
export const stillPictureOf = (
  kind: BackdropScene | BackdropDither,
  dither: { pattern: BackdropPattern; tone: BackdropTone },
  options: {
    scenes: string;
    small: boolean;
    width: number;
    height: number;
    palette: readonly string[];
    flat: string;
  },
  keepPicture: KeepPicture
): void => {
  const scene = isScene(kind);
  const ratio = scene ? 1 / sceneCell : 1;
  const still: Still = {
    kind,
    dither: scene ? { pattern: "bayer", tone: "light" } : dither,
    address:
      KINDS[kind].picture === undefined
        ? undefined
        : `${options.scenes}${kind}${options.small ? ".small" : ""}.jpg`,
    width: Math.max(1, Math.round(options.width * ratio)),
    height: Math.max(1, Math.round(options.height * ratio)),
    palette: options.palette,
    flat: options.flat,
  };
  const key = JSON.stringify(still);
  const entry = stills.get(key);
  if (entry?.picture !== undefined) {
    keepPicture(entry.picture);
    return;
  }
  if (entry !== undefined) {
    entry.waiting.push(keepPicture);
    return;
  }
  stills.set(key, { waiting: [keepPicture] });
  stillLine.push({ key, still });
  if (!drawingStill) {
    drawNextStill();
  }
};
