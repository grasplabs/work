// The glass door behind the sign-in page: the website's login door (grasplabs/website at b5135fa,
// src/client/lab/login-door.ts, with what it takes from shader-card.ts and login-look.ts), copied.
// Fluted glass over the whole page and, behind it, a wave of light in the light's colours (night,
// pine, mint, lime, paper at its crest) rolling slowly from left to right; every flute is a lens
// that squeezes a wide slice of the scene, so the wave is broken into bars. The pointer is a lamp
// behind the glass; without one it drifts on its own. Behind the words the light dims.
// The way out: chosen, the light gathers on that way in, a bright seam runs up and down the glass
// from it, the two doors slide apart from the seam, and the light beyond floods the page. With
// reduced motion: one still frame, and a chosen way leaves at once. Where WebGL can't run, nothing
// is drawn and the page's own night shows. The seven colours are the tokens light-night to
// light-paper, read from the page (the website's literals, which they equal).

/** What the page tells the door. Positions are CSS pixels from the canvas's top left. */
export interface Door {
  /** A way in was chosen (its box): plays the way out, then calls `done`, when the page may leave. */
  leave: (box: DOMRect, done: () => void) => void;
  /** The pointer, or `on: false` when it has left the page. */
  pointer: (x: number, y: number, on: boolean) => void;
  /** Stops drawing. */
  stop: () => void;
}

/** How long the way out takes, as the website's. */
const OPEN_MS = 1050;

const VERTEX = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const GLASS = `
precision highp float;
uniform vec2 u_res;
uniform vec3 u_palette[7];
uniform float u_clock;
uniform float u_dpr;
uniform vec2 u_lamp;
uniform float u_lit;
uniform vec2 u_target;
uniform float u_open;
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
vec3 palette(float t) {
  t = clamp(t, 0.0, 1.0) * 6.0;
  vec3 c = mix(u_palette[0], u_palette[1], clamp(t, 0.0, 1.0));
  c = mix(c, u_palette[2], clamp(t - 1.0, 0.0, 1.0));
  c = mix(c, u_palette[3], clamp(t - 2.0, 0.0, 1.0));
  c = mix(c, u_palette[4], clamp(t - 3.0, 0.0, 1.0));
  c = mix(c, u_palette[5], clamp(t - 4.0, 0.0, 1.0));
  return mix(c, u_palette[6], clamp(t - 5.0, 0.0, 1.0));
}
float grain(vec2 fc, float t) {
  return hash(fc + fract(t) * 97.0) - 0.5;
}
// The light behind the glass: one tall wave a screen wide, its crest swaying, rolling from left to
// right (about 13 seconds a crossing), with a soft glow around the crest.
float waveAt(vec2 p) {
  vec2 a = p / u_res.y;
  float sway = 0.2 * sin(a.y * 2.4 + u_clock * 0.35) + 0.12 * (noise(a * 2.0 + u_clock * 0.05) - 0.5);
  float u = p.x / u_res.x + sway - u_clock * 0.075;
  float crest = 0.5 + 0.5 * cos(6.28318 * u);
  return pow(crest, 5.0) + 0.16 * pow(crest, 1.6);
}
void main() {
  // The way out, from the clock (u_open, 0 to 1): the light gathers, the seam runs, the doors slide.
  float seamT = smoothstep(0.1, 0.34, u_open);
  float s = clamp((u_open - 0.3) / 0.7, 0.0, 1.0);
  float slide = s * s * s * (s * (6.0 * s - 15.0) + 10.0);
  float dx = gl_FragCoord.x - u_target.x;
  float gap = slide * max(u_target.x, u_res.x - u_target.x) * 1.04;
  float inGap = step(abs(dx), gap) * step(0.0001, slide);
  // Each door carries its glass with it: the flutes are those of the glass where it stood.
  float shift = sign(dx) * gap;
  float px = (gl_FragCoord.x - shift) / u_dpr;
  float width = 30.0;
  float f = fract(px / width);
  // Reeded glass breaks the light: each flute is a lens that shows a slice of the scene five times
  // its own width, squeezed, so the wave arrives as a row of bars, each with its own gradient.
  float centre = (floor(px / width) + 0.5) * width * u_dpr + shift;
  vec2 seen = vec2(centre + (f - 0.5) * width * u_dpr * 5.0, gl_FragCoord.y);
  float light = waveAt(seen);
  // The pointer is a lamp behind the glass.
  vec2 d = (seen - u_lamp) / u_res.y;
  light += exp(-dot(d, d) / (0.02 + 0.05 * seamT)) * 0.75 * u_lit;
  // The words stay readable: the light dims behind them, under the top bar and, beyond the
  // website (whose foot line stood on the light), over the foot.
  vec2 g = (v_uv - 0.5) * vec2(u_res.x / u_res.y, 1.0);
  float clear = smoothstep(0.14, 0.6, length(g * vec2(0.72, 1.0)));
  light *= mix(0.16, 1.0, clear) * (1.0 - 0.84 * smoothstep(0.82, 0.94, v_uv.y)) * (1.0 - 0.84 * smoothstep(0.24, 0.07, v_uv.y));
  light = clamp(light, 0.0, 1.0);
  vec3 c = palette(0.03 + light * 0.97);
  // The flute itself: round shade, a dark seam where two meet, a thin highlight on its edge.
  c *= 0.82 + 0.24 * sin(f * 3.14159);
  c *= 1.0 - 0.3 * smoothstep(0.07, 0.0, f);
  c += vec3(1.0) * smoothstep(0.93, 0.99, f) * (0.015 + light * 0.1);
  // The doors' edges and the light beyond (the way out).
  if (inGap > 0.0 || u_open > 0.0) {
    float edge = abs(dx) - gap;
    float reach = seamT * u_res.y * 1.15;
    float line = exp(-abs(dx) / (1.6 * u_dpr)) * step(abs(gl_FragCoord.y - u_target.y), reach);
    float halo = exp(-abs(dx) / (26.0 * u_dpr)) * step(abs(gl_FragCoord.y - u_target.y), reach);
    c += vec3(0.86, 1.0, 0.9) * (line * 0.95 + halo * 0.22) * seamT * (1.0 - slide);
    c += palette(0.86) * 0.55 * slide * exp(-max(edge, 0.0) / (0.16 * u_res.x));
    c += vec3(1.0) * 0.5 * slide * exp(-max(edge, 0.0) / (2.0 * u_dpr)) * step(0.0, edge);
    vec3 through = palette(0.9 + 0.1 * exp(-abs(dx) / (0.3 * u_res.x)));
    through = mix(through, u_palette[6], smoothstep(0.35, 1.0, slide));
    through *= 1.0 - 0.14 * exp(edge / (34.0 * u_dpr)) * (1.0 - slide);
    c = mix(c, through, inGap);
  }
  c += grain(gl_FragCoord.xy, u_clock) * 0.028;
  gl_FragColor = vec4(c, 1.0);
}`;

