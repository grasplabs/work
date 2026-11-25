import { media } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";

import {
  rgbaOf,
  sceneCell,
  sceneFrameMs,
  sceneProgram,
  stops,
} from "../chat/backdrop/shader.ts";
import { drawScene, pictureHeight, pictureWidth } from "./plan-scenes.ts";
import type { Scene } from "./plan-scenes.ts";
import type { PlanDay } from "./plan.ts";

// The plan's story told in pictures: the whole window one of the
// Appearance page's scenes, a picture dithered from night to lime by the
// very shader that draws them (chat/backdrop/shader.ts), and every part
// of the story a picture of its own (plan-scenes.ts). As Stephen moves on
// to the next part, the picture becomes the next one, never by fading:
// the old picture's light runs towards where the new one's lies and
// melts, the new one's gathers out of the old one's lights and settles
// into its shapes, place by place, its brightest parts first, while the
// view goes on into the old one as if walking through it. While a picture
// stands it comes slowly closer, as a camera would. Darker over the foot
// of the window, where the story's words stand on it. Decoration only (the
// words say it all), hidden in forced colours, and standing still under
// reduced motion.

const styles = stylex.create({
  canvas: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    imageRendering: "pixelated",
    display: { default: "block", [media.forcedColors]: "none" },
  },
});

// Two pictures, the one leaving and the one coming, each cropped to fill and swaying a little. As
// `u_morph` goes from 0 to 1, each is drawn towards the other's light (along the slope of the
// other's light, softened), both drift and soften midway, and each place goes over to the new
// picture when its turn comes: where the new picture is brightest first, through folds of noise,
// a glow along the edge where it is passing. Then the scene's grade and its five steps of light,
// by Bayer's threshold, in the palette's greens.
const STORY = `
uniform sampler2D u_from;
uniform sampler2D u_to;
uniform float u_morph;
uniform vec2 u_zoom;
uniform float u_fade;
uniform float u_carry;
vec2 cover(vec2 uv, float zoom) {
  float aspect = u_res.x / u_res.y;
  float imageAspect = u_imageRes.x / u_imageRes.y;
  vec2 crop = aspect > imageAspect
    ? vec2(1.0, imageAspect / aspect)
    : vec2(aspect / imageAspect, 1.0);
  crop /= zoom;
  vec2 focus = vec2(0.5, 0.6);
  return clamp((uv - 0.5) * crop + 0.5 + (focus - 0.5) * (1.0 - crop), 0.0, 1.0);
}
float lightOf(sampler2D image, vec2 uv) {
  return texture2D(image, clamp(uv, 0.0, 1.0)).r;
}
// A picture's light around uv, softened over r.
float softly(sampler2D image, vec2 uv, float r) {
  float sum = lightOf(image, uv) * 0.2;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    sum += lightOf(image, uv + vec2(cos(a), sin(a)) * r) * 0.1;
  }
  return sum;
}
void main() {
  float aspect = u_res.x / u_res.y;
  vec2 p = v_uv * vec2(aspect, 1.0);
  vec2 sway = vec2(
    fbm(p * 2.2 + vec2(0.0, u_time * 0.02)),
    fbm(p * 2.2 + vec2(5.2, 1.3) - u_time * 0.017)
  ) - 0.5;
  vec2 uv = v_uv + sway * 0.008;
  float m = u_morph;
  float passing = sin(3.14159 * m);
  // A slow current across the window, its way turning from place to place.
  float angle = fbm(p * 1.3 + vec2(1.7, u_time * 0.03)) * 9.0;
  vec2 current = vec2(cos(angle), sin(angle));
  vec2 a = cover(uv, u_zoom.x);
  vec2 b = cover(uv, u_zoom.y);
  // Each picture carried by the other's light: the old one pushed out of shape where the new one
  // is bright, the new one coming out of the old one's shapes.
  float newHere = softly(u_to, b, 0.02);
  float oldHere = softly(u_from, a, 0.02);
  float r = 0.01 * passing;
  float from = softly(u_from, a + current * newHere * u_carry * m, r);
  float to = softly(u_to, b - current * oldHere * u_carry * (1.0 - m), r);
  float fold = fbm(p * 2.0 + vec2(3.0, u_time * 0.04));
  float turn = mix(fold, 1.0 - to, 0.35);
  const float edge = 0.3;
  float k = smoothstep(turn - edge, turn + edge, m * (1.0 + 2.0 * edge) - edge);
  float lum = mix(from, to, k);
  lum += passing * 0.12 * (1.0 - abs(2.0 * k - 1.0));
  float tone = pow(lum, 1.15) * 1.2 * u_fade;
  float light = silk(p * 1.1, u_time * 0.7);
  tone *= 1.0 + 0.3 * (smoothstep(0.25, 0.75, light) - 0.5) * 2.0;
  tone *= mix(0.32, 1.0, smoothstep(0.06, 0.44, v_uv.y));
  const float steps = 5.0;
  float q = floor(clamp(tone, 0.0, 1.0) * steps + bayer8(gl_FragCoord.xy)) / steps;
  gl_FragColor = vec4(palette(q * 0.86), 1.0);
}`;

