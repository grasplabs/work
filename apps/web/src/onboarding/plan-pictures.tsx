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
import type { PlanDay } from "./plan-drawing.tsx";
import { drawScene, pictureHeight, pictureWidth } from "./plan-scenes.ts";
import type { Scene } from "./plan-scenes.ts";

// The plan's story told in pictures: the whole window one of the
// Appearance page's scenes, a picture dithered from night to lime by the
// very shader that draws them (chat/backdrop/shader.ts), and every part
// of the story a picture of its own (plan-scenes.ts). As Stephen moves on
// to the next part, the picture morphs into the next: the new one's light
// comes through the old one's in drifting folds, the two warping a little
// as they pass, the cells settling into the new picture. While a picture
// stands it comes slowly closer, as a camera would. Darker over the foot
// of the window, where the story's words stand on it. Decoration only (the
// words say it all), hidden in forced colours.

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

// Two pictures, the one leaving and the one coming, the scene's way: cropped to fill, swaying a
// little, their light graded, the silk drifting through it; between them a fold of noise sweeping
// across as `u_morph` goes from 0 to 1. Then the scene's five steps of light, by Bayer's threshold,
// in the palette's greens.
const STORY = `
uniform sampler2D u_from;
uniform sampler2D u_to;
uniform float u_morph;
uniform vec2 u_zoom;
uniform float u_fade;
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
void main() {
  float aspect = u_res.x / u_res.y;
  vec2 p = v_uv * vec2(aspect, 1.0);
  vec2 sway = vec2(
    fbm(p * 2.2 + vec2(0.0, u_time * 0.02)),
    fbm(p * 2.2 + vec2(5.2, 1.3) - u_time * 0.017)
  ) - 0.5;
  vec2 uv = v_uv + sway * 0.008;
  float passing = sin(3.14159 * u_morph);
  vec2 warp = (vec2(fbm(p * 3.0 + u_time * 0.1), fbm(p * 3.0 + 7.3 - u_time * 0.1)) - 0.5) * 0.06 * passing;
  float from = texture2D(u_from, cover(uv + warp, u_zoom.x)).r;
  float to = texture2D(u_to, cover(uv - warp, u_zoom.y)).r;
  float fold = fbm(p * 2.4 + vec2(3.0, u_time * 0.05));
  float m = smoothstep(fold - 0.14, fold + 0.14, u_morph * 1.6 - 0.3);
  float lum = mix(from, to, m);
  lum += passing * 0.12 * smoothstep(0.05, 0.0, abs(m - 0.5) - 0.08);
  float tone = pow(lum, 1.15) * 1.2 * u_fade;
  float light = silk(p * 1.1, u_time * 0.7);
  tone *= 1.0 + 0.3 * (smoothstep(0.25, 0.75, light) - 0.5) * 2.0;
  tone *= mix(0.32, 1.0, smoothstep(0.06, 0.44, v_uv.y));
  const float steps = 5.0;
  float q = floor(clamp(tone, 0.0, 1.0) * steps + bayer8(gl_FragCoord.xy)) / steps;
  gl_FragColor = vec4(palette(q * 0.86), 1.0);
}`;

/** How long a picture takes to become the next, in ms. */
const MORPH_MS = 1800;
/** How long the first picture takes to come up from night, in ms. */
const FADE_MS = 1200;
/** How much closer a picture comes while it stands, at most, and over how long, in ms. */
const CLOSER = 0.08;
const CLOSER_MS = 14_000;

const ease = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

/** The story's pictures, drawn on `element`: `show` morphs to a scene, `stop` lets it all go. */
const startPictures = (
  element: HTMLCanvasElement,
  days: readonly PlanDay[]
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
  const begun = performance.now();
  // Which texture the coming picture is in, when it came and when the leaving one did.
  let to = 0;
  let toAtMs = begun;
  let fromAtMs = begun;
  let shown: Scene | null = null;
  let last = 0;
  let frame = 0;
  const fit = (): void => {
    const box = element.getBoundingClientRect();
    element.width = Math.max(1, Math.round(box.width / sceneCell));
    element.height = Math.max(1, Math.round(box.height / sceneCell));
    gl.viewport(0, 0, element.width, element.height);
  };
  const closer = (since: number, now: number): number =>
    1 + CLOSER * ease(Math.min(1, (now - since) / CLOSER_MS));
  const draw = (now: number): void => {
    gl.uniform2f(resAt, element.width, element.height);
    gl.uniform1f(timeAt, 8 + (now - begun) / 1000);
    gl.uniform1i(toAt, to);
    gl.uniform1i(fromAt, 1 - to);
    gl.uniform1f(morphAt, ease(Math.min(1, (now - toAtMs) / MORPH_MS)));
    gl.uniform2f(zoomAt, closer(fromAtMs, now), closer(toAtMs, now));
    gl.uniform1f(fadeAt, ease(Math.min(1, (now - begun) / FADE_MS)));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };
  const loop = (now: number): void => {
    frame = requestAnimationFrame(loop);
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
  frame = requestAnimationFrame(loop);
  return {
    show: (scene) => {
      if (scene === shown) {
        return;
      }
      const picture = pictureOf(scene);
      const now = performance.now();
      // The first picture comes up from night on its own; each after it morphs from the one before.
      if (shown !== null) {
        to = 1 - to;
        fromAtMs = toAtMs;
        toAtMs = now;
      }
      shown = scene;
      gl.activeTexture(gl.TEXTURE0 + to);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.LUMINANCE,
        gl.LUMINANCE,
        gl.UNSIGNED_BYTE,
        picture
      );
      if (toAtMs === begun) {
        // Both textures the first picture, so it stands whole from the start.
        gl.activeTexture(gl.TEXTURE0 + 1 - to);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.LUMINANCE,
          gl.LUMINANCE,
          gl.UNSIGNED_BYTE,
          picture
        );
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

/** The window's picture of the story's `scene`, morphing into each next one. */
export const PlanPictures = ({
  scene,
  days,
}: {
  scene: Scene;
  days: readonly PlanDay[];
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pictures = useRef<ReturnType<typeof startPictures>>(null);
  const showing = useRef(scene);
  useEffect(() => {
    const element = canvas.current;
    const started = element === null ? null : startPictures(element, days);
    started?.show(showing.current);
    pictures.current = started;
    return () => {
      started?.stop();
      pictures.current = null;
    };
  }, [days]);
  useEffect(() => {
    showing.current = scene;
    pictures.current?.show(scene);
  }, [scene]);
  return (
    <canvas aria-hidden="true" ref={canvas} {...stylex.props(styles.canvas)} />
  );
};