/** The seven colours, night to paper: the tokens the door is drawn in. */
const stops = ["night", "ink", "pine", "mint", "sea", "lime", "paper"].map(
  (stop) => `--grasp-light-${stop}`
);

/** Nothing to do: every part of a door that cannot draw. */
const nothing = () => {
  // Nothing to do.
};

/** A door that draws nothing: a chosen way leaves at once. */
export const idleDoor: Door = {
  leave: (_box, done) => {
    done();
  },
  pointer: nothing,
  stop: nothing,
};

/** A CSS colour as sRGB, 0 to 1, as a 2D canvas paints it. */
const rgbOf = (colour: string): number[] => {
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
  return [r / 255, g / 255, b / 255];
};

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

/** The door's program, on the two triangles it draws on; none where WebGL won't. */
const programOf = (gl: WebGLRenderingContext): WebGLProgram | null => {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, GLASS);
  const made = gl.createProgram();
  if (vertex === null || fragment === null || made === null) {
    return null;
  }
  gl.attachShader(made, vertex);
  gl.attachShader(made, fragment);
  gl.linkProgram(made);
  if (gl.getProgramParameter(made, gl.LINK_STATUS) !== true) {
    return null;
  }
  gl.useProgram(made);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW
  );
  const position = gl.getAttribLocation(made, "a_pos");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  return made;
};

/** Eases a value towards its target at `rate` a second, whatever the frame rate. */
const ease = (value: number, target: number, rate: number, dt: number) =>
  value + (target - value) * (1 - Math.exp(-rate * dt));

