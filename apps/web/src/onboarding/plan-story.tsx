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
import { StepEnd } from "./calm-frame.tsx";
import { poseField } from "./field/engine.ts";
import { poses } from "./field/poses.ts";
import { PlanDemo } from "./plan-demo.tsx";
import type { Scene } from "./plan-demo.tsx";
import { dateOf, planDateFormat, planStart } from "./plan.ts";
import type { Moment } from "./plan.ts";

// "Here's the plan", told as a story before it is shown (as the first
// onboarding told it, `about-story.tsx` before a955fb8). Stephen tells the
// admin's own two weeks in one breath, one flowing narration with the
// plan's own days in it, and while he does the admin watches them happen,
// sped up (plan-demo.tsx): the plan's days along a rail, one interview
// with someone who knows the work, then the whole company talking until
// the interviews close, and the report they get filling in team by team,
// the finding he names lifting out of the interview's own words. His
// words stream in above it as he says them. Once told, the last scene
// stays as it is, the plan's summary, and only then Continue fades in.
//
// With his voice on, the story follows it; off, the pace of speech;
// paused, it holds. Under reduced motion, and coming back to the step, the
// plan is shown at once; it can be told again from there, and skipped
// while it is told. A screen reader hears each part whole, as it comes.

const styles = stylex.create({
  // The story, wider than the step's column: centred on it, out to the window's sides.
  stage: {
    display: "grid",
    gap: space[6],
    justifyItems: "center",
    width: "min(62rem, calc(100vw - 2rem))",
    marginInline: "calc((100% - min(62rem, calc(100vw - 2rem))) / 2)",
    paddingTop: space[4],
  },
  // His words: room for two lines, so nothing below them moves.
  words: {
    display: "grid",
    alignContent: "end",
    width: "100%",
    maxWidth: "44rem",
    minHeight: {
      default: "calc(2 * var(--damsko-heading-md-line))",
      [media.maxSm]: "calc(4 * var(--damsko-heading-sm-line))",
    },
  },
  line: {
    margin: 0,
    color: colors.foreground,
    fontFamily: font.serif,
    fontWeight: font.weightNormal,
    fontSize: { default: font.headingMd, [media.maxSm]: font.headingSm },
    lineHeight: {
      default: font.headingMdLine,
      [media.maxSm]: font.headingSmLine,
    },
    letterSpacing: font.trackingTitle,
    textAlign: "center",
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

/** Told once in this visit: coming back to the step, the story's last scene stands at once. */
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
      text: t`Then I read every conversation, and on ${findings} you get what I learned, theme by theme.`,
    },
    {
      scene: "finding",
      text: t`Like this: most people lose the first hours of their day to email.`,
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

/** His words over the story: the part being told streaming in, or the step's title once it is told. */
const Caption = ({
  shown,
  began,
  at,
  text,
  said,
  narration,
}: {
  shown: boolean;
  began: boolean;
  at: number;
  text: string;
  said: number;
  narration: string;
}) => {
  const { t } = useLingui();
  // What a screen reader hears: each part whole as it comes, or the whole story once told.
  let heard = began ? text : "";
  if (shown) {
    heard = narration;
  }
  return (
    <div {...stylex.props(styles.words)}>
      {shown ? (
        <h1 {...stylex.props(styles.line, fadeIn)}>{t`Here’s the plan`}</h1>
      ) : (
        <>
          <h1 {...stylex.props(visuallyHidden)}>{t`Here’s the plan`}</h1>
          <Streamed key={`part-${String(at)}`} said={said} text={text} />
        </>
      )}
      <span aria-live="polite" {...stylex.props(visuallyHidden)}>
        {heard}
      </span>
    </div>
  );
};

/** The ways on: Skip while the story is told; once it is, Continue and to be told again. */
const Ways = ({
  shown,
  reduce,
  onward,
  skip,
  again,
}: {
  shown: boolean;
  reduce: boolean;
  onward: () => Promise<void>;
  skip: () => void;
  again: () => void;
}) => {
  const { t } = useLingui();
  if (!shown) {
    return (
      <span {...stylex.props(styles.skip)}>
        <Button onClick={skip} size="sm" variant="link">
          {t`Skip`}
        </Button>
      </span>
    );
  }
  return (
    <>
      <StepEnd
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
      />
      {reduce ? null : (
        <span {...stylex.props(styles.skip)}>
          <Button onClick={again} size="sm" variant="link">
            {t`Tell me again`}
          </Button>
        </span>
      )}
    </>
  );
};

export const PlanStory = ({
  today,
  onward,
}: {
  /** The day the plan counts from, as YYYY-MM-DD. */
  today: string;
  onward: () => Promise<void>;
}) => {
  const reduce = useLessMotion();
  const parts = useParts(today);
  const narration = parts.map((part) => part.text).join(" ");
  const starts = startsOf(parts);
  const { i18n } = useLingui();
  const dates = useMemo(() => {
    const start = planStart(today);
    const format = planDateFormat(i18n.locale);
    const on = (moment: Moment): string => format.format(dateOf(start, moment));
    return {
      first: on("first"),
      everyone: on("everyone"),
      close: on("close"),
      findings: on("findings"),
    };
  }, [today, i18n.locale]);
  const [began, setBegan] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const [told, setTold] = useState(toldBefore);
  const shown = told || reduce;
  usePrepare(narration);

  const finish = () => {
    toldBefore = true;
    stopSpeaking();
    poseField(poses.about);
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
        await hold(900);
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
  const scene: Scene = part?.scene ?? "you";

  const partSaid = said - (starts[at] ?? 0);
  const progress = Math.min(
    1,
    Math.max(0, partSaid / Math.max(1, part?.text.length ?? 1))
  );
  // Told, or not to be told: the story's last scene stands, and the way on fades in under it.
  const last = parts.at(-1);
  return (
    <section {...stylex.props(styles.stage, fadeIn)}>
      <Caption
        at={at}
        began={began !== null}
        narration={narration}
        said={partSaid}
        shown={shown}
        text={part?.text ?? ""}
      />
      <PlanDemo
        dates={dates}
        progress={shown ? 1 : progress}
        scene={shown ? (last?.scene ?? "rest") : scene}
      />
      <Ways
        again={() => {
          toldBefore = false;
          setBegan(null);
          setOver(false);
          setTold(false);
        }}
        onward={onward}
        reduce={reduce}
        shown={shown}
        skip={finish}
      />
    </section>
  );
};
