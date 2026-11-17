import { ms } from "../tokens/tokens.values";
import { drawn, nothingDrawn } from "./drawing";
import type { DrawOptions, Drawing } from "./drawing";
import type {
  BackdropDither,
  BackdropPattern,
  BackdropScene,
  BackdropTone,
} from "./look";
import { ditherPatterns, ditherTones, isScene } from "./look";

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

/**
 * The scenes' shared GLSL (uniforms, the silk, the palette, Bayer's threshold) and each scene's
 * grade, for a screen of the site that draws the scenes its own way: the docs' idle screen
 * (site/behaviour/idle-screen.ts), which morphs one into the next. Nothing here draws.
 */
export const sceneCommon = COMMON;

/** How the scene `kind`'s picture is cropped and graded, as Backdrop draws it. */
export const scenePicture = (kind: BackdropScene): Picture | undefined =>
  KINDS[kind].picture;

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

/**
 * How long a frame is. A scene is a ninth of the field's pixels and cheap, at twenty a second; a
 * dither is every CSS pixel of it through the silk, and its clock runs slow, so fifteen a second
 * shows all of its motion at half the cost of thirty.
 */
const sceneFrameMs = 1000 / 20;
const ditherFrameMs = 1000 / 15;

/** How large a scene's cell is, in CSS pixels, as Capy's dither's is. */
const sceneCell = 3;

/** How much slower a dither's clock runs than a scene's. */
const ditherPace = 0.3;

/** Where the shader's clock starts, so the first picture is already a settled one. */
const startAt = 8;

/** How much further the silk turns over the whole of `progress`, in the shader's seconds. */
const progressTurn = 6;

/** How fast the door's lamp eases towards the pointer, per second. */
const lampPull = 1.6;

/** The light's seven stops, night to paper: the tokens the scenes and the runs are drawn in. */
const stops = ["night", "ink", "pine", "mint", "sea", "lime", "paper"].map(
  (stop) => `--grasp-light-${stop}`
);

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

