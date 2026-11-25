import { Button } from "@grasp-os/ui/components/button";
import { ArrowLeftIcon, Icon } from "@grasp-os/ui/lib/icons";
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
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

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
import { Sound, useBackWay, useEnterGoesOn } from "./calm-frame.tsx";
import { poseField } from "./field/engine.ts";
import { poses } from "./field/poses.ts";
import { PlanPictures } from "./plan-pictures.tsx";
import type { Scene } from "./plan-scenes.ts";
import { dateOf, planStart } from "./plan.ts";

// "Here's the plan", told as a story (as the first onboarding told it,
// `about-story.tsx` before a955fb8). Stephen tells the admin's own two
// weeks in one breath, one flowing narration with the plan's own days in
// it, and the whole window tells it with him in footage: it turns to
// night and becomes one of the Appearance page's scenes, dithered in the
// brand's greens by the same shader, and every part of the story is a
// stock clip of its own that turns into the next as he goes on
// (plan-pictures.tsx, plan-scenes.ts). Under it, on the picture's dark
// foot, each part streams in word by word as he says it. Once told, the
// last clip stays, his last words under it, and only then Continue fades
// in, where every step keeps it: at the foot, on the right.
//
// With his voice on, the story follows it; off, the pace of speech;
// paused, it holds. Under reduced motion, and coming back to the step,
// the last clip stands at once, still; it can be told again from
// there, and skipped while it is told. A screen reader hears each part
// whole, as it comes.

