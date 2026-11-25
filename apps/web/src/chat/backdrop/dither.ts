import { drawn, nothingDrawn } from "./drawing.ts";
import type { DrawOptions, Drawing } from "./drawing.ts";

// #2503's dithers, drawn by WebGL on the backdrop's canvas: a field of
// silk, its light set as ink in 3px cells by Bayer's threshold, in one
// flat colour, the canvas's own (`color`), faint, so a full field reads
// as a tint. Its stops are Damsko's brand colours. Loaded only when a
// backdrop first comes into view (backdrop.tsx). From #2503's backdrop
// shader, its dithers alone: the product draws no scene.

/** The dithers #2503 draws, each a field of its own. */
export type DitherKind = "dusk" | "dots" | "door";

/**
 * A dither's ink, as #2503's tones number them in the shader: `mint`, one
 * flat colour, the canvas's own, faint; `aurora`, a run of the light's
 * greens by the field's own light, pine where it is fullest to lime at
 * its fringes, as a page that failed stands on.
 */
export type DitherTone = "mint" | "aurora";

const toneNumbers: Readonly<Record<DitherTone, number>> = {
  mint: 2,
  aurora: 7,
};

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

const KINDS: Record<DitherKind, { source: string }> = {
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
  kind: DitherKind
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

/** The linked program of `kind`, with the one quad it draws on; none where WebGL won't. */
const programOf = (
  gl: WebGLRenderingContext,
  kind: DitherKind
): WebGLProgram | null => linked(gl, linking(gl, kind));

/** A dither's frame: every CSS pixel through the silk, its clock slow, so fifteen a second shows all its motion. */
const ditherFrameMs = 1000 / 15;

/** How much slower a dither's clock runs than the silk's own. */
const ditherPace = 0.3;

/** Where the shader's clock starts, so the first picture is already a settled one. */
const startAt = 8;

/** How fast the door's lamp eases towards the pointer, per second. */
const lampPull = 1.6;

/** The light's seven stops, night to paper: the colours the runs are drawn in. */
const stops = ["night", "ink", "pine", "mint", "sea", "lime", "paper"].map(
  (stop) => `--damsko-brand-${stop}`
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

/** Draws the dither `kind` on `element`, in the pattern Bayer's 3px cells and its canvas's own colour, run and held by Backdrop. */
export const startDither = (
  element: HTMLCanvasElement,
  kind: DitherKind,
  options: DrawOptions,
  tone: DitherTone = "mint"
): Drawing => {
  // Kept between frames: it is drawn only every other frame or so, and a frame it isn't drawn on
  // would otherwise show nothing.
  const gl = element.getContext("webgl", {
    alpha: true,
    antialias: false,
    preserveDrawingBuffer: true,
  });
  if (gl === null) {
    return nothingDrawn;
  }
  const program = programOf(gl, kind);
  if (program === null) {
    return nothingDrawn;
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
  const hasClearAt = at("u_hasClear");
  const progressAt = at("u_progress");
  const { still } = options;
  const lamp = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
  const begun = performance.now();
  let last = begun;
  let frame = 0;
  let running = false;
  // The colours, read as they resolve here: they follow the theme. Read once, and again only when
  // the theme may have changed, never at every picture.
  let coloured = false;
  const recolour = (): void => {
    coloured = false;
  };
  const themeWatch = new MutationObserver(recolour);
  themeWatch.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-mode", "class", "style"],
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
  const fit = (): void => {
    const box = element.getBoundingClientRect();
    element.width = Math.max(1, Math.round(box.width));
    element.height = Math.max(1, Math.round(box.height));
    gl.viewport(0, 0, element.width, element.height);
  };
  const draw = (now: number): void => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    lamp.x += (lamp.tx - lamp.x) * Math.min(1, lampPull * dt);
    lamp.y += (lamp.ty - lamp.y) * Math.min(1, lampPull * dt);
    colour();
    gl.uniform1f(hasClearAt, 0);
    gl.uniform2f(res, element.width, element.height);
    gl.uniform1f(cellAt, 1);
    // Bayer's pattern (the shader's first) in its tone.
    gl.uniform1f(patternAt, 1);
    gl.uniform1f(toneAt, toneNumbers[tone]);
    gl.uniform1f(progressAt, 0);
    // With reduced motion the silk stands at one moment: the same picture however often it is drawn.
    const elapsed = still ? 0 : (now - begun) / 1000;
    gl.uniform1f(time, startAt + elapsed * ditherPace);
    gl.uniform2f(lampAt, lamp.x * element.width, (1 - lamp.y) * element.height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    drawn(element);
  };
  const loop = (now: number): void => {
    frame = requestAnimationFrame(loop);
    if (now - last >= ditherFrameMs) {
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
  // A context the browser takes away draws nothing more: the loop stops.
  const lost = (): void => {
    run(false);
  };
  element.addEventListener("webglcontextlost", lost);
  return {
    run,
    stop: () => {
      run(false);
      resized.disconnect();
      themeWatch.disconnect();
      scheme.removeEventListener("change", recolour);
      element.removeEventListener("webglcontextlost", lost);
      // A canvas that has left the page lets its context go now: a browser keeps only so many.
      if (!element.isConnected) {
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
    },
  };
};
