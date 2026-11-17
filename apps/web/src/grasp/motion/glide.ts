// One line that moves from one item to another: the line under the chosen tab (Tabs, TabsNav, the
// docs' Preview and Code). It glides, and its width changes as it goes: the leading edge sets off
// first and reaches the new item early, the trailing edge follows, so the line stretches toward
// the target and then settles to the new width. It always starts from where it stands now, so a
// fast series of presses never queues: it turns towards the latest. Within duration-ui on the
// system's ease-out; under reduced motion or forced colours it does not move at all.
//
// The line is absolutely placed in the same box as the items, by `left` and `width` in px (an
// item's offsetLeft and offsetWidth), so its place and theirs are read the same way.
import { ms } from "../tokens/tokens.values";

/** A place along the row: from the left edge, and how wide. */
export interface Span {
  x: number;
  w: number;
}

/** Where an item stands, as the line measures it. */
export const spanOf = (item: HTMLElement): Span => ({
  x: item.offsetLeft,
  w: item.offsetWidth,
});

/** A length in px, as getComputedStyle gives it ("12.5px"). */
const px = (value: string) => Number(value.replace("px", "")) || 0;

/** Where the line stands now, mid-glide too. */
const standing = (line: HTMLElement): Span => {
  const style = getComputedStyle(line);
  return { x: px(style.left), w: px(style.width) };
};

const still = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
  window.matchMedia("(forced-colors: active)").matches;

/** The system's ease-out, x from 0 to 1, as the tokens' curve leans. */
const easeOut = (x: number) => 1 - (1 - x) ** 3;
const clamp = (x: number) => Math.min(1, Math.max(0, x));

// The leading edge travels in the first 70% of the time, the trailing one in the last 80%.
const LEAD = 0.7;
const TRAIL = 0.2;
const FRAMES = 16;

/** The keyframes from one span to another: the edges eased apart, so the line stretches and settles. */
const framesOf = (from: Span, to: Span): Keyframe[] => {
  const right = to.x + to.w >= from.x + from.w;
  const frames: Keyframe[] = [];
  for (let step = 0; step <= FRAMES; step += 1) {
    const t = step / FRAMES;
    const lead = easeOut(clamp(t / LEAD));
    const trail = easeOut(clamp((t - TRAIL) / (1 - TRAIL)));
    const start = from.x + (to.x - from.x) * (right ? trail : lead);
    const end =
      from.x +
      from.w +
      (to.x + to.w - from.x - from.w) * (right ? lead : trail);
    frames.push({
      left: `${start}px`,
      width: `${Math.max(0, end - start)}px`,
      offset: t,
    });
  }
  return frames;
};

/**
 * Moves the line to `to`, from where it stands, and leaves it there. Returns the motion, or null when
 * it is simply put in place (reduced motion, forced colours, or nothing to travel from).
 */
export const glide = (line: HTMLElement, to: Span): Animation | null => {
  const from = standing(line);
  for (const running of line.getAnimations()) {
    running.cancel();
  }
  line.style.setProperty("left", `${to.x}px`);
  line.style.setProperty("width", `${to.w}px`);
  if (still() || from.w === 0 || (from.x === to.x && from.w === to.w)) {
    return null;
  }
  return line.animate(framesOf(from, to), {
    duration: ms.durationUi,
    easing: "linear",
  });
};
