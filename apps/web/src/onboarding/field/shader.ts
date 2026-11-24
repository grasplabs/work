// Stephen's field, as one WebGL fragment shader drawn on two canvases.
// Stephen is never shown as a figure in the setup: he is the light behind
// the page. Each fragment is one cell of the page's pixel grid (the canvas
// is as many pixels as the window has cells, scaled up crisp), and every
// cell is either left clear or set to one flat colour by the system's
// ordered dither (Bayer's 4 by 4), as the flags and Damsko's dithers are.
//
// Layer 0, behind the page: where he rests on this screen (`u_rest`, each
// screen its own place and tempo), a light that follows the pointer, and
// the light he gathers round each thing he holds (`u_holds`).
// Layer 1, over the page, only while he carries the page to its next
// screen: a first front spreads from what was pressed and shows the picture
// he took from it (a flag), his own light chases it and covers the window,
// the page turns under him, and he drains away toward the new screen's
// title.

export const VERTEX = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

export const FRAGMENT = `
precision highp float;
uniform vec2 u_cells;
uniform float u_cell;
uniform float u_time;
uniform float u_layer;
// The four tones of his resting light, faintest first, as this page resolves them.
uniform vec3 u_amb[4];
// The light's seven stops, night to paper (brand-night to brand-paper).
uniform vec3 u_palette[7];
// How far along the stops his cover runs: from, to.
uniform vec2 u_tones;
// Where he rests: centre x, centre y, reach across, reach down, in CSS pixels.
uniform vec4 u_rest;
// His mood on this screen: seed, tempo, strength.
uniform vec3 u_mood;
// The pointer: x, y, and how much of its light is there.
uniform vec3 u_pointer;
// What he attends to: its box (x, y, width, height), and how much he has gathered.
// What he holds: up to four elements at once, each its own light that builds up while he is on it
// and fades where it is when he leaves. Each one's box (x, y, width, height), and how it looks:
// how much of it there is, 0 round a thing to press or 1 behind words, and its corner.
uniform vec4 u_holds[4];
uniform vec3 u_holdLooks[4];
// The carry: 0 none, 1 spreading, 2 holding, 3 draining.
uniform float u_phase;
// The box it spreads from, the box it drains toward.
uniform vec4 u_from;
uniform vec4 u_toward;
// How far each front has come, in CSS pixels: the picture's, his own, and what is left of him.
uniform vec3 u_fronts;
// The picture he took: its three colours, how they lie (kind, split, split), and whether there is one.
uniform vec3 u_flag[3];
uniform vec3 u_flagShape;
uniform float u_flagOn;

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
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}
// Light as silk: noise folded through itself twice, drifting.
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
// The ordered dither's threshold for a cell, 0 to 1: Bayer's 4 by 4.
float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2.0 + a.y * a.y * 0.75);
}
float bayer4(vec2 a) {
  return bayer2(0.5 * a) * 0.25 + bayer2(a) + 0.03125;
}
// How far a point is outside a box with rounded corners (inside: below zero).
float roundBox(vec2 p, vec4 rect, float radius) {
  vec2 half_ = rect.zw * 0.5;
  float r = min(radius, min(half_.x, half_.y));
  vec2 q = abs(p - (rect.xy + half_)) - half_ + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float box(vec2 p, vec4 rect) {
  return roundBox(p, rect, 0.0);
}

// Which of the picture's three colours stands at a point on it, as flags.ts says it.
float flagAt(vec2 uv) {
  if (u_flagShape.x > 1.5) {
    vec2 c = (uv - 0.5) * 2.0;
    float cross_ = min(abs(c.x) / 0.1, abs(c.y) / 0.2);
    float edge = min(abs(c.x) / 0.17, abs(c.y) / 0.34);
    float diagonal = min(abs(c.x - c.y), abs(c.x + c.y));
    if (cross_ < 1.0) return 2.0;
    if (edge < 1.0) return 1.0;
    if (diagonal < 0.06) return 2.0;
    if (diagonal < 0.2) return 1.0;
    return 0.0;
  }
  float along = u_flagShape.x > 0.5 ? uv.x : uv.y;
  return along < u_flagShape.y ? 0.0 : (along < u_flagShape.z ? 1.0 : 2.0);
}
// The picture, filling the window: its colours, waving, each cell its colour or its shade.
vec3 flag(vec2 p, vec2 window, float b) {
  vec2 uv = p / window;
  float phase = uv.x * 8.2 - u_time * 5.5;
  uv.y = clamp(uv.y + sin(phase) * 0.03, 0.0, 1.0);
  float which = flagAt(uv);
  vec3 own = which < 0.5 ? u_flag[0] : (which < 1.5 ? u_flag[1] : u_flag[2]);
  // Mostly its own colour, the shade only in the folds: at this size an even dither would read as a checker.
  float light = 0.78 + 0.34 * cos(phase) - 0.1 * (uv.x + uv.y) * 0.5;
  return b > light ? own * 0.8 : own;
}

void main() {
  vec2 at = floor(gl_FragCoord.xy);
  // CSS pixels from the window's top left, at the cell's middle.
  vec2 cellAt = vec2(at.x, u_cells.y - 1.0 - at.y);
  vec2 p = (cellAt + 0.5) * u_cell;
  vec2 window = u_cells * u_cell;
  float b = bayer4(cellAt);
  float seed = u_mood.x;
  float t = u_time * u_mood.y;

  if (u_layer < 0.5) {
    float flow = silk(p / 540.0 + seed, t);
    float level = 0.0;
    // Where he rests on this screen: a wide, soft light, never a shape.
    vec2 away = (p - u_rest.xy) / u_rest.zw;
    float rest = exp(-dot(away, away) * 1.6);
    level += rest * u_mood.z * (0.2 + 1.5 * flow);
    // The pointer's light, a moment behind the pointer.
    vec2 toPointer = p - u_pointer.xy;
    float near = exp(-dot(toPointer, toPointer) / (2.0 * 170.0 * 170.0));
    level += u_pointer.z * near * (0.12 + 0.42 * flow);
    // Under the page's column of words he keeps low, so they read; beside it he is all there.
    level *= mix(0.4, 1.0, smoothstep(300.0, 540.0, abs(p.x - window.x * 0.5)));
    // Where there is little of him there is none: the page stays clean, no stray cells.
    level = max(level - 0.07, 0.0) * 1.08;
    // What he holds. Round a thing to press, he is a fine line of light on its edge with a soft
    // light round it that moves along it, growing outward as he builds up; its middle stays clear.
    // Behind words, he is a faint light with no edge.
    float round_ = silk(p / 190.0 + vec2(t * 0.35, -t * 0.28) + seed, t * 2.4);
    // Inside a thing to press there is none of him: its own surface stays as it is, the same all
    // over, whatever lies behind the page. Only its edge carries his line.
    float clear = 1.0;
    for (int i = 0; i < 4; i++) {
      vec3 look = u_holdLooks[i];
      if (look.x < 0.004 || look.y > 0.5) continue;
      clear = min(clear, step(0.0, roundBox(p, u_holds[i], look.z)));
    }
    level *= clear;
    for (int i = 0; i < 4; i++) {
      vec3 look = u_holdLooks[i];
      if (look.x < 0.004) continue;
      float d = roundBox(p, u_holds[i], look.z);
      // The line sits on the edge and just outside it, never inward.
      float line = exp(-abs(d - 1.5) / 2.2) * 0.8 * step(-1.0, d);
      float halo = exp(-max(d, 0.0) / (6.0 + 26.0 * look.x)) * step(0.0, d) * (0.1 + 0.6 * round_);
      float behind = exp(-max(d, 0.0) / 90.0) * (0.1 + 0.3 * flow);
      level += look.x * mix(line + halo, behind, look.y);
    }

    float q = floor(clamp(level, 0.0, 1.0) * 4.0 + b);
    if (q < 1.0) {
      gl_FragColor = vec4(0.0);
      return;
    }
    vec3 colour = q < 2.0 ? u_amb[0] : (q < 3.0 ? u_amb[1] : (q < 4.0 ? u_amb[2] : u_amb[3]));
    gl_FragColor = vec4(colour, 1.0);
    return;
  }

  if (u_phase < 0.5) {
    gl_FragColor = vec4(0.0);
    return;
  }
  // The fronts are never straight: each wanders by its own noise.
  float wanderA = (fbm(p / 250.0 + 3.1 + seed) - 0.5) * 170.0;
  float wanderB = (fbm(p / 210.0 + 11.7 + seed + u_time * 0.12) - 0.5) * 210.0;
  float fromD = box(p, u_from);
  float him = 1.0;
  float picture = 0.0;
  float rim = 0.0;
  if (u_phase < 1.5) {
    float his = u_fronts.y - (fromD + wanderB);
    him = step(b, his / 90.0);
    picture = u_flagOn * step(b, (u_fronts.x - (fromD + wanderA)) / 64.0);
    rim = exp(-abs(his) / 70.0);
  } else if (u_phase > 2.5) {
    float left = u_fronts.z - (box(p, u_toward) + wanderB);
    him = step(b, left / 110.0);
    rim = exp(-abs(left) / 60.0);
  }
  if (him < 0.5 && picture < 0.5) {
    gl_FragColor = vec4(0.0);
    return;
  }
  if (him < 0.5) {
    gl_FragColor = vec4(flag(p, window, b), 1.0);
    return;
  }
  // Himself: silk in the light's greens, brightest at his edge.
  float light = silk(p / 520.0 + seed + vec2(0.0, u_time * 0.06), u_time * 1.6);
  float tone = smoothstep(0.24, 0.76, light) * 0.72 + rim * 0.5;
  float q = floor(clamp(tone, 0.0, 1.0) * 5.0 + b) / 5.0;
  gl_FragColor = vec4(palette(mix(u_tones.x, u_tones.y, q)), 1.0);
}`;
