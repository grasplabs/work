import { Button } from "@grasp-os/ui/components/button";
import { Text } from "@grasp-os/ui/components/text";
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
import { PlanFlight } from "./plan-flight.tsx";
import type { Scene } from "./plan-flight.tsx";
import type { after } from "./plan.tsx";
import {
  dateOf,
  PlanBody,
  planDateFormat,
  planDays,
  planStart,
} from "./plan.tsx";

// "Here's the plan", told as a small story before it is shown (as the
// first onboarding told it, `about-story.tsx` before a955fb8): Stephen
// walks the admin through their own two weeks a line at a time, each line
// streaming in word by word as he says it, its day over it, while the
// picture above flies from one figure to the next (plan-flight.tsx): you
// and him, the few who know the work best, the whole company, the days
// they talk on, what he learned team by team, and one finding. Then the
// plan stands summed up as before (plan.tsx): the drawing, the rows with
// their days, an example of a finding. The days are the plan's own.
//
// Continue is there all along, and so is a way to the plan at once. With
// his voice on the words follow it; off, the pace of speech; paused, the
// story holds. Under reduced motion, and coming back to the step, the plan
// is shown at once, summed up; it can be told again from there. A screen
// reader hears each line whole, with its day, as it comes.

const styles = stylex.create({
  stage: {
    display: "grid",
    gap: space[5],
    justifyItems: "center",
    textAlign: "center",
  },
  caption: {
    display: "grid",
    gap: space[2],
    justifyItems: "center",
    maxWidth: "34rem",
    minHeight: {
      default: "calc(2 * var(--damsko-heading-md-line) + 2rem)",
      [media.maxSm]: "calc(3 * var(--damsko-heading-sm-line) + 2rem)",
    },
  },
  when: {
    fontVariantNumeric: "tabular-nums",
    letterSpacing: font.trackingUi,
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
    textWrap: "balance",
  },
  // A word not said yet: there, so the line never moves, but unseen.
  word: {
    display: "inline-block",
    whiteSpace: "pre",
    opacity: 0,
    filter: "blur(6px)",
    transform: "translateY(0.3em)",
    transitionProperty: "opacity, filter, transform, color",
    transitionDuration: "420ms, 420ms, 420ms, 900ms",
    transitionTimingFunction: duration.ease,
  },
  // Said: in place, and for a moment in the brand's deep mint, as Stephen's words light up elsewhere.
  said: { opacity: 1, filter: "blur(0)", transform: "none" },
  fresh: { color: colors.mintDeep },
  // The story's beats as the brand's pixels: told, the one on now, and still to come.
  beats: { display: "flex", gap: "4px" },
  beat: {
    width: "6px",
    height: "6px",
    backgroundColor: colors.border,
    transitionProperty: "background-color",
    transitionDuration: duration.ui,
  },
  beatTold: { backgroundColor: colors.foreground },
  beatNow: { backgroundColor: colors.mintDeep },
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

/** A line of the story: its figure, its day, and what Stephen says. */
interface Beat {
  scene: Scene;
  when: string;
  line: string;
}

/** The picture flies a moment before the words come, in ms. */
const leadMs = 650;

/** A breath after a line before the next; longer after the last, to let it land. */
const breathMs = 900;
const lastBreathMs = 2200;

/** What the story tells the page as it goes. */
interface Telling {
  beat: (at: number) => void;
  said: () => void;
  told: () => void;
}

/**
 * Tells the story from its first line to its last, each line said (or
 * given its time to say) a moment after its figure starts to fly. It waits
 * for Stephen to finish the step's own title first. Read afresh at every
 * turn, so a change of language goes on in the new one.
 */
type Now = () => { beats: Beat[]; on: Telling; speaking: boolean };

/** Waits for Stephen to finish what he is saying (the step's title), on the voice's clock. */
const quiet = async (now: Now, left: () => boolean): Promise<void> => {
  await hold(120);
  if (!left() && now().speaking) {
    await quiet(now, left);
  }
};

/** Tells the story from line `at` on, until it is told or the step is left. */
const tellFrom = async (
  now: Now,
  left: () => boolean,
  at: number
): Promise<void> => {
  const { beats, on } = now();
  if (at >= beats.length) {
    on.told();
    return;
  }
  on.beat(at);
  await hold(leadMs);
  if (left()) {
    return;
  }
  await say(now().beats[at]?.line ?? "");
  if (left()) {
    return;
  }
  now().on.said();
  await hold(at === beats.length - 1 ? lastBreathMs : breathMs);
  if (!left()) {
    await tellFrom(now, left, at + 1);
  }
};

/**
 * Tells the story from its first line to its last, each line said (or
 * given its time to say) a moment after its figure starts to fly. It waits
 * for Stephen to finish the step's own title first. Read afresh at every
 * turn, so a change of language goes on in the new one.
 */
const tell = async (now: Now, left: () => boolean): Promise<void> => {
  await hold(280);
  await quiet(now, left);
  if (!left()) {
    await tellFrom(now, left, 0);
  }
};

/** How many characters of the line are said by now: by his voice, or by the pace of speech when it is off. */
const useStreamed = (line: string, began: number, done: boolean): number => {
  const voice = useVoice();
  const said = useSaid(line);
  const [now, setNow] = useState(began);
  const silent = !voice.on;
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      setNow(voiceClock());
      frame = requestAnimationFrame(tick);
    };
    if (silent && !done) {
      tick();
    }
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [silent, done]);
  if (done) {
    return line.length;
  }
  if (!silent) {
    return Math.max(said, 0);
  }
  return saidBy(readingTiming(line), now - began - leadMs / 1000);
};

