// The footage of the plan's story (plan-story.tsx): a short stock clip for
// each part, which plan-pictures.tsx dithers into the brand's greens by the
// Appearance page's scene shader (chat/backdrop/shader.ts). Each clip is
// cut to a few seconds, made small and grey (only its light is used), and
// served from the web app's public/plan-story/. They are from Pexels, free
// to use and change (https://www.pexels.com/license/).

/** The parts of the story, in its order. */
export type Scene = "you" | "first" | "everyone" | "close" | "learned" | "rest";

/** A part's clip, and how its light is graded before it is dithered. */
export interface Clip {
  src: string;
  /** Its light is raised to this power: above 1 darkens its middle tones, so its lights stand out. */
  gamma: number;
  /** Then multiplied by this. */
  gain: number;
  /** Whether it plays once and stays on its last frame, rather than round and round. */
  once: boolean;
  /** The moment shown, in seconds, when nothing may move. */
  stillAt: number;
}

/** The clips' size, in their own pixels: all are cut to it. */
export const clipWidth = 960;
export const clipHeight = 540;

const clip = (
  name: string,
  gamma: number,
  gain: number,
  { once = false, stillAt = 2 }: { once?: boolean; stillAt?: number } = {}
): Clip => ({
  src: `/plan-story/${name}.mp4`,
  gamma,
  gain,
  once,
  stillAt,
});

/** Each part's clip. */
export const clips: Record<Scene, Clip> = {
  // A calendar's pages turned, and a day written in.
  you: clip("plan", 1.4, 0.9),
  // Someone in a headset, talking and laughing.
  first: clip("chat", 1.3, 1.05),
  // People at their desks, side by side.
  everyone: clip("office", 1.3, 1.05),
  // A city at night, its windows lit: its light raised, as it is dark.
  close: clip("city", 1.1, 1.35),
  // A chart on a screen, talked through.
  learned: clip("report", 1.4, 0.95),
  // A long row of dominoes, falling once and staying down: white on white, so its light is
  // lowered, or the window would be one wall of light.
  rest: clip("dominoes", 1.9, 0.85, { once: true, stillAt: 8 }),
};