/** Draws the shader backdrop `kind` on `element` (a dither with its pattern and tone), run and held by Backdrop. */
export const startShader = (
  element: HTMLCanvasElement,
  kind: BackdropScene | BackdropDither,
  dither: { pattern: BackdropPattern; tone: BackdropTone },
  options: DrawOptions & {
    /** Where the scene pictures are served from: a folder URL ending in a slash. */
    scenes: string;
    /** A small window (a preview tile): the small picture (<kind>.small.jpg), a fifth the weight. */
    small?: boolean;
  }
): Drawing => {
  const nothing = nothingDrawn;
  const scene = isScene(kind);
  const { picture } = KINDS[kind];
  // As the shader numbers them: patterns from 1, none for a scene.
  const pattern = scene ? 0 : ditherPatterns.indexOf(dither.pattern) + 1;
  const tone = scene ? 0 : ditherTones.indexOf(dither.tone);
  // Kept between frames: it is drawn only every other frame or so, and a frame it isn't drawn on
  // would otherwise show nothing.
  const gl = element.getContext("webgl", {
    alpha: !scene,
    antialias: false,
    preserveDrawingBuffer: true,
  });
  if (gl === null) {
    return nothing;
  }
  const program = programOf(gl, kind);
  if (program === null) {
    return nothing;
  }
  const at = (name: string) => gl.getUniformLocation(program, name);
  const res = at("u_res");
  const time = at("u_time");
  const lampAt = at("u_lamp");
  const cellAt = at("u_cell");
  const patternAt = at("u_pattern");
  const toneAt = at("u_tone");
  const paletteAt = at("u_palette");
  const flatAt = at("u_flat");
  const clearAt = at("u_clear");
  const hasClearAt = at("u_hasClear");
  const progressAt = at("u_progress");
  // A scene's picture: night until it has loaded, then its light.
  const loading = picture === undefined ? undefined : new Image();
  if (picture !== undefined) {
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
    gl.uniform1f(at("u_arrive"), 0);
  }
  const { still } = options;
  // A scene: one canvas pixel to a cell. A dither: one to a CSS pixel, whatever the screen's
  // density, so a sharp screen costs no more. Both scaled up crisp.
  const ratio = scene ? 1 / sceneCell : 1;
  const pace = scene ? 1 : ditherPace;
  const frameMs = scene ? sceneFrameMs : ditherFrameMs;
  const lamp = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
  const begun = performance.now();
  let last = begun;
  let frame = 0;
  // The frame of a scene's picture coming up, while it does.
  let rising = 0;
  let running = false;
  /**
   * The colours, read from the tokens as they resolve here: they follow the theme. Read once, and
   * again only when the theme may have changed (the document's attributes, the system's scheme),
   * never at every picture: reading the computed style each time cost a frame of its own.
   */
  let coloured = false;
  const recolour = (): void => {
    coloured = false;
  };
  const themeWatch = new MutationObserver(recolour);
  themeWatch.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class", "style"],
  });
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", recolour);
  const colour = (): void => {
    if (coloured) {
      return;
    }
    coloured = true;
    const style = getComputedStyle(element);
    const palette = stops.flatMap((stop) => {
      const [r, g, b] = rgbaOf(style.getPropertyValue(stop).trim());
      return [r, g, b];
    });
    gl.uniform3fv(paletteAt, palette);
    const [r, g, b, a] = rgbaOf(style.color);
    gl.uniform4f(flatAt, r, g, b, a);
  };
  /** What stands on a scene, in the canvas's pixels from its foot. */
  const keepClear = (): void => {
    // Only a preview tile keeps its words' ground dark; a full scene dims softly round the middle,
    // as the product's Chat page does, with no band under the question and the box.
    const kept = scene && options.small === true ? options.clear() : undefined;
    if (kept === undefined || kept.width === 0) {
      gl.uniform1f(hasClearAt, 0);
      return;
    }
    const box = element.getBoundingClientRect();
    const across = element.width / Math.max(1, box.width);
    const down = element.height / Math.max(1, box.height);
    gl.uniform4f(
      clearAt,
      (kept.left - box.left) * across,
      (box.bottom - kept.bottom) * down,
      (kept.right - box.left) * across,
      (box.bottom - kept.top) * down
    );
    gl.uniform1f(hasClearAt, 1);
  };
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
    colour();
    keepClear();
    gl.uniform2f(res, element.width, element.height);
    gl.uniform1f(cellAt, 1 / ratio);
    gl.uniform1f(patternAt, pattern);
    gl.uniform1f(toneAt, tone);
    const progress = Math.min(1, Math.max(0, options.progress()));
    gl.uniform1f(progressAt, progress);
    // The silk's own drift, and a stretch more for the way the page has gone: scrolling turns it.
    // With reduced motion the silk stands at one moment: the same picture however often it is drawn
    // (resized, a scene's picture arriving).
    const elapsed = still ? 0 : (now - begun) / 1000;
    gl.uniform1f(time, startAt + elapsed * pace + progress * progressTurn);
    // The lamp in the canvas's pixels, its y from the foot, as WebGL counts.
    gl.uniform2f(lampAt, lamp.x * element.width, (1 - lamp.y) * element.height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    drawn(element);
  };
  const loop = (now: number): void => {
    frame = requestAnimationFrame(loop);
    if (now - last >= frameMs) {
      draw(now);
    }
  };
  const point = (event: PointerEvent): void => {
    const box = element.getBoundingClientRect();
    lamp.tx = (event.clientX - box.left) / box.width;
    lamp.ty = (event.clientY - box.top) / box.height;
  };
  // Sizing the canvas clears it: drawn again at once, so no frame is bare while what it fills is
  // resized (the sidebar folding, say).
  const resized = new ResizeObserver(() => {
    fit();
    draw(performance.now());
  });
  resized.observe(element);
  fit();
  if (loading !== undefined) {
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
      // It comes up from night over duration-mark, as arrive.in fades content in; with reduced
      // motion it is there at once. Drawn frame by frame until it has, even while held or still.
      const arrivedAt = performance.now();
      const arriveAt = at("u_arrive");
      const rise = (now: number): void => {
        const done = still
          ? 1
          : Math.min(1, (now - arrivedAt) / ms.durationMark);
        gl.uniform1f(arriveAt, done);
        draw(now);
        if (done < 1) {
          rising = requestAnimationFrame(rise);
        }
      };
      rise(arrivedAt);
    });
    loading.src = `${options.scenes}${kind}${options.small === true ? ".small" : ""}.jpg`;
  }
  draw(begun);
  const run = (on: boolean): void => {
    if (still || on === running) {
      return;
    }
    running = on;
    if (on) {
      frame = requestAnimationFrame(loop);
      window.addEventListener("pointermove", point);
    } else {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", point);
    }
  };
  // A context the browser takes away (the GPU reset, too many contexts) draws nothing more: the
  // loop stops rather than drawing into nothing at every frame.
  const lost = (): void => {
    run(false);
    cancelAnimationFrame(rising);
  };
  element.addEventListener("webglcontextlost", lost);
  return {
    run,
    stop: () => {
      run(false);
      resized.disconnect();
      themeWatch.disconnect();
      scheme.removeEventListener("change", recolour);
      cancelAnimationFrame(rising);
      element.removeEventListener("webglcontextlost", lost);
      // A picture still on its way is let go.
      loading?.removeAttribute("src");
      // A canvas that has left the page lets its context go now, not when it is collected: a
      // browser keeps only so many (about 16) and loses the oldest, a backdrop still in view, when
      // more are made, as stepping through looks does (each look a canvas of its own). A canvas
      // still in the page keeps it: the drawing may start on it again.
      if (!element.isConnected) {
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
    },
  };
};