/** Sizes a canvas to its box (at most 2 device pixels a CSS pixel); returns that ratio. */
const fit = (canvas: HTMLCanvasElement) => {
  const box = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio, 2);
  canvas.width = Math.max(1, Math.round(box.width * ratio));
  canvas.height = Math.max(1, Math.round(box.height * ratio));
  return ratio;
};

/** Draws the door on `canvas` until stopped. `calm`: one still frame, and the way out at once. */
export const startDoor = (canvas: HTMLCanvasElement, calm: boolean): Door => {
  const gl = canvas.getContext("webgl", { alpha: false, antialias: false });
  if (gl === null) {
    return idleDoor;
  }
  const made = programOf(gl);
  if (made === null) {
    return idleDoor;
  }
  const at = (name: string) => gl.getUniformLocation(made, name);
  const style = getComputedStyle(canvas);
  gl.uniform3fv(
    at("u_palette"),
    stops.flatMap((stop) => rgbOf(style.getPropertyValue(stop).trim()))
  );
  let ratio = 1;
  let alive = true;
  // The lamp: where it is, where it is heading (the pointer, or its own slow path).
  const lamp = { held: false, set: false, tx: 0, ty: 0, x: 0, y: 0 };
  const way = { x: 0, y: 0 };
  const opening = { open: 0, start: 0, done: nothing };
  let last = performance.now();

  const paint = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const box = canvas.getBoundingClientRect();
    if (!lamp.held) {
      const t = now / 1000;
      lamp.tx = box.width * (0.5 + 0.34 * Math.cos(t * 0.23));
      lamp.ty = box.height * (0.5 + 0.28 * Math.sin(t * 0.31));
    }
    if (!lamp.set) {
      lamp.x = box.width / 2;
      lamp.y = box.height / 2;
      lamp.set = true;
    }
    // The lamp follows fastest while the door opens, fast while it is held, slowly otherwise.
    const heldPull = lamp.held ? 7 : 1.2;
    const pull = opening.open > 0 ? 14 : heldPull;
    lamp.x = ease(lamp.x, lamp.tx, pull, dt);
    lamp.y = ease(lamp.y, lamp.ty, pull, dt);
    if (opening.open > 0) {
      // The light gathers on the chosen way.
      lamp.tx = way.x;
      lamp.ty = way.y;
      lamp.held = true;
    }
    if (opening.start > 0) {
      opening.open = Math.min(1, (now - opening.start) / OPEN_MS);
      if (opening.open === 1) {
        opening.done();
        opening.done = nothing;
      }
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(at("u_res"), canvas.width, canvas.height);
    gl.uniform1f(at("u_dpr"), ratio);
    gl.uniform1f(at("u_clock"), calm ? 4 : now / 1000);
    gl.uniform2f(at("u_lamp"), lamp.x * ratio, canvas.height - lamp.y * ratio);
    gl.uniform1f(at("u_lit"), 1 + 1.6 * Math.min(1, opening.open / 0.3));
    gl.uniform2f(at("u_target"), way.x * ratio, canvas.height - way.y * ratio);
    gl.uniform1f(at("u_open"), opening.open);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  const resize = new ResizeObserver(() => {
    ratio = fit(canvas);
    if (calm) {
      paint(performance.now());
    }
  });
  resize.observe(canvas);
  ratio = fit(canvas);
  const tick = (now: number) => {
    if (!alive) {
      return;
    }
    paint(now);
    requestAnimationFrame(tick);
  };
  if (calm) {
    paint(performance.now());
  } else {
    requestAnimationFrame(tick);
  }

  return {
    leave: (box, done) => {
      if (calm) {
        done();
        return;
      }
      const here = canvas.getBoundingClientRect();
      way.x = box.left - here.left + box.width / 2;
      way.y = box.top - here.top + box.height / 2;
      opening.start = performance.now();
      // Called once: by the frame that ends the opening, or by the timer if frames stop.
      let called = false;
      const once = () => {
        if (!called) {
          called = true;
          done();
        }
      };
      opening.done = once;
      window.setTimeout(once, OPEN_MS + 200);
    },
    pointer: (x, y, on) => {
      if (opening.open > 0) {
        return;
      }
      lamp.held = on;
      if (on) {
        lamp.tx = x;
        lamp.ty = y;
      }
    },
    stop: () => {
      alive = false;
      resize.disconnect();
    },
  };
};
