// Stephen's field, as one WebGL fragment shader drawn on a canvas under
// the page. Stephen is never shown as a figure in the setup: he is the
// light behind the page, drawn as a halftone grid of dots (as Chat's dotted
// backdrop and the composer's voice hill are): one dot every 6 CSS pixels,
// growing from a pixel to a square of four to a cross of five, and
// deepening, with how much of him is there, set by Bayer's threshold.
// Where he rests on this screen (`u_rest`, each screen its own place and
// tempo) the dots roll in slow humps; round each thing he holds
// (`u_holds`) a soft light reaches up to its edge. The pointer barely
// touches him: where it has just been, a soft wake of dots swells and
// settles, and the dots there lean a pixel or two along its way. Never a
// circle, and nothing while it rests.

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
// The pointer: x, y, and how much of it is there.
uniform vec3 u_pointer;
// Where the pointer has just been, newest first: x, y, and how much of its wake is left.
uniform vec3 u_trail[8];
// How the pointer is moving now, in CSS pixels a second.
uniform vec2 u_motion;
// What he holds: up to four elements at once, each its own light that builds up while he is on it
// and fades where it is when he leaves. Each one's box (x, y, width, height), and how it looks:
// how much of it there is, whether it paints its own ground (1) or not (0), and its corner.
uniform vec4 u_holds[4];
uniform vec3 u_holdLooks[4];
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

// Under the page's column of words he keeps low, so they read; beside it he is all there.
float columnAt(vec2 p, vec2 window) {
  return mix(0.4, 1.0, smoothstep(300.0, 540.0, abs(p.x - window.x * 0.5)));
}
// Round words and links he holds he thins out softly, from their edge outward, round as a pill
// whatever their corners: no block of cleared cells round the words, only his dots growing sparser.
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
// The light round each thing he holds, up to its edge, with no line of his own (Ruben: never a
// green ring round a component). Under one that paints its own ground it runs on beneath the edge.
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
// The wake leans its dots a pixel or two along the pointer's way: longer behind it than ahead,
// narrow across, so never a circle; none while it rests.
vec2 leanAt(vec2 p) {
  float speed = length(u_motion);
  if (speed < 1.0) return vec2(0.0);
  vec2 dir = u_motion / speed;
  vec2 d = p - u_pointer.xy;
  float along = dot(d, dir);
  float across = dot(d, vec2(-dir.y, dir.x));
  float back = along < 0.0 ? 170.0 : 60.0;
  float lean = exp(-(along * along / (2.0 * back * back) + across * across / (2.0 * 46.0 * 46.0)));
  return dir * 2.0 * min(speed / 900.0, 1.0) * lean * u_pointer.z;
}
// How much of him lies at p: his humps where he rests, the pointer's soft wake, the light round
// what he holds.
float levelAt(vec2 p, vec2 window, float seed, float t) {
  float hills = fbm(vec2(p.x / 430.0 + t * 0.05, p.y / 300.0 - t * 0.03) + seed);
  float roll = 0.5 + 0.5 * sin(p.x / 150.0 - t * 0.55 + hills * 5.0 + p.y / 260.0);
  float flow = hills * 0.9 + roll * 0.55;
  float level = restAt(p) * u_mood.z * (0.05 + 0.95 * flow);
  // Where there is little of him there is none: no stray dots scattered over the page, only his
  // own places, thinning out at their edges.
  level = max(level - 0.16, 0.0) * 1.25;
  level += trailAt(p, 40.0) * 0.11;
  level *= columnAt(p, window);
  // The bar along the top stays clean, as the corner past its last button does: his dots begin
  // below it, fading in.
  level *= smoothstep(64.0, 132.0, p.y);
  level *= clearAt(p);
  level += haloAt(p, fbm(p / 190.0 + vec2(t * 0.35, -t * 0.28) + seed));
  return level;
}

void main() {
  vec2 at = floor(gl_FragCoord.xy);
  // CSS pixels from the window's top left, at the cell's middle.
  vec2 cellAt = vec2(at.x, u_cells.y - 1.0 - at.y);
  vec2 p = (cellAt + 0.5) * u_cell;
  vec2 window = u_cells * u_cell;
  float t = u_time * u_mood.y;
  const float pitch = 6.0;
  vec2 lean = leanAt(p);
  vec2 q = p - lean;
  vec2 index = floor(q / pitch);
  vec2 local = floor(fract(q / pitch) * 3.0) - 1.0;
  // The dot's light, read at its own middle, so a dot is whole or none.
  float level = levelAt((index + 0.5) * pitch + lean, window, u_mood.x, t);
  float size = floor(clamp(level, 0.0, 1.0) * 3.0 + bayer4(index));
  // 1: one pixel; 2: a square of four; 3: a cross of five. Never the whole cell: always dots.
  bool centre = local.x == 0.0 && local.y == 0.0;
  bool shown = size >= 3.0 ? abs(local.x) + abs(local.y) < 1.5
    : size >= 2.0 ? local.x >= 0.0 && local.y >= 0.0
    : size >= 1.0 && centre;
  if (!shown) {
    gl_FragColor = vec4(0.0);
    return;
  }
  gl_FragColor = vec4(size < 2.0 ? u_amb[1] : (size < 3.0 ? u_amb[2] : u_amb[3]), 1.0);
}`;