/** A line streaming in, word by word as it is said: each word rises out of a blur, briefly in mint. */
const Streamed = ({ line, said }: { line: string; said: number }) => (
  <p aria-hidden="true" {...stylex.props(styles.line)}>
    {wordsOf(line).map(({ word, start, end }) => (
      <span
        key={start}
        {...stylex.props(
          styles.word,
          said > start && styles.said,
          said > start && said < end + 12 && styles.fresh
        )}
      >
        {word}
      </span>
    ))}
  </p>
);

/** The story's beats as pixels under it. */
const Beats = ({ count, at }: { count: number; at: number }) => (
  <div aria-hidden="true" {...stylex.props(styles.beats)}>
    {Array.from({ length: count }, (_, index) => (
      <span
        key={index}
        {...stylex.props(
          styles.beat,
          index < at && styles.beatTold,
          index === at && styles.beatNow
        )}
      />
    ))}
  </div>
);

/** A line fetched as the story opens, so nothing waits on the voice later. */
const Prepared = ({ text }: { text: string }) => {
  usePrepare(text);
  return null;
};

/** The story's lines, in the language the page is in, with the plan's own days. */
const useBeats = (today: string): Beat[] => {
  const { t, i18n } = useLingui();
  const start = planStart(today);
  const format = planDateFormat(i18n.locale);
  const on = (moment: keyof typeof after) =>
    format.format(dateOf(start, moment));
  return [
    {
      scene: "today",
      when: t`Today`,
      line: t`Right now it’s just you and me, getting ready.`,
    },
    {
      scene: "first",
      when: on("first"),
      line: t`First I talk with the people who know the work best.`,
    },
    {
      scene: "everyone",
      when: on("everyone"),
      line: t`Then everyone else gets their own link, and we talk when it suits them.`,
    },
    {
      scene: "close",
      when: on("close"),
      line: t`One week in, the interviews close.`,
    },
    {
      scene: "learned",
      when: on("findings"),
      line: t`I read every conversation, and you get what I learned, team by team.`,
    },
    {
      scene: "finding",
      when: t`A finding`,
      line: t`It reads like this: new people wait two to three days for a laptop from IT.`,
    },
  ];
};

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
  const voice = useVoice();
  const beats = useBeats(today);
  const days = useMemo(() => planDays(planStart(today)), [today]);
  const [at, setAt] = useState(0);
  const [done, setDone] = useState(false);
  const [began, setBegan] = useState(voiceClock);
  const [told, setTold] = useState(toldBefore);
  const shown = told || reduce;

  const finish = () => {
    toldBefore = true;
    stopSpeaking();
    // The story gives way to the plan, which fades in and draws its days.
    setTold(true);
  };

  const latest = useRef<ReturnType<Now>>({
    beats,
    speaking: voice.line !== null,
    on: {
      beat: () => {
        // Not yet told.
      },
      said: () => {
        // Not yet told.
      },
      told: () => {
        // Not yet told.
      },
    },
  });
  useEffect(() => {
    latest.current = {
      beats,
      speaking: voice.line !== null,
      on: {
        beat: (next) => {
          setAt(next);
          setDone(false);
          setBegan(voiceClock());
        },
        said: () => {
          setDone(true);
        },
        told: finish,
      },
    };
  });
  useEffect(() => {
    let left = false;
    if (!shown) {
      void tell(
        () => latest.current,
        () => left
      );
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

  const beat = beats[Math.min(at, beats.length - 1)] ?? beats[0];
  const line = beat?.line ?? "";
  const said = useStreamed(line, began, done || shown);

  const end = (
    <Button
      onClick={() => {
        void onward();
      }}
      size="lg"
    >
      {t`Continue`}
    </Button>
  );

  if (shown) {
    return (
      <CalmStep
        also={
          reduce ? null : (
            <Button
              onClick={() => {
                toldBefore = false;
                setAt(0);
                setDone(false);
                setBegan(voiceClock());
                setTold(false);
              }}
              size="lg"
              variant="link"
            >
              {t`Walk me through it again`}
            </Button>
          )
        }
        body={t`I talk with your team for one week. Then you get what I learned, team by team.`}
        end={end}
        title={t`Here’s the plan`}
      >
        <div {...stylex.props(fadeIn)}>
          <PlanBody today={today} />
        </div>
      </CalmStep>
    );
  }
  return (
    <CalmStep
      also={
        <Button onClick={finish} size="lg" variant="link">
          {t`Show the whole plan`}
        </Button>
      }
      body={t`Let me walk you through the next two weeks.`}
      end={end}
      title={t`Here’s the plan`}
    >
      {beats.map((each) => (
        <Prepared key={each.line} text={each.line} />
      ))}
      <div {...stylex.props(styles.stage)}>
        <PlanFlight days={days} scene={beat?.scene ?? "today"} />
        <div aria-live="polite" {...stylex.props(styles.caption)}>
          <span aria-hidden="true" key={`when-${at}`} {...stylex.props(fadeIn)}>
            <Text as="span" color="muted" size="sm">
              <span {...stylex.props(styles.when)}>{beat?.when}</span>
            </Text>
          </span>
          <Streamed key={`line-${at}`} line={line} said={said} />
          <span {...stylex.props(visuallyHidden)}>
            {beat === undefined ? "" : `${beat.when}: ${beat.line}`}
          </span>
        </div>
        <Beats at={at} count={beats.length} />
      </div>
    </CalmStep>
  );
};
