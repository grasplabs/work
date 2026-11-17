// How a voice moves, before it is drawn (voice-field.ts draws it, voice.tsx holds it). Raw values
// from a microphone are jumpy and dead by turns; a voice is not. Each value goes through four steps,
// in this order, at the display's rate:
//
// 1. A noise gate. The room's floor is followed (down at once, up slowly), and what stays near it
//    reads as rest, so hum and fans are a still line, not a twitch.
// 2. Auto-gain. The loudness of the last few seconds is followed (slowly up, slowly down), and the
//    value is read against it, so a quiet speaker and a loud one both sit about half way, and only
//    a voice raised above its own ordinary reaches the top.
// 3. An envelope: it follows a rise in about 35ms and a fall in about 250ms, as a syllable does:
//    a fast attack, a slower decay.
// 4. A spring: the drawn value is pulled to the envelope, a little past it on the way up (a lively
//    attack), never past it on the way down (the decay eases out, it never bounces).
//
// Module-level and free of React: the field reads it in its own frame loop, so 60 values a second
// cost no render.

/** One reading of the sound: the level, 0 to 1, and optionally its energy in bands, low to high. */
export interface VoiceReading {
  level: number;
  bands?: ArrayLike<number>;
}

/** The sound as it is drawn: the level, and the body (low), the voice (middle) and the hiss (high). */
export interface VoiceShape {
  level: number;
  low: number;
  mid: number;
  high: number;
  /** Where the sound's weight sits from low to high, 0 to 1: the light leans with it. */
  centroid: number;
}

/** A rise is followed in about this long, in seconds. */
const ATTACK = 0.035;
/** A fall is followed in about this long. */
const RELEASE = 0.25;
/** How long the loudest recent sound is remembered for auto-gain. */
const PEAK_MEMORY = 5;
/** The quietest a loudness reference may fall to, so silence is never blown up into noise. */
const PEAK_FLOOR = 0.06;
/** Where auto-gain starts, before it has heard anyone. */
const PEAK_START = 0.6;
/** How fast the loudness reference climbs to a louder voice, in seconds: slowly, so a raised voice
 * reads as raised before it becomes the new ordinary. */
const PEAK_RISE = 0.9;
/** Where ordinary speech sits once read against the reference: about half, so only a raised voice
 * reaches the top. */
const ORDINARY = 0.55;
/**
 * How fast the floor may rise, in seconds: slow enough that a held vowel is not taken for the room,
 * quick enough to follow the dips between syllables, so a steady talker still reads as syllables.
 */
const FLOOR_RISE = 1.4;
/** How fast it falls: at once, near enough. */
const FLOOR_FALL = 0.12;
/** How far over the floor a sound must be to count, as a share of the floor and a fixed margin. */
const GATE_SHARE = 1.8;
const GATE_MARGIN = 0.012;
/** The spring's speed, in radians a second: it reaches a rise in about 30ms. */
const SPRING = 62;
/** Its damping on the way up (under critical, so a small overshoot) and on the way down. */
const DAMP_UP = 0.58;
const DAMP_DOWN = 1.05;

const clamp = (value: number, low = 0, high = 1) =>
  Math.min(high, Math.max(low, value));

/** One value's way from raw to drawn: gate, gain, envelope, spring. */
export interface Follower {
  /** Takes the raw value and the seconds since the last one; gives the drawn value. */
  step: (raw: number, dt: number) => number;
  /** The envelope before the spring, for a check that plots both. */
  envelope: () => number;
  /** Back to rest at once. */
  reset: () => void;
}

