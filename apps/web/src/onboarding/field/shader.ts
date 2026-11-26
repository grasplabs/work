// Stephen's field, as one WebGL fragment shader drawn on a canvas under
// the page. Stephen is never shown as a figure in the setup: he is the
// light behind the page. Each fragment is one cell of the page's pixel grid
// (the canvas is as many pixels as the window has cells, scaled up crisp),
// and every cell is either left clear or set to one flat colour by the
// system's ordered dither (Bayer's 4 by 4), as the flags and Damsko's
// dithers are: where he rests on this screen (`u_rest`, each screen its own
// place and tempo), a light that follows the pointer, and the soft light
// round each thing he holds (`u_holds`), up to its edge.

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
// The four tones of his resting light, faintest first, as this page resolves them.
uniform vec3 u_amb[4];
// Where he rests: centre x, centre y, reach across, reach down, in CSS pixels.
uniform vec4 u_rest;
// His mood on this screen: seed, tempo, strength.
uniform vec3 u_mood;
// The pointer: x, y, and how much of its light is there.
uniform vec3 u_pointer;
// What he holds: up to four elements at once, each its own light that builds up while he is on it
// and fades where it is when he leaves. Each one's box (x, y, width, height), and how it looks:
// how much of it there is, whether it paints its own ground (1) or not (0), and its corner.
uniform vec4 u_holds[4];
uniform vec3 u_holdLooks[4];
// On a local stack only (look.ts): which dither he is drawn in (0 the current silk, 1 A dots,
// 2 B sand, 3 C aurora), and what the pointer leaves behind it for A, B and C: its trail (x, y,
// how much is left) and the rings a press sends out (x, y, seconds since; below zero none).
uniform float u_variant;
uniform vec3 u_trail[8];
uniform vec3 u_ripples[3];
// The deepest tone C's light reaches where it is brightest: lime by night, pine by day.
uniform vec3 u_accent;
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
// The ordered dither's threshold for a cell, 0 to 1: Bayer's 4 by 4.
float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2.0 + a.y * a.y * 0.75);
}
float bayer4(vec2 a) {
  return bayer2(0.5 * a) * 0.25 + bayer2(a) + 0.03125;
}
// How far a point is outside a box with the page's corners (inside: below zero). Damsko's corners
// are squircles (corner-shape: squircle, a superellipse of power 4), so his line follows that
// curve, not a circle's.
float roundBox(vec2 p, vec4 rect, float radius) {
  vec2 half_ = rect.zw * 0.5;
  float r = min(radius, min(half_.x, half_.y));
  vec2 q = abs(p - (rect.xy + half_)) - half_ + r;
  vec2 m = max(q, 0.0);
  float corner = r > 0.5 ? pow(pow(m.x, 4.0) + pow(m.y, 4.0), 0.25) : length(m);
  return corner + min(max(q.x, q.y), 0.0) - r;
}

// Him behind the page at a cell: where he rests, the pointer's light, and the light round each
// thing he holds. Clear (alpha 0) where there is none of him.
vec4 ambient(vec2 p, vec2 cellAt, vec2 window, float b, float seed, float t) {
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
    // What he holds: a soft light round it that moves along it, growing outward as he builds up;
    // its middle stays clear.
    float round_ = silk(p / 190.0 + vec2(t * 0.35, -t * 0.28) + seed, t * 2.4);
    // Inside a thing to press there is none of him: its own surface stays as it is, the same all
    // over, whatever lies behind the page. Only its edge carries his line.
    float clear = 1.0;
    // How far out from round words his cells thin away, in CSS pixels.
    const float fade = 112.0;
    for (int i = 0; i < 4; i++) {
      vec3 look = u_holdLooks[i];
      if (look.x < 0.004) continue;
      // As much clearing as there is of his light round it: it comes and goes with it, never after it.
      // One that paints its own ground needs no clearing: its own smooth corner covers his cells,
      // where cleared cells would stand in steps round the curve.
      if (look.y > 0.5) continue;
      // Round one without a ground of its own (words, a link) he thins out softly, from its edge
      // outward, round as a pill whatever its corners: no block of cleared cells round the words,
      // only his own dither growing sparser towards them.
      vec4 box = u_holds[i];
      vec2 half_ = box.zw * 0.5;
      float pill = min(half_.x, half_.y);
      vec2 q = abs(p - (box.xy + half_)) - half_ + pill;
      float away = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - pill;
      clear = min(clear, mix(1.0, smoothstep(0.0, fade, away), look.x));
    }
    level *= clear;
    for (int i = 0; i < 4; i++) {
      vec3 look = u_holdLooks[i];
      if (look.x < 0.004) continue;
      float d = roundBox(p, u_holds[i], look.z);
      // No line of his own on the edge: his light runs straight up to it, from the first cell
      // whose middle lies outside, so no band of blank cells stands between them.
      // Under a solid one it runs on beneath the edge, so the edge is the element's own.
      float halo = exp(-max(d, 0.0) / (6.0 + 22.0 * look.x)) * max(step(0.0, d), look.y) * (0.06 + 0.5 * round_);
      // Round words his light rises with the fade, so no edge of it is drawn there either.
      halo *= mix(smoothstep(4.0, fade, d), 1.0, look.y);
      level += look.x * halo;
    }

    float q = floor(clamp(level, 0.0, 1.0) * 4.0 + b);
    if (q < 1.0) {
      return vec4(0.0);
    }
    vec3 colour = q < 2.0 ? u_amb[0] : (q < 3.0 ? u_amb[1] : (q < 4.0 ? u_amb[2] : u_amb[3]));
    return vec4(colour, 1.0);
}

