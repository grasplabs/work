// An App card's scene, drawn once as a still picture by one WebGL fragment shader, each cell a
// crisp square. Ruben's backdrop scenes (the product repo, grasp/field/shader-field.tsx), as he
// made them, as far as the cards draw them (ground.tsx): a picture (cliffs, wave, aurora, starry,
// fuji, wanderer), kept as its light alone (each from a work in the public domain, named where it
// is listed below, served as `<scenes><kind>.small.jpg`), dithered all over from night to lime: every
// cell one of two neighbouring greens by Bayer's threshold, so no cell stands out alone, with the
// silk's light drifting through it. Damsko's change, none to the look: the greens are read from
// the tokens (brand-night to brand-paper), not written in. Where WebGL 2 can't run, nothing is
// drawn. Decorative only. Loaded only once a card's ground first comes into view.
import type { Scene } from "./scenes.ts";

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
// A scene's picture: its light, its size, the part of it kept when it is
// cropped to fill the field, and its grade (gamma, gain, sway, drift).
uniform sampler2D u_image;
uniform vec2 u_imageRes;
uniform vec2 u_focus;
uniform vec4 u_grade;
// 1 where the picture is drawn as its negative.
uniform float u_invert;
// The light's seven stops, night to paper, read from the tokens (brand-night to brand-paper).
uniform vec3 u_palette[7];
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
`;

/** A scene's picture and how it is graded. */
interface Picture {
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
  float light = silk(p * 1.1, u_time * 0.7);
  tone *= 1.0 + u_grade.w * (smoothstep(0.25, 0.75, light) - 0.5) * 2.0;
  vec2 mid = (v_uv - vec2(0.5, 0.53)) * vec2(min(aspect, 1.8) * 0.8, 1.9);
  tone *= mix(0.42, 1.0, smoothstep(0.12, 0.62, length(mid)));
  const float steps = 5.0;
  float q = floor(clamp(tone, 0.0, 1.0) * steps + bayer8(gl_FragCoord.xy)) / steps;
  gl_FragColor = vec4(palette(q * 0.86), 1.0);
}`;

