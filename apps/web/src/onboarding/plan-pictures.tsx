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
import { clipHeight, clipWidth, clips } from "./plan-scenes.ts";
import type { Scene } from "./plan-scenes.ts";

// The plan's story told in footage: the whole window one of the Appearance
// page's scenes, dithered from night to lime by the very shader that draws
// them (chat/backdrop/shader.ts), and every part of the story told over a
// stock clip of its own (plan-scenes.ts), playing while it is told. Moving
// on to the next, it becomes the next one, never by fading: each is carried
// out of shape by the other's light and goes over place by place, while the
// view goes on into the old one as if walking through it. While a clip
// plays it comes slowly closer, as a camera would. Darker over the foot of
// the window, where the story's words stand on it. Decoration only (the
// words say it all), hidden in forced colours, and a still frame of each
// clip under reduced motion.

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

// Two clips, the one leaving and the one coming, each cropped to fill and swaying a little, its
// light graded (`u_grades`: the leaving one's gamma and gain, then the coming one's). As `u_morph`
// goes from 0 to 1, each is carried out of shape by the other's light along a slow current, both
// soften midway, and each place goes over to the new clip when its turn comes, through folds of
// noise, its brightest parts first, a glow along the edge where it is passing. Then the scene's
// five steps of light, by Bayer's threshold, in the palette's greens.
const STORY = `
uniform sampler2D u_from;
uniform sampler2D u_to;
uniform float u_morph;
uniform vec2 u_zoom;
uniform vec4 u_grades;
uniform float u_fade;
uniform float u_carry;
vec2 cover(vec2 uv, float zoom) {
  float aspect = u_res.x / u_res.y;
  float imageAspect = u_imageRes.x / u_imageRes.y;
  vec2 crop = aspect > imageAspect
    ? vec2(1.0, imageAspect / aspect)
    : vec2(aspect / imageAspect, 1.0);
  crop /= zoom;
  vec2 focus = vec2(0.5, 0.55);
  return clamp((uv - 0.5) * crop + 0.5 + (focus - 0.5) * (1.0 - crop), 0.0, 1.0);
}
float lightOf(sampler2D image, vec2 uv, vec2 grade) {
  vec3 c = texture2D(image, clamp(uv, 0.0, 1.0)).rgb;
  return pow(dot(c, vec3(0.299, 0.587, 0.114)), grade.x) * grade.y;
}
// A clip's light around uv, softened over r.
float softly(sampler2D image, vec2 uv, float r, vec2 grade) {
  float sum = lightOf(image, uv, grade) * 0.2;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    sum += lightOf(image, uv + vec2(cos(a), sin(a)) * r, grade) * 0.1;
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
  vec2 b = cover(uv, u_zoom.y);
  float lum;
  if (m >= 1.0) {
    lum = lightOf(u_to, b, u_grades.zw);
  } else {
    float passing = sin(3.14159 * m);
    // A slow current across the window, its way turning from place to place.
    float angle = fbm(p * 1.3 + vec2(1.7, u_time * 0.03)) * 9.0;
    vec2 current = vec2(cos(angle), sin(angle));
    vec2 a = cover(uv, u_zoom.x);
    // Each clip carried by the other's light: the old one pushed out of shape where the new one
    // is bright, the new one coming out of the old one's shapes.
    float newHere = softly(u_to, b, 0.02, u_grades.zw);
    float oldHere = softly(u_from, a, 0.02, u_grades.xy);
    float r = 0.01 * passing;
    float from = softly(u_from, a + current * newHere * u_carry * m, r, u_grades.xy);
    float to = softly(u_to, b - current * oldHere * u_carry * (1.0 - m), r, u_grades.zw);
    float fold = fbm(p * 2.0 + vec2(3.0, u_time * 0.04));
    float turn = mix(fold, 1.0 - to, 0.35);
    const float edge = 0.3;
    float k = smoothstep(turn - edge, turn + edge, m * (1.0 + 2.0 * edge) - edge);
    lum = mix(from, to, k) + passing * 0.12 * (1.0 - abs(2.0 * k - 1.0));
  }
  float tone = lum * u_fade;
  float light = silk(p * 1.1, u_time * 0.7);
  tone *= 1.0 + 0.14 * (smoothstep(0.25, 0.75, light) - 0.5) * 2.0;
  tone *= mix(0.32, 1.0, smoothstep(0.06, 0.44, v_uv.y));
  const float steps = 5.0;
  float q = floor(clamp(tone, 0.0, 1.0) * steps + bayer8(gl_FragCoord.xy)) / steps;
  gl_FragColor = vec4(palette(q * 0.86), 1.0);
}`;

/** How long a clip takes to become the next, in ms. */
const MORPH_MS = 2600;
/** How long the first clip takes to come up from night, in ms. */
const FADE_MS = 1200;
/** How much closer a clip comes while it plays, at most, and over how long, in ms. */
const CLOSER = 0.08;
const CLOSER_MS = 14_000;
/** How much further into the leaving clip the view goes as it passes. */
const THROUGH = 0.14;
/** How far each clip is carried by the other's light, midway, in the window's heights. */
const CARRY = 0.3;
const ease = (t: number): number => t * t * (3 - 2 * t);

/** A clip, ready to play, muted, round and round unless it plays `once`. */
const videoOf = (src: string, once: boolean): HTMLVideoElement => {
  const video = document.createElement("video");
  video.muted = true;
  video.loop = !once;
  video.playsInline = true;
  video.preload = "auto";
  video.src = src;
  return video;
};

/** Plays `video`; where the browser won't (saving power), its first frame stands instead. */
const play = async (video: HTMLVideoElement): Promise<void> => {
  try {
    await video.play();
  } catch {
    // Its first frame stands.
  }
};