// ---- A, B and C: three other dithers from the platform, to try (look.ts). ----

// Under the page's column of words he keeps low, so they read; beside it he is all there.
float columnAt(vec2 p, vec2 window) {
  return mix(0.4, 1.0, smoothstep(300.0, 540.0, abs(p.x - window.x * 0.5)));
}
// Round words and links he holds he thins out softly, as the current dither does: never a block.
float clearAt(vec2 p) {
  float clear = 1.0;
  for (int i = 0; i < 4; i++) {
    vec3 look = u_holdLooks[i];
    if (look.x < 0.004 || look.y > 0.5) continue;
    vec4 box = u_holds[i];
    vec2 half_ = box.zw * 0.5;
    float pill = min(half_.x, half_.y);
    vec2 q = abs(p - (box.xy + half_)) - half_ + pill;
    float away = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - pill;
    clear = min(clear, mix(1.0, smoothstep(0.0, 112.0, away), look.x));
  }
  return clear;
}
// The light round each thing he holds, up to its edge, as the current dither has it.
float haloAt(vec2 p, float round_) {
  float level = 0.0;
  for (int i = 0; i < 4; i++) {
    vec3 look = u_holdLooks[i];
    if (look.x < 0.004) continue;
    float d = roundBox(p, u_holds[i], look.z);
    float halo = exp(-max(d, 0.0) / (6.0 + 22.0 * look.x)) * max(step(0.0, d), look.y) * (0.06 + 0.5 * round_);
    halo *= mix(smoothstep(4.0, 112.0, d), 1.0, look.y);
    level += look.x * halo;
  }
  return level;
}
// Where he rests on this screen: 1 at its middle, falling away softly.
float restAt(vec2 p) {
  vec2 away = (p - u_rest.xy) / u_rest.zw;
  return exp(-dot(away, away) * 1.6);
}
// A ring a press sent out: how much of it lies at p, and its radius now.
float rippleAt(vec2 p, vec3 ripple, float speed, float width) {
  if (ripple.z < 0.0) return 0.0;
  float radius = ripple.z * speed;
  float d = length(p - ripple.xy) - radius;
  return exp(-d * d / (width * width)) * exp(-ripple.z * 1.5);
}
// The pointer's trail at p: the most of it that lies there.
float trailAt(vec2 p, float reach) {
  float most = 0.0;
  for (int i = 0; i < 8; i++) {
    vec3 point = u_trail[i];
    if (point.z < 0.01) continue;
    vec2 d = p - point.xy;
    most = max(most, point.z * exp(-dot(d, d) / (2.0 * reach * reach)));
  }
  return most;
}
float bayer8(vec2 a) {
  return bayer4(0.5 * a) * 0.25 + bayer2(a);
}
vec4 tone(float q) {
  if (q < 1.0) return vec4(0.0);
  vec3 colour = q < 2.0 ? u_amb[0] : (q < 3.0 ? u_amb[1] : (q < 4.0 ? u_amb[2] : (q < 5.0 ? u_amb[3] : u_accent)));
  return vec4(colour, 1.0);
}