/** How long a picture takes to become the next, in ms. */
const MORPH_MS = 2600;
/** How long the first picture takes to come up from night, in ms. */
const FADE_MS = 1200;
/** How much closer a picture comes while it stands, at most, and over how long, in ms. */
const CLOSER = 0.08;
const CLOSER_MS = 14_000;
/** How much further into the leaving picture the view goes as it passes. */
const THROUGH = 0.14;
/** How far each picture is carried by the other's light, midway, in the window's heights. */
const CARRY = 0.3;

const ease = (t: number): number => t * t * (3 - 2 * t);

/** The story's pictures, drawn on `element`: `show` turns to a scene, `stop` lets it all go. */
const startPictures = (
  element: HTMLCanvasElement,
  days: readonly PlanDay[],
  still: boolean
): { show: (scene: Scene) => void; stop: () => void } | null => {
  const gl = element.getContext("webgl", {
    alpha: false,
    antialias: false,
    preserveDrawingBuffer: true,
  });
  if (gl === null) {
    return null;
  }
  const program = sceneProgram(gl, STORY);
  if (program === null) {
    return null;
  }
  const at = (name: string) => gl.getUniformLocation(program, name);
  const textures = [gl.createTexture(), gl.createTexture()];
  for (const [unit, texture] of textures.entries()) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.LUMINANCE,
      1,
      1,
      0,
      gl.LUMINANCE,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0])
    );
    for (const side of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) {
      gl.texParameteri(gl.TEXTURE_2D, side, gl.CLAMP_TO_EDGE);
    }
    for (const filter of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) {
      gl.texParameteri(gl.TEXTURE_2D, filter, gl.LINEAR);
    }
  }
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.uniform2f(at("u_imageRes"), pictureWidth, pictureHeight);
  gl.uniform1f(at("u_carry"), CARRY);
  const fromAt = at("u_from");
  const toAt = at("u_to");
  const morphAt = at("u_morph");
  const zoomAt = at("u_zoom");
  const fadeAt = at("u_fade");
  const resAt = at("u_res");
  const timeAt = at("u_time");
  const pictures = new Map<Scene, HTMLCanvasElement>();
  const pictureOf = (scene: Scene): HTMLCanvasElement => {
    const kept = pictures.get(scene);
    if (kept !== undefined) {
      return kept;
    }
    const drawnNow = drawScene(scene, days);
    pictures.set(scene, drawnNow);
    return drawnNow;
  };
  const style = getComputedStyle(element);
  gl.uniform3fv(
    at("u_palette"),
    stops.flatMap((stop) => {
      const [r, g, b] = rgbaOf(style.getPropertyValue(stop).trim());
      return [r, g, b];
    })
  );
  // Standing still, the first picture is already up and every change already made.
  const begun = performance.now() - (still ? FADE_MS + MORPH_MS : 0);
  // Which texture the coming picture is in, when it came and when the leaving one did.
  let to = 0;
  let toAtMs = begun;
  let fromAtMs = begun;
  let shown: Scene | null = null;
  // The scene asked for while a change was still under way: it comes once that one is made.
  let waiting: Scene | null = null;
  let last = 0;
  let frame = 0;
  const fit = (): void => {
    const box = element.getBoundingClientRect();
    element.width = Math.max(1, Math.round(box.width / sceneCell));
    element.height = Math.max(1, Math.round(box.height / sceneCell));
    gl.viewport(0, 0, element.width, element.height);
  };
  const closer = (since: number, now: number): number =>
    still ? 1 : 1 + CLOSER * ease(Math.min(1, (now - since) / CLOSER_MS));
  const draw = (now: number): void => {
    const morph = ease(Math.min(1, (now - toAtMs) / MORPH_MS));
    gl.uniform2f(resAt, element.width, element.height);
    gl.uniform1f(timeAt, 8 + (still ? 0 : (now - begun) / 1000));
    gl.uniform1i(toAt, to);
    gl.uniform1i(fromAt, 1 - to);
    gl.uniform1f(morphAt, morph);
    gl.uniform2f(
      zoomAt,
      closer(fromAtMs, now) * (1 + THROUGH * morph),
      closer(toAtMs, now)
    );
    gl.uniform1f(fadeAt, ease(Math.min(1, (now - begun) / FADE_MS)));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };
  const load = (unit: number, picture: HTMLCanvasElement): void => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.LUMINANCE,
      gl.LUMINANCE,
      gl.UNSIGNED_BYTE,
      picture
    );
  };
  const turnTo = (scene: Scene, now: number): void => {
    const picture = pictureOf(scene);
    if (shown === null || still) {
      // The first picture comes up from night on its own, in both textures, so it stands whole;
      // standing still, each is simply there.
      load(to, picture);
      load(1 - to, picture);
      toAtMs = begun - MORPH_MS;
      fromAtMs = toAtMs;
    } else {
      to = 1 - to;
      fromAtMs = toAtMs;
      toAtMs = now;
      load(to, picture);
    }
    shown = scene;
  };
  const loop = (now: number): void => {
    frame = requestAnimationFrame(loop);
    if (waiting !== null && now - toAtMs >= MORPH_MS) {
      const next = waiting;
      waiting = null;
      turnTo(next, now);
    }
    if (now - last >= sceneFrameMs) {
      last = now;
      draw(now);
    }
  };
  const resized = new ResizeObserver(() => {
    fit();
    draw(performance.now());
  });
  resized.observe(element);
  fit();
  if (!still) {
    frame = requestAnimationFrame(loop);
  }
  return {
    show: (scene) => {
      const now = performance.now();
      if (scene === shown) {
        waiting = null;
        return;
      }
      // A change under way is never cut short: the next waits for it, so nothing snaps.
      if (!still && shown !== null && now - toAtMs < MORPH_MS) {
        waiting = scene;
        return;
      }
      turnTo(scene, now);
      if (still) {
        draw(now);
      }
    },
    stop: () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      // Let go of now only once the canvas has left the page: one still in it may be drawn on again.
      if (!element.isConnected) {
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
    },
  };
};

/** The window's picture of the story's `scene`, becoming each next one; standing still if `still`. */
export const PlanPictures = ({
  scene,
  days,
  still,
}: {
  scene: Scene;
  days: readonly PlanDay[];
  still: boolean;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pictures = useRef<ReturnType<typeof startPictures>>(null);
  const showing = useRef(scene);
  useEffect(() => {
    const element = canvas.current;
    const started =
      element === null ? null : startPictures(element, days, still);
    started?.show(showing.current);
    pictures.current = started;
    return () => {
      started?.stop();
      pictures.current = null;
    };
  }, [days, still]);
  useEffect(() => {
    showing.current = scene;
    pictures.current?.show(scene);
  }, [scene]);
  return (
    <canvas aria-hidden="true" ref={canvas} {...stylex.props(styles.canvas)} />
  );
};
