import { Button } from "@grasp-os/ui/components/button";
import { fadeIn, visuallyHidden } from "@grasp-os/ui/lib/styles";
import {
  colors,
  duration,
  font,
  media,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { readingTiming, saidBy, wordsOf } from "../voice/timing.ts";
import {
  hold,
  say,
  stopSpeaking,
  usePrepare,
  useSaid,
  useVoice,
  voiceClock,
} from "../voice/voice.ts";
import { CalmStep } from "./calm-frame.tsx";
import { poseField } from "./field/engine.ts";
import type { Pose } from "./field/engine.ts";
import { poses } from "./field/poses.ts";
import { PlanFlight } from "./plan-flight.tsx";
import type { Scene } from "./plan-flight.tsx";
import { dateOf, PlanBody, planDays, planStart } from "./plan.tsx";

// "Here's the plan", told as a story before it is shown (as the first
// onboarding told it, `about-story.tsx` before a955fb8). Stephen tells the
// admin's own two weeks in one breath, one flowing narration with the
// plan's own days in it, and the whole window tells it with him: his light
// behind the page moves to a new place for every part of the story (the
// field's pose), and over it the people of the campaign fly from figure to
// figure in the same grain (plan-flight.tsx). Each part of the narration
// streams in word by word as he says it, the part before it fading above.
// Once told, the plan stands summed up (plan.tsx), and only then Continue.
//
// With his voice on, the story follows it; off, the pace of speech;
// paused, it holds. Under reduced motion, and coming back to the step, the
// plan is shown at once; it can be told again from there, and skipped
// while it is told. A screen reader hears each part whole, as it comes.

const styles = stylex.create({
  stage: {
    display: "grid",
    placeItems: "center",
    minHeight: { default: "calc(100svh - 18rem)", [media.maxSm]: "60svh" },
  },
  story: {
    display: "grid",
    gap: space[4],
    justifyItems: "center",
    textAlign: "center",
    width: "100%",
    maxWidth: "36rem",
  },
  // The words: room for the part before and the part being told, so nothing moves.
  words: {
    display: "grid",
    alignContent: "end",
    gap: space[3],
    width: "100%",
    minHeight: {
      default: "calc(4 * var(--damsko-heading-lg-line) + 2rem)",
      [media.maxSm]: "calc(5 * var(--damsko-heading-md-line) + 2rem)",
    },
  },
  line: {
    margin: 0,
    color: colors.foreground,
    fontFamily: font.serif,
    fontWeight: font.weightNormal,
    fontSize: { default: font.headingLg, [media.maxSm]: font.headingMd },
    lineHeight: {
      default: font.headingLgLine,
      [media.maxSm]: font.headingMdLine,
    },
    letterSpacing: font.trackingTitle,
    textWrap: "balance",
  },
  // The part before, said: smaller and quiet, on its way out.
  before: {
    margin: 0,
    color: colors.mutedForeground,
    fontSize: { default: font.headingSm, [media.maxSm]: font.textBase },
    lineHeight: {
      default: font.headingSmLine,
      [media.maxSm]: font.textBaseLine,
    },
    opacity: 0.6,
    textWrap: "balance",
  },
  word: {
    display: "inline-block",
    whiteSpace: "pre",
    opacity: 0,
    filter: "blur(8px)",
    transform: "translateY(0.35em)",
    transitionProperty: "opacity, filter, transform, color",
    transitionDuration: "380ms, 380ms, 380ms, 1200ms",
    transitionTimingFunction: duration.ease,
  },
  said: { opacity: 1, filter: "blur(0)", transform: "none" },
  fresh: { color: colors.mintDeep },
  skip: { opacity: 0.7 },
});

/** Told once in this visit: coming back to the step, the plan is there summed up. */
let toldBefore = false;

const lessMotion = "(prefers-reduced-motion: reduce)";

const onMotionChange = (listener: () => void): (() => void) => {
  const query = window.matchMedia(lessMotion);
  query.addEventListener("change", listener);
  return () => {
    query.removeEventListener("change", listener);
  };
};

const useLessMotion = (): boolean =>
  useSyncExternalStore(
    onMotionChange,
    () => window.matchMedia(lessMotion).matches,
    () => false
  );

/** Where Stephen's light goes for each part of the story, the whole window his stage. */
const storyPoses: Record<Scene, Pose> = {
  you: {
    at: [0.5, 0.26],
    reach: [0.42, 0.4],
    seed: 7.9,
    tempo: 1,
    strength: 0.6,
  },
  first: {
    at: [0.5, 0.22],
    reach: [0.3, 0.3],
    seed: 8.4,
    tempo: 1.5,
    strength: 0.72,
  },
  everyone: {
    at: [0.5, 0.5],
    reach: [1.25, 1.05],
    seed: 9.1,
    tempo: 1.9,
    strength: 0.5,
  },
  close: {
    at: [0.5, 1],
    reach: [1.2, 0.42],
    seed: 10.2,
    tempo: 0.9,
    strength: 0.6,
  },
  learned: {
    at: [0.5, 1],
    reach: [0.75, 0.8],
    seed: 6.6,
    tempo: 1.3,
    strength: 0.7,
  },
  finding: {
    at: [0.5, 0.2],
    reach: [0.5, 0.36],
    seed: 5.3,
    tempo: 0.8,
    strength: 0.52,
  },
  rest: poses.about,
};

/** One part of the narration and the figure it is told over. */
interface Part {
  scene: Scene;
  text: string;
}

/** The narration, in the language the page is in, with the plan's own days. */
const useParts = (today: string): Part[] => {
  const { t, i18n } = useLingui();
  const start = planStart(today);
  const format = new Intl.DateTimeFormat(i18n.locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  const first = format.format(dateOf(start, "first"));
  const everyone = format.format(dateOf(start, "everyone"));
  const close = format.format(dateOf(start, "close"));
  const findings = format.format(dateOf(start, "findings"));
  return [
    { scene: "you", text: t`Here’s how the next two weeks go.` },
    {
      scene: "first",
      text: t`On ${first}, I start with the people who know the work best, and they show me where the time really goes.`,
    },
    {
      scene: "everyone",
      text: t`From ${everyone}, everyone else gets their own link, and talks to me whenever it suits them.`,
    },
    {
      scene: "close",
      text: t`By ${close}, I’ve heard the whole company, and the interviews close.`,
    },
    {
      scene: "learned",
      text: t`Then I read every conversation, and on ${findings} you get what I learned, team by team.`,
    },
    {
      scene: "finding",
      text: t`Like this: new people wait two to three days for a laptop from IT.`,
    },
    { scene: "rest", text: t`Small things like that add up. Let’s find them.` },
  ];
};

/** Where each part starts in the narration, joined with a space between. */
const startsOf = (parts: Part[]): number[] => {
  const starts: number[] = [];
  let at = 0;
  for (const part of parts) {
    starts.push(at);
    at += part.text.length + 1;
  }
  return starts;
};

/** How many characters of the narration are said by now: by his voice, or by the pace of speech when it is off. */
const useNarrated = (
  narration: string,
  began: number | null,
  over: boolean
): number => {
  const voice = useVoice();
  const said = useSaid(narration);
  const [now, setNow] = useState(voiceClock);
  const silent = !voice.on;
  const ticking = silent && began !== null && !over;
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      setNow(voiceClock());
      frame = requestAnimationFrame(tick);
    };
    if (ticking) {
      tick();
    }
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [ticking]);
  if (over) {
    return narration.length;
  }
  if (began === null) {
    return 0;
  }
  if (!silent) {
    return Math.max(said, 0);
  }
  return saidBy(readingTiming(narration), now - began);
};