// A · Dots, from Chat's dotted backdrop and the composer's voice hill: a halftone grid whose dots
// grow and deepen with his light, rolling in slow humps. The pointer is a lens: the dots part
// round it, spread and swell, with a bright rim; a press sends a ring through the grid.
vec2 dotsPush(vec2 p) {
  vec2 push = vec2(0.0);
  vec2 d = p - u_pointer.xy;
  float r = length(d) + 0.001;
  push += d / r * 30.0 * exp(-r * r / (2.0 * 80.0 * 80.0)) * u_pointer.z;
  for (int i = 0; i < 3; i++) {
    vec3 ripple = u_ripples[i];
    if (ripple.z < 0.0) continue;
    vec2 e = p - ripple.xy;
    float er = length(e) + 0.001;
    push += e / er * 22.0 * rippleAt(p, ripple, 420.0, 46.0);
  }
  return push;
}
float dotsLevel(vec2 p, vec2 window, float seed, float t) {
  float hills = fbm(vec2(p.x / 430.0 + t * 0.05, p.y / 300.0 - t * 0.03) + seed);
  float roll = 0.5 + 0.5 * sin(p.x / 150.0 - t * 0.55 + hills * 5.0 + p.y / 260.0);
  float flow = hills * 0.9 + roll * 0.55;
  float level = restAt(p) * u_mood.z * (0.05 + 0.95 * flow);
  vec2 d = p - u_pointer.xy;
  float r = length(d);
  // Parted at the middle, piled up at the rim.
  float rim = exp(-pow((r - 96.0) / 30.0, 2.0)) * 0.9 + exp(-r * r / (2.0 * 170.0 * 170.0)) * 0.22;
  level = level * (1.0 - u_pointer.z * smoothstep(70.0, 30.0, r)) + u_pointer.z * rim * smoothstep(40.0, 70.0, r);
  level += trailAt(p, 46.0) * 0.45;
  for (int i = 0; i < 3; i++) level += rippleAt(p, u_ripples[i], 420.0, 40.0) * 0.6;
  level *= columnAt(p, window);
  level = max(level - 0.06, 0.0) * 1.08;
  level *= clearAt(p);
  level += haloAt(p, fbm(p / 190.0 + vec2(t * 0.35, -t * 0.28) + seed));
  return level;
}
vec4 dots(vec2 p, vec2 window, float seed, float t) {
  const float pitch = 6.0;
  vec2 push = dotsPush(p);
  vec2 q = p - push;
  vec2 index = floor(q / pitch);
  vec2 local = floor(fract(q / pitch) * 3.0) - 1.0;
  // The dot's light, read at its own middle where it now stands, so a dot is whole or none.
  vec2 middle = (index + 0.5) * pitch + push;
  float level = dotsLevel(middle, window, seed, t);
  float size = floor(clamp(level, 0.0, 1.0) * 3.0 + bayer4(index));
  if (size < 1.0) return vec4(0.0);
  // 1: one pixel; 2: a square of four; 3: a cross of five. Never the whole cell: always dots.
  bool centre = local.x == 0.0 && local.y == 0.0;
  if (size < 2.0 && !centre) return vec4(0.0);
  if (size < 3.0 && (local.x < 0.0 || local.y < 0.0)) return vec4(0.0);
  if (size >= 3.0 && abs(local.x) + abs(local.y) > 1.5) return vec4(0.0);
  return vec4(size < 2.0 ? u_amb[1] : (size < 3.0 ? u_amb[2] : u_amb[3]), 1.0);
}