const styles = stylex.create({
  // The whole window, night, over the page and its bar and track.
  stage: {
    position: "fixed",
    inset: 0,
    zIndex: 10,
    isolation: "isolate",
    display: "grid",
    gridTemplateRows: "auto 1fr auto auto",
    justifyItems: "center",
    backgroundColor: colors.brandNight,
    color: colors.bodyForeground,
  },
  // The stage's own bar and foot, where the frame keeps them: his voice at the top, back and the
  // way on at the foot.
  bar: {
    justifySelf: "end",
    paddingBlock: space[4],
    paddingInline: { default: space[8], [media.maxSm]: space[4] },
  },
  foot: {
    width: "100%",
    display: "grid",
    gridTemplateColumns: "1fr auto",
    alignItems: "center",
    gap: space[3],
    minHeight: "5.5rem",
    paddingBlockEnd: { default: space[6], [media.maxSm]: space[4] },
    paddingInline: { default: space[8], [media.maxSm]: space[4] },
  },
  footStart: { display: "flex", alignItems: "center" },
  footEnd: {
    display: "flex",
    flexDirection: "row-reverse",
    alignItems: "center",
    justifySelf: "end",
    gap: space[3],
    whiteSpace: "nowrap",
  },
  // The words, on the picture's dark foot: room for three lines, so nothing moves.
  words: {
    display: "grid",
    alignContent: "end",
    width: "100%",
    maxWidth: "48rem",
    paddingInline: space[6],
    textAlign: "center",
    minHeight: {
      default: "calc(3 * var(--damsko-heading-lg-line))",
      [media.maxSm]: "calc(4 * var(--damsko-heading-md-line))",
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
    textAlign: "center",
    textWrap: "balance",
    textShadow: "0 0 24px var(--damsko-brand-night)",
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
  fresh: { color: colors.brandLime },
  quiet: { opacity: 0.7 },
  // Continue arriving once the story is told: slower than a step's, it is the story's last beat.
  arriving: { animationDuration: "900ms" },
});

/** Told once in this visit: coming back to the step, the story's last picture stands at once. */
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
    { scene: "you", text: t`Here’s a quick look at the next two weeks.` },
    {
      scene: "first",
      text: t`We kick off on ${first} with a small first group. They’ll get a link for a quick chat about what their day-to-day looks like, which tools they use, and where their time goes.`,
    },
    {
      scene: "everyone",
      text: t`Starting ${everyone}, the rest of the team follows. Everyone gets their own link and can do the chat whenever it suits them.`,
    },
    {
      scene: "close",
      text: t`We wrap up on ${close}, once we’ve heard from almost everyone.`,
    },
    {
      scene: "learned",
      text: t`I’ll pull everything together, and on ${findings} we’ll walk through the report: where work gets stuck and which processes make the most sense to tackle first.`,
    },
    {
      scene: "rest",
      text: t`Most of the time, it’s the small things that pile up—and end up making the biggest difference.`,
    },
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

/** The ways on, at the foot: Skip while the story is told; once it is, Continue and to be told again. */
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
  const ref = useEnterGoesOn();
  if (!shown) {
    return (
      <span {...stylex.props(styles.footEnd, styles.quiet)}>
        <Button onClick={skip} size="sm" variant="link">
          {t`Skip`}
        </Button>
      </span>
    );
  }
  return (
    <div ref={ref} {...stylex.props(styles.footEnd, fadeIn, styles.arriving)}>
      <Button
        onClick={() => {
          void onward();
        }}
        size="lg"
      >
        {t`Continue`}
      </Button>
      {reduce ? null : (
        <span {...stylex.props(styles.quiet)}>
          <Button onClick={again} size="sm" variant="link">
            {t`Tell me again`}
          </Button>
        </span>
      )}
    </div>
  );
};

/** Back a step, where the frame's track would have it. */
const Back = () => {
  const { t } = useLingui();
  const back = useBackWay();
  if (back === undefined) {
    return <span />;
  }
  return (
    <span {...stylex.props(styles.footStart)}>
      <Button
        aria-label={t`Back`}
        onClick={back}
        size="icon-sm"
        tooltip={t`Back`}
        variant="ghost"
      >
        <Icon icon={ArrowLeftIcon} />
      </Button>
    </span>
  );
};

/** The story's narration as it is told, and where it is in it. */
const useTelling = (today: string, shown: boolean) => {
  const parts = useParts(today);
  const narration = parts.map((part) => part.text).join(" ");
  const starts = startsOf(parts);
  const [began, setBegan] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  usePrepare(narration);
  const said = useNarrated(narration, began, over || shown);
  // The part being told: the last one that has begun (from its first word on), or the last once told.
  let at = shown ? parts.length - 1 : 0;
  for (const [index, start] of starts.entries()) {
    if (!shown && said > start) {
      at = index;
    }
  }
  const part = parts[at] ?? parts[0];
  return {
    narration,
    part,
    at,
    // Once told, all of it said and settled, none of it still fresh.
    partSaid: shown ? (part?.text.length ?? 0) + 20 : said - (starts[at] ?? 0),
    began,
    setBegan,
    setOver,
  };
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
  const [told, setTold] = useState(toldBefore);
  const shown = told || reduce;
  const { narration, part, at, partSaid, began, setBegan, setOver } =
    useTelling(today, shown);

  const finish = () => {
    toldBefore = true;
    stopSpeaking();
    poseField(poses.about);
    setTold(true);
  };
  const latest = useRef({ narration, finish, setBegan, setOver });
  useEffect(() => {
    latest.current = { narration, finish, setBegan, setOver };
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
        latest.current.setBegan(voiceClock());
        await say(latest.current.narration);
        if (left) {
          return;
        }
        latest.current.setOver(true);
        await hold(1200);
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

  const scene: Scene = part?.scene ?? "you";
  return createPortal(
    <section data-mode="dark" {...stylex.props(styles.stage, fadeIn)}>
      <PlanPictures scene={scene} still={reduce} />
      <div {...stylex.props(styles.bar)}>
        <Sound />
      </div>
      <span />
      <div {...stylex.props(styles.words)}>
        <h1 {...stylex.props(visuallyHidden)}>{t`Here’s the plan`}</h1>
        <Streamed
          key={`part-${String(at)}`}
          said={partSaid}
          text={part?.text ?? ""}
        />
        <span aria-live="polite" {...stylex.props(visuallyHidden)}>
          {began === null && !shown ? "" : part?.text}
        </span>
      </div>
      <footer {...stylex.props(styles.foot)}>
        <Back />
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
      </footer>
    </section>,
    document.body
  );
};
