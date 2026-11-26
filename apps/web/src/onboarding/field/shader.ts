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
    const float fade = 44.0;
    for (int i = 0; i < 4; i++) {
      vec3 look = u_holdLooks[i];
      if (look.x < 0.004) continue;
      // As much clearing as there is of his light round it: it comes and goes with it, never after it.
      // One that paints its own ground needs no clearing: its own smooth corner covers his cells,
      // where cleared cells would stand in steps round the curve.
      if (look.y > 0.5) continue;
      // Round one without a ground of its own (words, a link) he thins out softly, from a little
      // outside its edge to clear inside it: no hard block of cleared cells round the words.
      clear = min(clear, mix(1.0, smoothstep(4.0, fade, roundBox(p, u_holds[i], look.z)), look.x));
    }
    level *= clear;
    // The cleared cells come back by the dither as the ring fades, not all at once.
    level = clear < 1.0 && b > clear ? 0.0 : level;
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

void main() {
  vec2 at = floor(gl_FragCoord.xy);
  // CSS pixels from the window's top left, at the cell's middle.
  vec2 cellAt = vec2(at.x, u_cells.y - 1.0 - at.y);
  vec2 p = (cellAt + 0.5) * u_cell;
  vec2 window = u_cells * u_cell;
  gl_FragColor = ambient(p, cellAt, window, bayer4(cellAt), u_mood.x, u_time * u_mood.y);
}`;