const PICTURES: Record<Scene, Picture> = {
  // The Cosmic Cliffs of the Carina Nebula (NASA, ESA, CSA, STScI; James
  // Webb Space Telescope, 2022): ridges of gas under a field of stars.
  cliffs: {
    focus: [0.5, 0.5],
    gamma: 0.85,
    gain: 1.2,
    invert: false,
    sway: 0.014,
    drift: 0.4,
  },
  // The Great Wave off Kanagawa (Katsushika Hokusai, about 1831), as its
  // negative: the sky is night and the wave's body carries the light.
  wave: {
    focus: [0.35, 0.45],
    gamma: 1.5,
    gain: 1.15,
    invert: true,
    sway: 0.02,
    drift: 0.3,
  },
  // A northern light from orbit, over Manicouagan's ring (NASA).
  aurora: {
    focus: [0.5, 0.4],
    gamma: 1.25,
    gain: 1.25,
    invert: false,
    sway: 0.018,
    drift: 0.45,
  },
  // The Starry Night (Vincent van Gogh, 1889).
  starry: {
    focus: [0.5, 0.35],
    gamma: 1.6,
    gain: 1.3,
    invert: false,
    sway: 0.022,
    drift: 0.3,
  },
  // Fine Wind, Clear Morning (Katsushika Hokusai, about 1831): Fuji under
  // a mackerel sky.
  fuji: {
    focus: [0.6, 0.5],
    gamma: 1.7,
    gain: 1.1,
    invert: false,
    sway: 0.012,
    drift: 0.35,
  },
  // Wanderer above the Sea of Fog (Caspar David Friedrich, about 1818).
  wanderer: {
    focus: [0.5, 0.42],
    gamma: 1.8,
    gain: 1.1,
    invert: false,
    sway: 0.012,
    drift: 0.45,
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

/** The scenes' program, sent to be linked, not yet asked whether it has: asking waits for it. */
const linking = (gl: WebGLRenderingContext): WebGLProgram | null => {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, COMMON + PICTURE);
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

/** How large a cell is, in CSS pixels, as Capy's dither's is. */
const cell = 3;

/** Where the shader's clock starts, so the first picture is already a settled one. */
const startAt = 8;

/** A CSS colour as sRGB, 0 to 1, as a 2D canvas paints it. */
const rgbOf = (() => {
  const known = new Map<string, readonly [number, number, number]>();
  return (colour: string): readonly [number, number, number] => {
    const kept = known.get(colour);
    if (kept !== undefined) {
      return kept;
    }
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (ctx === null) {
      return [0, 0, 0];
    }
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
    const found = [r / 255, g / 255, b / 255] as const;
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
 * The one context the stills are drawn on while any is waiting, with the scenes' program; let go
 * once none is. They are drawn into `target`, a framebuffer of its own, so presenting the canvas
 * never clears a picture before it is read back.
 */
interface StillCanvas {
  gl: WebGL2RenderingContext;
  /** The program once it has linked (null where it didn't); undefined until then. */
  program: WebGLProgram | null | undefined;
  texture: WebGLTexture | null;
  target: WebGLRenderbuffer | null;
}
let stillCanvas: StillCanvas | undefined;
const letStillCanvasGo = (): void => {
  stillCanvas?.gl.getExtension("WEBGL_lose_context")?.loseContext();
  stillCanvas = undefined;
};
const stillCanvasNow = (): StillCanvas | undefined => {
  if (stillCanvas !== undefined && !stillCanvas.gl.isContextLost()) {
    return stillCanvas;
  }
  letStillCanvasGo();
  const gl = document
    .createElement("canvas")
    .getContext("webgl2", { alpha: false, antialias: false });
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
  stillCanvas = { gl, program: undefined, texture, target };
  return stillCanvas;
};

/**
 * Hands `then` the program on `canvas` once it has linked: waited for a task at a time where the
 * browser can say when it has (KHR_parallel_shader_compile), rather than by asking at once.
 */
const withProgram = (
  canvas: StillCanvas,
  then: (program: WebGLProgram | null) => void
): void => {
  const { gl } = canvas;
  if (canvas.program !== undefined) {
    then(canvas.program);
    return;
  }
  const program = linking(gl);
  const parallel = gl.getExtension("KHR_parallel_shader_compile");
  whenDone(
    () =>
      program === null ||
      parallel === null ||
      gl.isContextLost() ||
      gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR) === true,
    () => {
      const ready = linked(gl, program);
      canvas.program = ready;
      then(ready);
    }
  );
};

/** What a still picture is of: its scene, its colours as the tokens resolve where it stands, and its size in canvas pixels. */
interface Still {
  scene: Scene;
  address: string;
  width: number;
  height: number;
  palette: readonly string[];
}

/** Sets what `program` draws `still` with: the drawing's settled picture, at `startAt`. */
const setUniforms = (
  canvas: StillCanvas,
  program: WebGLProgram,
  still: Still,
  image: HTMLImageElement
): void => {
  const { gl } = canvas;
  const picture = PICTURES[still.scene];
  const uniform = (name: string) => gl.getUniformLocation(program, name);
  gl.uniform3fv(uniform("u_palette"), still.palette.flatMap(rgbOf));
  gl.uniform2f(uniform("u_res"), still.width, still.height);
  gl.uniform1f(uniform("u_time"), startAt);
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
};

/** The picture on `gl`'s canvas, `width` by `height`, as a PNG data address. */
const pictureOn = (
  gl: WebGL2RenderingContext,
  width: number,
  height: number
): string => {
  const row = width * 4;
  const read = new Uint8Array(row * height);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, read);
  // Read from the foot up, as WebGL counts; a picture runs from the top.
  const pixels = new ImageData(width, height);
  for (let line = 0; line < height; line += 1) {
    pixels.data.set(
      read.subarray((height - 1 - line) * row, (height - line) * row),
      line * row
    );
  }
  const flat = document.createElement("canvas");
  flat.width = width;
  flat.height = height;
  flat.getContext("2d")?.putImageData(pixels, 0, 0);
  return flat.toDataURL("image/png");
};

/**
 * Draws `still` with its scene's picture `image`, and hands its picture to `keepPicture`, read back
 * only once the GPU has signalled that it has finished: read back at once, the page would wait for
 * the drawing itself, tens of ms where it is drawn in software.
 */
const drawWith = (
  still: Still,
  image: HTMLImageElement,
  keepPicture: KeepPicture
): void => {
  const canvas = stillCanvasNow();
  if (canvas === undefined) {
    keepPicture(null);
    return;
  }
  withProgram(canvas, (program) => {
    const { gl } = canvas;
    if (program === null || gl.isContextLost()) {
      keepPicture(null);
      return;
    }
    gl.useProgram(program);
    const position = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGB8, still.width, still.height);
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
          gl.isContextLost() ? null : pictureOn(gl, still.width, still.height)
        );
      }
    );
  });
};

/** Draws `still` and hands its picture to `keepPicture`; none where WebGL 2 won't draw it. */
const drawStill = (still: Still, keepPicture: KeepPicture): void => {
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
 * Hands `keepPicture` the settled picture of `scene` on a box `width` by `height` CSS pixels, in
 * `palette` (the light's seven stops, night to paper), as a PNG data address: drawn the first time
 * it is asked for, the page never waiting on the GPU, and the same address for each box after;
 * none where WebGL 2 won't draw it. Its context is let go once no still waits.
 */
export const stillPictureOf = (
  scene: Scene,
  options: {
    /** Where the scenes' pictures are served. */
    scenes: string;
    width: number;
    height: number;
    palette: readonly string[];
  },
  keepPicture: KeepPicture
): void => {
  const still: Still = {
    scene,
    // The small picture, as the reference's cards draw theirs: a card is a small window.
    address: `${options.scenes}${scene}.small.jpg`,
    width: Math.max(1, Math.round(options.width / cell)),
    height: Math.max(1, Math.round(options.height / cell)),
    palette: options.palette,
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