/** A part streaming in, word by word as it is said: each word rises out of a blur, briefly in mint. */
const Streamed = ({ text, said }: { text: string; said: number }) => (
  <p aria-hidden="true" {...stylex.props(styles.line)}>
    {wordsOf(text).map(({ word, start, end }) => (
      <span
        key={start}
        {...stylex.props(
          styles.word,
          said > start && styles.said,
          said > start && said < end + 14 && styles.fresh
        )}
      >
        {word}
      </span>
    ))}
  </p>
);

export const PlanStory = ({
  today,
  onward,
}: {
  /** The day the plan counts from, as YYYY-MM-DD. */
  today: string;
  onward: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const reduce = useLessMotion();
  const parts = useParts(today);
  const narration = parts.map((part) => part.text).join(" ");
  const starts = startsOf(parts);
  const days = useMemo(() => planDays(planStart(today)), [today]);
  const words = useRef<HTMLDivElement>(null);
  const [began, setBegan] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const [told, setTold] = useState(toldBefore);
  // Told just now: the summary stands without Stephen saying it again.
  const [justTold, setJustTold] = useState(false);
  const shown = told || reduce;
  usePrepare(narration);

  const finish = () => {
    toldBefore = true;
    stopSpeaking();
    poseField(poses.about);
    setJustTold(true);
    setTold(true);
  };
  const latest = useRef({ narration, finish });
  useEffect(() => {
    latest.current = { narration, finish };
  });

  // The story: a breath, then the narration in one go, then a breath for it to land.
  useEffect(() => {
    let left = false;
    if (!shown) {
      void (async () => {
        await hold(700);
        if (left) {
          return;
        }
        setBegan(voiceClock());
        await say(latest.current.narration);
        if (left) {
          return;
        }
        setOver(true);
        await hold(1400);
        if (!left) {
          latest.current.finish();
        }
      })();
    }
    return () => {
      left = true;
    };
  }, [shown]);
  // Leaving the step, his voice stops with the story.
  useEffect(
    () => () => {
      stopSpeaking();
    },
    []
  );

  const said = useNarrated(narration, began, over);
  // The part being told: the last one that has begun (from its first word on).
  let at = 0;
  for (const [index, start] of starts.entries()) {
    if (said > start) {
      at = index;
    }
  }
  const part = parts[at] ?? parts[0];
  const scene = part?.scene ?? "you";
  useEffect(() => {
    if (!shown) {
      poseField(storyPoses[scene]);
    }
  }, [scene, shown]);

  if (shown) {
    return (
      <div {...stylex.props(justTold && fadeIn)}>
        <CalmStep
          also={
            reduce ? null : (
              <Button
                onClick={() => {
                  toldBefore = false;
                  setBegan(null);
                  setOver(false);
                  setJustTold(false);
                  setTold(false);
                }}
                size="lg"
                variant="link"
              >
                {t`Tell me again`}
              </Button>
            )
          }
          body={t`I talk with your team for one week. Then you get what I learned, team by team.`}
          end={
            <Button
              onClick={() => {
                void onward();
              }}
              size="lg"
            >
              {t`Continue`}
            </Button>
          }
          silent={justTold}
          title={t`Here’s the plan`}
        >
          <PlanBody today={today} />
        </CalmStep>
      </div>
    );
  }
  const before = parts[at - 1];
  const partSaid = said - (starts[at] ?? 0);
  return (
    <section {...stylex.props(styles.stage)}>
      <h1 {...stylex.props(visuallyHidden)}>{t`Here’s the plan`}</h1>
      <PlanFlight days={days} scene={scene} words={words} />
      <div {...stylex.props(styles.story)}>
        <div ref={words} {...stylex.props(styles.words)}>
          {before === undefined ? null : (
            <p
              aria-hidden="true"
              key={`before-${at}`}
              {...stylex.props(styles.before, fadeIn)}
            >
              {before.text}
            </p>
          )}
          <Streamed
            key={`part-${at}`}
            said={partSaid}
            text={part?.text ?? ""}
          />
          <span aria-live="polite" {...stylex.props(visuallyHidden)}>
            {began === null ? "" : part?.text}
          </span>
        </div>
        <span {...stylex.props(styles.skip)}>
          <Button onClick={finish} size="sm" variant="link">
            {t`Skip`}
          </Button>
        </span>
      </div>
    </section>
  );
};