/** A follower for one value. */
export const follower = (): Follower => {
  let floor = 0;
  // A first guess at the speaker's loudness, so the first syllable is not taken for the loudest.
  let peak = PEAK_START;
  let envelope = 0;
  let drawn = 0;
  let speed = 0;
  return {
    step: (raw, dt) => {
      const value = clamp(Number.isFinite(raw) ? raw : 0);
      const time = clamp(dt, 0, 0.1);
      // 1. The gate: the floor follows the quietest the room has been.
      floor +=
        (value - floor) *
        (1 - Math.exp(-time / (value < floor ? FLOOR_FALL : FLOOR_RISE)));
      const over = Math.max(0, value - floor * GATE_SHARE - GATE_MARGIN);
      // 2. Auto-gain: read against the loudest of the last few seconds.
      peak =
        over > peak
          ? peak + (over - peak) * (1 - Math.exp(-time / PEAK_RISE))
          : PEAK_FLOOR + (peak - PEAK_FLOOR) * Math.exp(-time / PEAK_MEMORY);
      const heard = clamp((ORDINARY * over) / Math.max(PEAK_FLOOR, peak));
      // 3. The envelope: fast up, slower down.
      envelope +=
        (heard - envelope) *
        (1 - Math.exp(-time / (heard > envelope ? ATTACK : RELEASE)));
      // 4. The spring, in two half-steps so a slow frame stays steady.
      const damping = envelope > drawn ? DAMP_UP : DAMP_DOWN;
      for (let half = 0; half < 2; half += 1) {
        const h = time / 2;
        speed +=
          (SPRING * SPRING * (envelope - drawn) -
            2 * damping * SPRING * speed) *
          h;
        drawn += speed * h;
      }
      // On the way down it never passes below the envelope's own fall.
      if (drawn < 0) {
        drawn = 0;
        speed = 0;
      }
      return drawn;
    },
    envelope: () => envelope,
    reset: () => {
      envelope = 0;
      drawn = 0;
      speed = 0;
    },
  };
};

/** How many bands a microphone or a source gives, at most, and how they group into low, mid, high. */
const groups = (count: number) => {
  const third = Math.max(1, Math.round(count / 3));
  return { lowEnd: third, midEnd: Math.min(count, third * 2) };
};

const mean = (bands: ArrayLike<number>, from: number, to: number) => {
  let sum = 0;
  for (let index = from; index < to; index += 1) {
    sum += bands[index] ?? 0;
  }
  return to > from ? sum / (to - from) : 0;
};

/** The whole sound's way from raw to drawn: the level and three groups of bands. */
export interface Shaper {
  step: (reading: VoiceReading | undefined, dt: number) => VoiceShape;
  /** The level's envelope before the spring. */
  envelope: () => number;
  reset: () => void;
}

/** A shaper: the level and the bands each through their own follower. */
export const shaper = (): Shaper => {
  const level = follower();
  const low = follower();
  const mid = follower();
  const high = follower();
  let centroid = 0.5;
  return {
    step: (reading, dt) => {
      const raw = reading?.level ?? 0;
      const bands = reading?.bands;
      const drawnLevel = level.step(raw, dt);
      // Without bands, the level stands for all three, the body a little behind the voice.
      if (bands === undefined || bands.length === 0) {
        return {
          level: drawnLevel,
          low: low.step(raw, dt),
          mid: mid.step(raw, dt),
          high: high.step(raw * 0.4, dt),
          centroid,
        };
      }
      const { lowEnd, midEnd } = groups(bands.length);
      const lows = mean(bands, 0, lowEnd);
      const mids = mean(bands, lowEnd, midEnd);
      const highs = mean(bands, midEnd, bands.length);
      const total = lows + mids + highs;
      // The centroid moves slowly, so the lean is a drift, never a flicker.
      const target = total > 0.02 ? (mids * 0.5 + highs) / total : 0.5;
      centroid +=
        (target - centroid) * (1 - Math.exp(-clamp(dt, 0, 0.1) / 0.18));
      return {
        level: drawnLevel,
        low: low.step(lows, dt),
        mid: mid.step(mids, dt),
        high: high.step(highs, dt),
        centroid,
      };
    },
    envelope: () => level.envelope(),
    reset: () => {
      level.reset();
      low.reset();
      mid.reset();
      high.reset();
      centroid = 0.5;
    },
  };
};