/** A part's clip's grade, its gamma and gain: none (dark) for no part. */
const gradeOf = (scene: Scene | null): [number, number] =>
  scene === null ? [1, 0] : [clips[scene].gamma, clips[scene].gain];

/** The story's footage, drawn on `element`: `show` tells which part is told, `stop` lets it all go. */
const startPictures = (
  element: HTMLCanvasElement,
  still: boolean
): {
  show: (scene: Scene) => void;
  stop: () => void;
} | null => {
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
      gl.RGB,
      1,
      1,
      0,
      gl.RGB,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0])
    );
    for (const side of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) {
      gl.texParameteri(gl.TEXTURE_2D, side, gl.CLAMP_TO_EDGE);
    }
    for (const filter of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) {
      gl.texParameteri(gl.TEXTURE_2D, filter, gl.LINEAR);
    }
  }
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.uniform2f(at("u_imageRes"), clipWidth, clipHeight);
  gl.uniform1f(at("u_carry"), CARRY);
  const fromAt = at("u_from");
  const toAt = at("u_to");
  const morphAt = at("u_morph");
  const zoomAt = at("u_zoom");
  const gradeAt = at("u_grades");
  const fadeAt = at("u_fade");
  const resAt = at("u_res");
  const timeAt = at("u_time");
  const style = getComputedStyle(element);
  gl.uniform3fv(
    at("u_palette"),
    stops.flatMap((stop) => {
      const [r, g, b] = rgbaOf(style.getPropertyValue(stop).trim());
      return [r, g, b];
    })
  );
  // Every part's clip, loading from the start, so each is ready when its part comes.
  const videos = new Map<string, HTMLVideoElement>();
  for (const { src, once } of Object.values(clips)) {
    videos.set(src, videoOf(src, once));
  }
  const videoAt = (scene: Scene | null): HTMLVideoElement | undefined =>
    scene === null ? undefined : videos.get(clips[scene].src);
  // Standing still, the first clip is already up and every change already made.
  const begun = performance.now() - (still ? FADE_MS + MORPH_MS : 0);
  // The part in each slot, the one leaving and the one coming.
  const slots: (Scene | null)[] = [null, null];
  const slotAt = (unit: number): Scene | null => slots[unit] ?? null;
  // Which slot the coming clip is in, when it came and when the leaving one did.
  let to = 0;
  let toAtMs = begun;
  let fromAtMs = begun;
  let wanted: Scene | null = null;
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
  // The frame each clip in a slot is at, taken into its slot's texture once it has one.
  const take = (unit: number): void => {
    const video = videoAt(slotAt(unit));
    if (
      video === undefined ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      return;
    }
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
  };
  const draw = (now: number): void => {
    const morph = ease(Math.min(1, (now - toAtMs) / MORPH_MS));
    take(to);
    if (morph < 1) {
      take(1 - to);
    }
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
    gl.uniform4f(gradeAt, ...gradeOf(slotAt(1 - to)), ...gradeOf(slotAt(to)));
    gl.uniform1f(fadeAt, ease(Math.min(1, (now - begun) / FADE_MS)));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };
  // A part's clip into a slot, from its start; standing still, its still frame, drawn once there.
  const load = (unit: number, scene: Scene): void => {
    slots[unit] = scene;
    const video = videoAt(scene);
    if (video === undefined) {
      return;
    }
    if (still) {
      video.addEventListener(
        "seeked",
        () => {
          draw(performance.now());
        },
        { once: true }
      );
      video.currentTime = clips[scene].stillAt;
      return;
    }
    video.currentTime = 0;
    void play(video);
  };
  // Brings the footage to the part being told: a change, once the one under way is made, so
  // nothing snaps.
  const settle = (now: number): void => {
    if (wanted === null || wanted === slotAt(to)) {
      return;
    }
    if (slotAt(to) === null || still) {
      // The first clip comes up from night on its own, in both slots, so it stands whole.
      load(to, wanted);
      slots[1 - to] = wanted;
      toAtMs = begun - MORPH_MS;
      fromAtMs = toAtMs;
      return;
    }
    if (now - toAtMs < MORPH_MS) {
      return;
    }
    // The clip before the leaving one stops: only two play at once.
    const before = slotAt(1 - to);
    if (before !== slotAt(to)) {
      videoAt(before)?.pause();
    }
    to = 1 - to;
    fromAtMs = toAtMs;
    toAtMs = now;
    load(to, wanted);
  };
  const loop = (now: number): void => {
    frame = requestAnimationFrame(loop);
    if (now - last >= sceneFrameMs) {
      settle(now);
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
      wanted = scene;
      const now = performance.now();
      settle(now);
      if (still) {
        draw(now);
      }
    },
    stop: () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      for (const video of videos.values()) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
      // Let go of now only once the canvas has left the page: one still in it may be drawn on again.
      if (!element.isConnected) {
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
    },
  };
};

/** The window's footage of the story at `scene`; a still frame of each clip if `still`. */
export const PlanPictures = ({
  scene,
  still,
}: {
  scene: Scene;
  still: boolean;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pictures = useRef<ReturnType<typeof startPictures>>(null);
  const showing = useRef(scene);
  useEffect(() => {
    const element = canvas.current;
    const started = element === null ? null : startPictures(element, still);
    started?.show(showing.current);
    pictures.current = started;
    return () => {
      started?.stop();
      pictures.current = null;
    };
  }, [still]);
  useEffect(() => {
    showing.current = scene;
    pictures.current?.show(scene);
  }, [scene]);
  return (
    <canvas aria-hidden="true" ref={canvas} {...stylex.props(styles.canvas)} />
  );
};