// B · Sand, from Chat's sand backdrop: grains on a plate that sings, settling along the lines
// where it rests (a Chladni figure) as its tone slowly changes. The pointer is a finger in the
// sand: it clears a hole, the grains pile up round its rim, and it leaves a furrow behind it;
// a press sends a wave through the grains.
vec4 sand(vec2 p, vec2 cellAt, vec2 window, float seed, float t) {
  float side = min(window.x, window.y);
  vec2 uv = (p - window * 0.5) / side * 3.14159;
  float m = 3.0 + 1.6 * sin(t * 0.045 + seed);
  float n = 5.0 + 1.9 * sin(t * 0.031 + seed * 1.7);
  vec2 wob = vec2(fbm(p / 380.0 + t * 0.02), fbm(p / 380.0 + 7.1 - t * 0.02)) - 0.5;
  uv += wob * 0.35;
  float plate = cos(n * uv.x) * cos(m * uv.y) - cos(m * uv.x) * cos(n * uv.y);
  float lines = 1.0 - smoothstep(0.0, 0.34, abs(plate));
  float level = (0.04 + 0.27 * restAt(p)) * u_mood.z * 2.4 * lines + restAt(p) * u_mood.z * 0.18;
  vec2 d = p - u_pointer.xy;
  float r = length(d);
  float hole = smoothstep(58.0, 96.0, r);
  float rim = exp(-pow((r - 106.0) / 16.0, 2.0));
  level = level * mix(1.0, hole, u_pointer.z) + u_pointer.z * rim * 0.95;
  // The furrow: grains pushed out of the trail, heaped on either side of it.
  float furrow = trailAt(p, 30.0);
  float banks = trailAt(p, 58.0) - furrow;
  level = level * (1.0 - 0.9 * furrow) + banks * 0.8;
  for (int i = 0; i < 3; i++) level += rippleAt(p, u_ripples[i], 360.0, 22.0) * 0.8;
  level *= columnAt(p, window);
  level *= clearAt(p);
  level += haloAt(p, fbm(p / 190.0 + vec2(t * 0.35, -t * 0.28) + seed));
  level = clamp(level, 0.0, 1.0);
  // Grains, not an ordered grid: each cell its own threshold, still, so they settle and stay.
  float grain = hash(cellAt + seed * 31.0);
  if (level < 0.06 || level <= grain * 0.92 + 0.04) return vec4(0.0);
  float deep = level + hash(cellAt * 1.7 + 3.1) * 0.35;
  return vec4(deep < 0.55 ? u_amb[1] : (deep < 0.95 ? u_amb[2] : u_amb[3]), 1.0);
}

// C · Aurora, from the agents' marks and the aurora tone: coarser cells (Bayer's 8 by 8 on 4px)
// in curtains of light that hang from where he rests, light running up them. The pointer lights
// up the curtains round it, brightest at its middle, with a comet's tail behind it; a press
// sends a flash out.
vec4 aurora(vec2 p, vec2 cellAt, vec2 window, float seed, float t) {
  vec2 block = floor(cellAt / 2.0);
  vec2 at = (block + 0.5) * 2.0 * u_cell;
  float sway = fbm(vec2(at.y / 460.0 + seed, t * 0.06)) * 1.6;
  float w = at.x / 190.0 + sway + t * 0.03;
  float curtain = pow(0.5 + 0.5 * sin(w * 6.2832), 3.0);
  // Rays: thin across, long down, light running up them.
  float run = 0.3 + 0.7 * noise(vec2(w * 11.0, at.y / 200.0 + t * 0.5));
  float hang = smoothstep(-0.2, 0.7, 1.0 - (at.y - u_rest.y + u_rest.w * 0.4) / (u_rest.w * 1.6));
  float level = restAt(at) * u_mood.z * (0.04 + 1.1 * curtain * run) * mix(0.5, 1.0, hang);
  vec2 d = at - u_pointer.xy;
  float glow = exp(-dot(d, d) / (2.0 * 125.0 * 125.0));
  level += u_pointer.z * glow * (0.42 + 0.4 * curtain + 0.2 * run);
  level += trailAt(at, 50.0) * (0.55 + 0.4 * curtain);
  for (int i = 0; i < 3; i++) level += rippleAt(at, u_ripples[i], 520.0, 60.0) * 0.9;
  level *= columnAt(at, window);
  level = max(level - 0.06, 0.0) * 1.08;
  level *= clearAt(at);
  level += haloAt(at, fbm(at / 190.0 + vec2(t * 0.35, -t * 0.28) + seed));
  return tone(floor(clamp(level, 0.0, 1.0) * 5.0 + bayer8(block)));
}
void main() {
  vec2 at = floor(gl_FragCoord.xy);
  // CSS pixels from the window's top left, at the cell's middle.
  vec2 cellAt = vec2(at.x, u_cells.y - 1.0 - at.y);
  vec2 p = (cellAt + 0.5) * u_cell;
  vec2 window = u_cells * u_cell;
  float t = u_time * u_mood.y;
  if (u_variant > 2.5) {
    gl_FragColor = aurora(p, cellAt, window, u_mood.x, t);
  } else if (u_variant > 1.5) {
    gl_FragColor = sand(p, cellAt, window, u_mood.x, t);
  } else if (u_variant > 0.5) {
    gl_FragColor = dots(p, window, u_mood.x, t);
  } else {
    gl_FragColor = ambient(p, cellAt, window, bayer4(cellAt), u_mood.x, t);
  }
}`;
